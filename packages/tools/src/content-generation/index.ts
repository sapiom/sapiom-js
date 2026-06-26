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
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, ContentGenerationHttpError } from "./errors.js";
import type { DispatchHandle } from "../dispatch.js";

export { ContentGenerationHttpError };

const DEFAULT_BASE_URL =
  process.env.SAPIOM_CONTENT_GENERATION_URL || "https://fal.services.sapiom.ai";

/**
 * Capability-stable signal a video launch fires when the video reaches a terminal
 * state (ready OR failed — it carries the result either way, the resumed step
 * branches). A workflow step paused on a launch handle resumes on this; it is the
 * value carried in the handle's `dispatch.resultSignal`.
 */
export const VIDEO_RESULT_SIGNAL = "contentGeneration.video.result";

/** Default image model when the caller doesn't pick one — a fast, low-cost model. */
const DEFAULT_IMAGE_MODEL = "fal-ai/flux/schnell";

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
  /** Hosted URL of the generated image. */
  url: string;
  /** MIME type, when reported. */
  contentType?: string;
  width?: number;
  height?: number;
  /**
   * Present when `storage` was requested and this output was persisted — pass to
   * `fileStorage.getDownloadUrl(fileId)` to retrieve it.
   */
  fileId?: string;
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

// ----- Internal request/response shapes -----

interface RawImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
  file_id?: string;
  storage_error?: string;
}

interface RawImageResult {
  images?: RawImage[];
  [key: string]: unknown;
}

function mapImage(raw: RawImage): GeneratedImage {
  return {
    url: raw.url,
    ...(raw.content_type !== undefined && { contentType: raw.content_type }),
    ...(raw.width !== undefined && { width: raw.width }),
    ...(raw.height !== undefined && { height: raw.height }),
    ...(raw.file_id !== undefined && { fileId: raw.file_id }),
    ...(raw.storage_error !== undefined && { storageError: raw.storage_error }),
  };
}

function mapResult(raw: RawImageResult): ImageGenerationResult {
  const { images, ...rest } = raw;
  return images === undefined
    ? { ...rest }
    : { ...rest, images: images.map(mapImage) };
}

// ----- Capability operations -----

/** Encode a model id into a URL path, preserving its `/` separators. */
function modelToPath(model: string): string {
  return model.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

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
 */
export async function createImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ImageGenerationResult> {
  assertPrompt(input.prompt);
  const path = modelToPath(input.model || DEFAULT_IMAGE_MODEL);

  const body: Record<string, unknown> = {
    prompt: input.prompt,
    ...input.params,
  };
  if (input.numImages !== undefined) body.num_images = input.numImages;
  // Truthy check (not `!== undefined`) so a caller passing `storage: null` is
  // treated as "no storage" rather than sending a null field.
  if (input.storage) body.storage = input.storage;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/run/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to generate image",
  );
  return mapResult((await res.json()) as RawImageResult);
}

/**
 * The `images` sub-namespace, so `contentGeneration.images.create(...)` reads the
 * same whether imported from the barrel or used on a client.
 */
export const images = { create: createImage };

// ----- Video (async) -----

/** Default video model when the caller doesn't pick one. */
const DEFAULT_VIDEO_MODEL = "fal-ai/veo3/fast";
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
  /** Hosted URL of the generated video. */
  url: string;
  /** MIME type, when reported. */
  contentType?: string;
  /**
   * Present when `storage` was requested and the output was persisted — pass to
   * `fileStorage.getDownloadUrl(fileId)` to retrieve it.
   */
  fileId?: string;
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
  storage_error?: string;
}

interface RawVideoResult {
  video?: RawMedia;
  [key: string]: unknown;
}

/** The async submit handle: a queue id + the Sapiom URL to poll for the result. */
interface QueueHandle {
  request_id?: string;
  response_url?: string;
  status_url?: string;
}

function mapVideo(raw: RawMedia): GeneratedVideo {
  return {
    url: raw.url,
    ...(raw.content_type !== undefined && { contentType: raw.content_type }),
    ...(raw.file_id !== undefined && { fileId: raw.file_id }),
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
 * Generate a video from a prompt. Video generation is asynchronous: this submits the
 * job, then polls the result through Sapiom until it's ready and returns it — so you
 * `await` it just like {@link createImage}, it just takes longer. Pass `storage` to
 * persist the output (the returned `video` then carries `fileId`). Throws
 * {@link ContentGenerationHttpError} on a failed submit, or an `Error` if the result
 * isn't ready within `timeoutMs`.
 */
export async function createVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<VideoGenerationResult> {
  assertPrompt(input.prompt);
  const path = modelToPath(input.model || DEFAULT_VIDEO_MODEL);

  const body: Record<string, unknown> = {
    prompt: input.prompt,
    ...input.params,
  };
  // Truthy check (not `!== undefined`) so `storage: null` is treated as "no storage".
  if (input.storage) body.storage = input.storage;

  // Submit — for an async model Sapiom returns a queue handle, not the result.
  const submitRes = await ensureOk(
    await transport.fetch(`${baseUrl}/run/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to submit video generation",
  );
  const handle = (await submitRes.json()) as QueueHandle;
  if (!handle.response_url) {
    throw new Error("Video submit did not return a result URL to poll");
  }

  // Poll the result THROUGH Sapiom until it's ready. The poll is what persists the
  // output when `storage` was requested, so `fileId` is filled in by the time it returns.
  const intervalMs = input.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await transport.fetch(handle.response_url, { method: "GET" });
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
    await sleep(intervalMs);
  }
  throw new Error(
    `Video generation did not complete within ${timeoutMs}ms (request id: ${handle.request_id ?? "unknown"})`,
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
    /** Present when the output was persisted to file storage. */
    fileId?: string;
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
  baseUrl = DEFAULT_BASE_URL,
): Promise<VideoLaunchHandle> {
  assertPrompt(input.prompt);
  const path = modelToPath(input.model || DEFAULT_VIDEO_MODEL);

  const body: Record<string, unknown> = {
    prompt: input.prompt,
    ...input.params,
  };
  if (input.storage) body.storage = input.storage;

  // Submit — includes the workflow resume token header so the service can resume
  // the paused step when the job completes (no-op outside a workflow context).
  const submitRes = await ensureOk(
    await transport.fetch(`${baseUrl}/run/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...workflowResumeHeaders(transport.resumeToken),
      },
      body: JSON.stringify(body),
    }),
    "Failed to submit video generation",
  );
  const handle = (await submitRes.json()) as QueueHandle;
  if (!handle.response_url) {
    throw new Error("Video submit did not return a result URL to poll");
  }

  const requestId = handle.request_id ?? "unknown";
  const responseUrl = handle.response_url;

  const wait = async ({
    timeoutMs = input.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS,
    pollMs = input.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS,
  }: {
    timeoutMs?: number;
    pollMs?: number;
  } = {}): Promise<VideoGenerationResult> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await transport.fetch(responseUrl, { method: "GET" });
      if (res.ok) {
        const raw = (await res.json()) as RawVideoResult;
        if (raw.video?.url) return mapVideoResult(raw);
      } else {
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
  };

  return {
    requestId,
    dispatch: { correlationId: requestId, resultSignal: VIDEO_RESULT_SIGNAL },
    wait,
  };
}

/** The `video` sub-namespace: `contentGeneration.video.create(...)` and `contentGeneration.video.launch(...)`. */
export const video = { create: createVideo, launch: launchVideo };
