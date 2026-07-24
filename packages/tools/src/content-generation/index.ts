/**
 * `contentGeneration` capability — generate media (images and video today; audio
 * to come), with an optional `storage` param that persists each output to Sapiom
 * file storage so you get a durable `fileId` back inline.
 *
 *   import { contentGeneration } from "@sapiom/tools";        // ambient auth
 *   const out = await contentGeneration.images.create({
 *     prompt: "a red bicycle",
 *     storage: { visibility: "private" },                     // optional — persist outputs
 *   });
 *   out.images[0].url;       // hosted URL of the generated image
 *   out.images[0].fileId;    // present when `storage` was passed → use with fileStorage
 *
 * Or via an explicit client: `createClient({ apiKey }).contentGeneration.images.create(...)`.
 *
 * `video.launch` is the dispatchable surface: it submits the job and returns a
 * handle immediately. Pass the handle to `pauseUntilSignal(handle, { resumeStep })`
 * to suspend the workflow step until the video is ready, or call `handle.wait()`
 * inline to block until done — same as `video.create` but with the ability to
 * pause a running workflow.
 */
import {
  Transport,
  capabilityCall,
  defaultTransport,
  resolveCoreBaseUrl,
} from "../_client/index.js";
import { ContentGenerationHttpError } from "./errors.js";
import type { DispatchHandle } from "../dispatch.js";

export { ContentGenerationHttpError };

/**
 * Capability-stable signal a video launch fires when the video reaches a terminal
 * state (ready OR failed — it carries the result either way, the resumed step
 * branches). A workflow step paused on a launch handle resumes on this; it is the
 * value carried in the handle's `dispatch.resultSignal`.
 */
export const VIDEO_RESULT_SIGNAL = "contentGeneration.video.result";

// ----- Types -----

export interface StorageOptions {
  /**
   * Visibility of the persisted output.
   * - "private" — download requires the owning tenant (default).
   * - "public"  — download URL is reachable by any tenant.
   */
  visibility?: "private" | "public";
}

export interface ImageCreateInput {
  /** Text prompt describing the image to generate. */
  prompt: string;
  /** Number of images to generate. */
  numImages?: number;
  /**
   * Optional model selector. Defaults to a fast image model; most callers omit it.
   * (Model identifiers are an advanced, evolving surface.)
   */
  model?: string;
  /**
   * Optional: persist each generated output to Sapiom file storage. When set, every
   * item in `images` comes back annotated with `fileId` (or `storageError` if
   * persisting that one failed).
   */
  storage?: StorageOptions;
  /**
   * Advanced: extra model-specific parameters, forwarded verbatim
   * (e.g. `image_size`, `seed`, `guidance_scale`).
   */
  params?: Record<string, unknown>;
}

export interface GeneratedImage {
  /**
   * Provider-hosted URL of the generated image. May be short-lived and unauthenticated;
   * when you requested `storage`, prefer `downloadUrl` (ready to use) or `fileId` (durable).
   */
  url: string;
  /** MIME type, when reported. */
  contentType?: string;
  width?: number;
  height?: number;
  /**
   * Present when `storage` was requested and this output was persisted. The durable
   * reference — re-fetch a fresh download URL any time via `fileStorage.getDownloadUrl(fileId)`.
   */
  fileId?: string;
  /**
   * Present when `storage` was requested and this output was persisted: a ready-to-use,
   * short-lived signed download URL for the stored file. Convenience only — it expires, so
   * for anything durable keep `fileId` and re-fetch via `fileStorage.getDownloadUrl(fileId)`.
   */
  downloadUrl?: string;
  /** ISO timestamp when `downloadUrl` expires (~15 min out). Absent whenever `downloadUrl` is. */
  downloadUrlExpiresAt?: string;
  /**
   * Present when `storage` was requested but persisting THIS output failed
   * (best-effort: other images in the same response may still carry `fileId`).
   */
  storageError?: string;
}

export interface ImageGenerationResult {
  /** Generated images. */
  images?: GeneratedImage[];
  /** Additional model-specific fields (e.g. `seed`, `timings`), returned as-is. */
  [key: string]: unknown;
}

// ----- Internal response shapes (the router's normalized image DTO) -----
//
// The router returns the camelCase normalized shape (the fal adapter maps fal's
// snake_case wire fields away), with `servedBy` stripped at the public boundary —
// so this mirrors the public `GeneratedImage` and the mapper is a defensive pass,
// not a snake→camel translation.

interface RawImage {
  url: string;
  contentType?: string;
  width?: number;
  height?: number;
  fileId?: string;
  downloadUrl?: string;
  downloadUrlExpiresAt?: string;
  storageError?: string;
}

interface RawImageResult {
  images?: RawImage[];
  [key: string]: unknown;
}

function mapImage(raw: RawImage): GeneratedImage {
  return {
    url: raw.url,
    ...(raw.contentType !== undefined && { contentType: raw.contentType }),
    ...(raw.width !== undefined && { width: raw.width }),
    ...(raw.height !== undefined && { height: raw.height }),
    ...(raw.fileId !== undefined && { fileId: raw.fileId }),
    ...(raw.downloadUrl !== undefined && { downloadUrl: raw.downloadUrl }),
    ...(raw.downloadUrlExpiresAt !== undefined && {
      downloadUrlExpiresAt: raw.downloadUrlExpiresAt,
    }),
    ...(raw.storageError !== undefined && { storageError: raw.storageError }),
  };
}

function mapResult(raw: RawImageResult): ImageGenerationResult {
  const { images, ...rest } = raw;
  return images === undefined
    ? { ...rest }
    : { ...rest, images: images.map(mapImage) };
}

// ----- Capability operations -----

/**
 * Guard a prompt value: throw a clear error before a paid job is submitted when
 * the prompt is absent, empty, or not a string. A JS caller passing `null`,
 * `undefined`, or `""` gets an immediate, actionable error instead of a silent
 * paid request with a blank prompt.
 */
function assertPrompt(prompt: unknown): void {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ContentGenerationHttpError(
      "prompt is required and must be a non-empty string",
      400,
      { error: "invalid_prompt" },
    );
  }
}

/**
 * When launched from inside a Sapiom workflow step, the engine injects an opaque
 * per-execution resume token into the transport. Forwarding it as a header — NOT
 * a body field, so author-supplied request fields can't clobber it — lets the
 * service call back into the engine to resume the paused workflow when the job
 * finishes. Absent outside a workflow → no header, no behavior change.
 */
function workflowResumeHeaders(
  token: string | undefined,
): Record<string, string> {
  return token ? { "x-sapiom-workflow-token": token } : {};
}

/**
 * Generate one or more images from a prompt. Pass `storage` to persist each output
 * (the returned images then carry `fileId`). Failed requests throw
 * {@link ContentGenerationHttpError}.
 *
 * Routed (SAP-1116): goes through the shared {@link capabilityCall} seam to
 * `POST /v1/capabilities/content.generation.images` on the single Core base URL.
 * `model` is now a request-body field the router's adapter turns into the provider
 * path (and defaults when omitted) — the SDK no longer builds the `/run/<model>`
 * URL itself.
 */
export async function createImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<ImageGenerationResult> {
  assertPrompt(input.prompt);

  // Map to the router's camelCase `ImageCreateRequest`. `params` rides as a nested
  // field (not spread) so the adapter forwards it verbatim. `!= null` keeps a JS
  // caller's explicit null off the wire; `storage` uses a truthy check so
  // `storage: null` is "no storage" rather than a null field.
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  if (input.numImages !== undefined) body.numImages = input.numImages;
  if (input.storage) body.storage = input.storage;
  if (input.params != null) body.params = input.params;

  const raw = await capabilityCall<RawImageResult>(
    "content.generation.images",
    body,
    {
      transport,
      baseUrl,
      makeError: (message, status, errorBody) =>
        new ContentGenerationHttpError(message, status, errorBody),
      errorPrefix: "Failed to generate image",
    },
  );
  return mapResult(raw);
}

/**
 * The `images` sub-namespace, so `contentGeneration.images.create(...)` reads the
 * same whether imported from the barrel or used on a client.
 */
export const images = { create: createImage };

// ----- Video (async) -----
//
// Routed (SAP-1927): the submit goes through the shared {@link capabilityCall}
// seam to `POST /v1/capabilities/content.generation.video` on the single Core base
// URL — no direct fal host, no SDK-side `fal-ai/*` default (the router's adapter
// owns model defaulting/aliasing). Video is async, so the router returns a
// {@link VideoDispatchHandle}, not the result; completion is out-of-band — poll the
// handle's `responseUrl` (the Sapiom-hosted queue URL the router hands back) until
// the asset is ready.

/** How often to poll for the async result, and when to give up. Caller-overridable. */
const DEFAULT_VIDEO_POLL_INTERVAL_MS = 5_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 5 * 60_000;

export interface VideoCreateInput {
  /** Text prompt describing the video to generate. */
  prompt: string;
  /**
   * Optional model selector. Defaults to a standard video model; most callers omit it.
   * (Model identifiers are an advanced, evolving surface.)
   */
  model?: string;
  /**
   * Optional: persist the generated output to Sapiom file storage. When set, the
   * returned `video` comes back annotated with `fileId` (or `storageError` if
   * persisting failed).
   */
  storage?: StorageOptions;
  /** Advanced: extra model-specific parameters, forwarded verbatim. */
  params?: Record<string, unknown>;
  /** How often to poll while the video generates (default 5s). */
  pollIntervalMs?: number;
  /** Give up and throw if the result isn't ready within this window (default 5 min). */
  timeoutMs?: number;
}

export interface GeneratedVideo {
  /**
   * Provider-hosted URL of the generated video. May be short-lived and unauthenticated;
   * when you requested `storage`, prefer `downloadUrl` (ready to use) or `fileId` (durable).
   */
  url: string;
  /** MIME type, when reported. */
  contentType?: string;
  /**
   * Present when `storage` was requested and the output was persisted. The durable
   * reference — re-fetch a fresh download URL any time via `fileStorage.getDownloadUrl(fileId)`.
   */
  fileId?: string;
  /**
   * Present when `storage` was requested and the output was persisted: a ready-to-use,
   * short-lived signed download URL for the stored file. Convenience only — it expires, so
   * for anything durable keep `fileId` and re-fetch via `fileStorage.getDownloadUrl(fileId)`.
   */
  downloadUrl?: string;
  /** ISO timestamp when `downloadUrl` expires (~15 min out). Absent whenever `downloadUrl` is. */
  downloadUrlExpiresAt?: string;
  /** Present when `storage` was requested but persisting the output failed. */
  storageError?: string;
}

export interface VideoGenerationResult {
  /** The generated video. */
  video?: GeneratedVideo;
  /** Additional model-specific fields (e.g. `seed`, `timings`), returned as-is. */
  [key: string]: unknown;
}

// ----- Internal request/response shapes -----

interface RawMedia {
  url: string;
  content_type?: string;
  file_id?: string;
  download_url?: string;
  download_url_expires_at?: string;
  storage_error?: string;
}

interface RawVideoResult {
  video?: RawMedia;
  [key: string]: unknown;
}

/**
 * The router's normalized async-dispatch handle (camelCase — the fal adapter maps
 * fal's snake_case queue fields away, `servedBy` stripped at the public boundary):
 * a queue id plus the Sapiom-hosted URLs to poll for the result / status.
 */
interface VideoDispatchHandle {
  requestId?: string;
  responseUrl?: string;
  statusUrl?: string;
}

function mapVideo(raw: RawMedia): GeneratedVideo {
  return {
    url: raw.url,
    ...(raw.content_type !== undefined && { contentType: raw.content_type }),
    ...(raw.file_id !== undefined && { fileId: raw.file_id }),
    ...(raw.download_url !== undefined && { downloadUrl: raw.download_url }),
    ...(raw.download_url_expires_at !== undefined && { downloadUrlExpiresAt: raw.download_url_expires_at }),
    ...(raw.storage_error !== undefined && { storageError: raw.storage_error }),
  };
}

function mapVideoResult(raw: RawVideoResult): VideoGenerationResult {
  const { video, ...rest } = raw;
  return video === undefined
    ? { ...rest }
    : { ...rest, video: mapVideo(video) };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Map a {@link VideoCreateInput} to the router's `VideoCreateRequest` DTO. Mirrors
 * {@link createImage}: `model` is a body field the router's adapter turns into the
 * provider path (and defaults when omitted), and `params` rides as a NESTED field
 * (not spread) so the adapter forwards it verbatim. `!= null` keeps a JS caller's
 * explicit null off the wire; `storage` uses a truthy check so `storage: null` is
 * "no storage" rather than a null field. The poll-timing options
 * (`pollIntervalMs`/`timeoutMs`) are SDK-local and never sent.
 */
function buildVideoRequest(input: VideoCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  if (input.storage) body.storage = input.storage;
  if (input.params != null) body.params = input.params;
  return body;
}

/**
 * Poll a routed video handle's `responseUrl` (the Sapiom-hosted queue URL) until the
 * asset is ready, then return the mapped result. The poll is what persists the output
 * when `storage` was requested, so `fileId` is filled in by the time it returns.
 * Throws once `timeoutMs` elapses with no result.
 */
async function pollVideoResult(
  transport: Transport,
  responseUrl: string,
  requestId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<VideoGenerationResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await transport.fetch(responseUrl, { method: "GET" });
    if (res.ok) {
      const raw = (await res.json()) as RawVideoResult;
      if (raw.video?.url) return mapVideoResult(raw);
    } else {
      // Still generating, or a transient error. Drain the unread body so the
      // connection can be reused, then keep polling — `timeoutMs` is the backstop
      // for a result that never arrives.
      try {
        await res.body?.cancel();
      } catch {
        // best-effort drain
      }
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Video generation did not complete within ${timeoutMs}ms (request id: ${requestId})`,
  );
}

/**
 * Generate a video from a prompt. Video generation is asynchronous: this submits the
 * job, then polls the result through Sapiom until it's ready and returns it — so you
 * `await` it just like {@link createImage}, it just takes longer. Pass `storage` to
 * persist the output (the returned `video` then carries `fileId`). Throws
 * {@link ContentGenerationHttpError} on a failed submit, or an `Error` if the result
 * isn't ready within `timeoutMs`.
 *
 * Routed (SAP-1927): the submit goes through the shared {@link capabilityCall} seam
 * to `POST /v1/capabilities/content.generation.video` on the single Core base URL,
 * which returns a {@link VideoDispatchHandle}; the SDK then polls the handle's routed
 * `responseUrl`. No direct fal host, no SDK-side `fal-ai/*` default.
 */
export async function createVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VideoGenerationResult> {
  assertPrompt(input.prompt);

  // Submit — for an async capability the router returns a dispatch handle, not the result.
  const handle = await capabilityCall<VideoDispatchHandle>(
    "content.generation.video",
    buildVideoRequest(input),
    {
      transport,
      baseUrl,
      makeError: (message, status, errorBody) =>
        new ContentGenerationHttpError(message, status, errorBody),
      errorPrefix: "Failed to submit video generation",
    },
  );
  if (!handle.responseUrl) {
    throw new Error("Video submit did not return a result URL to poll");
  }

  return pollVideoResult(
    transport,
    handle.responseUrl,
    handle.requestId ?? "unknown",
    input.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    input.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS,
  );
}

/**
 * A launched-but-not-awaited video generation job. Satisfies {@link DispatchHandle},
 * so it can be handed straight to `pauseUntilSignal(handle, { resumeStep })` to
 * suspend a workflow step until the video is ready — or `wait()`-ed inline for
 * standalone use (same as `video.create`, but with the dispatchable surface).
 */
export interface VideoLaunchHandle extends DispatchHandle {
  /** The queue request id for this job. */
  requestId: string;
  /** Poll to completion and resolve the full result. */
  wait(opts?: {
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<VideoGenerationResult>;
}

/**
 * The video job's terminal result as it arrives at a step **resumed** from
 * `pauseUntilSignal(launchHandle, { resumeStep })`. It crossed a wire boundary,
 * so the shape is plain JSON. Annotate a resumed step's input with this type.
 *
 *   const finalize = defineStep({
 *     name: "finalize", terminal: true,
 *     async run(result: VideoResultPayload, ctx) { … },
 *   });
 */
export interface VideoResultPayload {
  outputs: Array<{
    /** Present when the output was persisted to file storage — the durable reference. */
    fileId?: string;
    /**
     * A ready-to-use, short-lived signed download URL for the persisted output, when
     * available. Convenience only — it may have expired by the time a resumed step runs;
     * re-fetch from `fileId` via `fileStorage.getDownloadUrl(fileId)` for a fresh one.
     */
    downloadUrl?: string;
    /** ISO expiry of `downloadUrl`, when present — may already be past by the time a step resumes. */
    downloadUrlExpiresAt?: string;
    /** Present when storage was requested but persisting this output failed. */
    storageError?: string;
  }>;
}

/**
 * Map a live, awaited {@link VideoGenerationResult} to the plain
 * {@link VideoResultPayload} a resumed step receives across the wire boundary.
 */
export function toVideoResumePayload(
  result: VideoGenerationResult,
): VideoResultPayload {
  if (!result.video) return { outputs: [] };
  return {
    outputs: [
      {
        ...(result.video.fileId !== undefined && {
          fileId: result.video.fileId,
        }),
        ...(result.video.downloadUrl !== undefined && {
          downloadUrl: result.video.downloadUrl,
        }),
        ...(result.video.downloadUrlExpiresAt !== undefined && {
          downloadUrlExpiresAt: result.video.downloadUrlExpiresAt,
        }),
        ...(result.video.storageError !== undefined && {
          storageError: result.video.storageError,
        }),
      },
    ],
  };
}

/**
 * Submit a video generation job and return a dispatchable handle immediately.
 * The handle's `dispatch` member lets a workflow step pause until the video
 * is ready; `handle.wait()` blocks inline instead — same as `video.create` but
 * with the ability to suspend a running workflow.
 *
 * Pass `storage` to persist the output (the result then carries `fileId`).
 * Throws {@link ContentGenerationHttpError} when the submit fails.
 */
export async function launchVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VideoLaunchHandle> {
  assertPrompt(input.prompt);

  // Submit through the router, carrying the workflow resume token header so the
  // gateway can resume the paused step when the job completes (no-op outside a
  // workflow context — no token, no header). The `/v1` router forwards the header
  // downstream so `pauseUntilSignal` still resumes through the routed path (SAP-1927).
  const handle = await capabilityCall<VideoDispatchHandle>(
    "content.generation.video",
    buildVideoRequest(input),
    {
      transport,
      baseUrl,
      headers: workflowResumeHeaders(transport.resumeToken),
      makeError: (message, status, errorBody) =>
        new ContentGenerationHttpError(message, status, errorBody),
      errorPrefix: "Failed to submit video generation",
    },
  );
  if (!handle.responseUrl) {
    throw new Error("Video submit did not return a result URL to poll");
  }

  const requestId = handle.requestId ?? "unknown";
  const responseUrl = handle.responseUrl;

  const wait = ({
    timeoutMs = input.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    pollMs = input.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS,
  }: {
    timeoutMs?: number;
    pollMs?: number;
  } = {}): Promise<VideoGenerationResult> =>
    pollVideoResult(transport, responseUrl, requestId, timeoutMs, pollMs);

  return {
    requestId,
    dispatch: { correlationId: requestId, resultSignal: VIDEO_RESULT_SIGNAL },
    wait,
  };
}

/** The `video` sub-namespace: `contentGeneration.video.create(...)` and `contentGeneration.video.launch(...)`. */
export const video = { create: createVideo, launch: launchVideo };
