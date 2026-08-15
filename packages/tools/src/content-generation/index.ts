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

/**
 * Capability-stable signal an image launch fires when the image reaches a terminal
 * state. The async completion→resume path is media-agnostic: the engine reads this
 * name off the paused step row and matches the resume on `correlationId` (the launch
 * `requestId`), so images resume through the exact same rail as video — this name is
 * just the label carried in the handle's `dispatch.resultSignal`.
 */
export const IMAGE_RESULT_SIGNAL = "contentGeneration.images.result";

// ----- Types -----

export interface StorageOptions {
  /**
   * Visibility of the persisted output.
   * - "private" — download requires the owning tenant (default).
   * - "public"  — download URL is reachable by any tenant.
   */
  visibility?: "private" | "public";
}

/**
 * Per-generation cost visibility (SAP-2576) — the SDK mirror of the backend capability
 * envelope (`content-generation/content-generation.types.ts`). Two INDEPENDENTLY-available
 * halves; the envelope ships when at least one resolved, and neither half is ever fabricated
 * to satisfy the other (omit-don't-fabricate):
 *
 *  - the ESTIMATE quartet (`estimateUsd`, `currency`, `isEstimate`, `source`) — present
 *    together exactly when the price quote resolved;
 *  - the `reference` — the Sapiom transaction id the charge lands on; present when the gateway
 *    echoed it. The authoritative SETTLED amount lives out-of-band at
 *    `GET /v1/transactions/:id/costs` (design D1 option C — estimate inline, settled out-of-band).
 *
 * The shape is stable from this epic onward: the E6 metering migration flips `source` (adding
 * `'metered'`) and nothing else, so a reseller can build credit pricing against it today.
 */
export interface MediaCostEnvelope {
  /**
   * Estimated cost of THIS generation in `currency`, quoted from the provider's ungated price
   * route. For an `upto`-priced video model this is the authorized CEILING — the settled amount
   * can be lower. Absent when the quote didn't resolve (never `0`).
   */
  estimateUsd?: number;
  /** ISO 4217 code of `estimateUsd`; present exactly when it is. Always `"USD"` today. */
  currency?: string;
  /**
   * `true` while `source` is `"quote"`: the authoritative settled number lives out-of-band at
   * `GET /v1/transactions/:id/costs`, reachable via `reference`. Travels with `estimateUsd`.
   */
  isEstimate?: boolean;
  /**
   * Provenance of `estimateUsd`: `"quote"` (the ungated gateway price inquiry — today's only
   * value) or `"authorized"` (the payment-authorized amount). E6 adds `"metered"`.
   */
  source?: "quote" | "authorized";
  /**
   * The Sapiom transaction id this generation's charge lands on — resolves at
   * `GET /v1/transactions/:id/costs`. Captured from the gateway's `x-sapiom-transaction-id`
   * response header (set by the x402 collapsed flow at authorization time, so async submits
   * carry it too); omitted when the gateway didn't echo one.
   */
  reference?: string;
}

export interface ImageCreateInput {
  /** Text prompt describing the image to generate. */
  prompt: string;
  /** Number of images to generate. */
  numImages?: number;
  /**
   * Optional model selector. Defaults to a fast image model; most callers omit it.
   *
   * When set, pass a raw *provider* model id — as with video, the SDK forwards `model`
   * verbatim to the gateway, so a backend semantic alias is not resolved here.
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
  /**
   * The public semantic model alias that served this generation (SAP-2576) — the grouping
   * dimension for per-model cost/failure slicing. Always present: a cataloged raw id is
   * reverse-mapped to its alias, an uncataloged one is echoed verbatim (never omitted).
   */
  resolvedModel: string;
  /** Per-generation cost (SAP-2576); omitted when the price join was unavailable. */
  cost?: MediaCostEnvelope;
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
  resolvedModel: string;
  cost?: MediaCostEnvelope;
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

/**
 * Thread a dispatch handle's SAP-2576 `resolvedModel` (always present) + optional `cost`
 * envelope onto a polled result. For video (and async image) the resolved model, price quote,
 * and transaction `reference` resolve at SUBMIT, so they ride the dispatch handle — but the
 * result is polled from the gateway's queue passthrough, which carries none of them. Merge them
 * here: `resolvedModel` unconditionally (the contract guarantees it), `cost` only when the
 * quote/reference resolved (omit-don't-fabricate). The `as` narrows the generic object spread.
 */
function withDispatchCost<TBody extends Record<string, unknown>>(
  body: TBody,
  handle: { cost?: MediaCostEnvelope; resolvedModel: string },
): TBody & { resolvedModel: string; cost?: MediaCostEnvelope } {
  return {
    ...body,
    resolvedModel: handle.resolvedModel,
    ...(handle.cost !== undefined && { cost: handle.cost }),
  } as TBody & { resolvedModel: string; cost?: MediaCostEnvelope };
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

// ----- Image async dispatch (SAP-1802) -----

/** How often to poll for the async image result, and when to give up. Caller-overridable. */
const DEFAULT_IMAGE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 2 * 60_000;

/**
 * The routed async-submit handle the Core capability router returns for a
 * `dispatch: 'async'` image request — camelCase (the router normalizes the
 * upstream snake_case), with `servedBy` stripped at the public `/v1` boundary. Mirrors
 * the video dispatch handle; the image is NOT here yet (completion is out-of-band).
 */
interface ImageDispatchResponse {
  requestId: string;
  statusUrl: string;
  responseUrl?: string;
  /** The semantic model alias this job was submitted to (SAP-2576). Always present. */
  resolvedModel: string;
  /** Per-generation cost estimate (SAP-2576), resolved at submit; omitted when the quote was unavailable. */
  cost?: MediaCostEnvelope;
}

/**
 * The result endpoint to poll. Prefer `responseUrl`; fall back to `statusUrl` with a
 * trailing `/status` removed (the same convention as video's queue handle), so an
 * async image launch stays usable when only `statusUrl` comes back.
 */
function imageResultUrl(handle: ImageDispatchResponse): string | undefined {
  if (handle.responseUrl) return handle.responseUrl;
  if (!handle.statusUrl) return undefined;
  const url = new URL(handle.statusUrl);
  if (!url.pathname.endsWith("/status")) return undefined;
  url.pathname = url.pathname.slice(0, -"/status".length);
  return url.toString();
}

/**
 * A launched-but-not-awaited image generation job. Satisfies {@link DispatchHandle},
 * so it can be handed straight to `pauseUntilSignal(handle, { resumeStep })` to
 * suspend a workflow step until the image is ready — or `wait()`-ed inline for
 * standalone use (same result as `images.create`, but with the dispatchable surface
 * that doesn't hold the request open behind Core's 30s router cap).
 */
export interface ImageLaunchHandle extends DispatchHandle {
  /** The queue request id for this job (also the correlation id a workflow resumes on). */
  requestId: string;
  /** The semantic model alias this job was submitted to (SAP-2576), from the submit handle. */
  resolvedModel: string;
  /**
   * Per-generation cost envelope (SAP-2576), resolved at submit — `estimateUsd` inline and the
   * settled charge out-of-band via `cost.reference`. Also merged onto the {@link wait} result.
   */
  cost?: MediaCostEnvelope;
  /** Poll to completion and resolve the full result. */
  wait(opts?: {
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<ImageGenerationResult>;
}

/**
 * The image job's terminal result as it arrives at a step **resumed** from
 * `pauseUntilSignal(launchHandle, { resumeStep })`. It crossed a wire boundary, so
 * the shape is the engine's generic, media-agnostic dispatch payload (`outputs[]`) —
 * the identical shape a resumed video step receives. Annotate a resumed step's input
 * with this type instead of hand-rolling the shape.
 */
/**
 * The SAP-2576 generation metadata a resumed step needs alongside its `outputs`. Carried on the
 * durable pause/resume payload so a workflow step that bills AFTER the generation (the Polsia
 * rebilling case) can still read `cost.reference` / `resolvedModel` — the launch handle is gone
 * by then (`pauseUntilSignal` reduces it to its signal + `correlationId`).
 */
export interface MediaResumeFields {
  /**
   * The semantic model alias that served this generation (SAP-2576). Omitted on the durable
   * workflow-resume path when the model is not cataloged (best-effort) — the backend refuses to
   * thread caller-controlled free text through this field on the resume payload — see SAP-2650.
   */
  resolvedModel?: string;
  /** Per-generation cost (SAP-2576) — `estimateUsd` inline, settled charge via `cost.reference`. */
  cost?: MediaCostEnvelope;
}

export interface ImageResultPayload extends MediaResumeFields {
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
    /**
     * `true` when the output persisted (so `fileId` is set) but the gateway could not mint a
     * `downloadUrl` for this resume payload. An explicit signal to re-fetch from `fileId` — a
     * fresh presigned URL via `fileStorage.getDownloadUrl(fileId)`, or a durable link via
     * `fileStorage.getPublicUrl(fileId)` — rather than treating a missing `downloadUrl` as "no asset".
     */
    downloadUrlUnavailable?: boolean;
    /** Present when storage was requested but persisting this output failed. */
    storageError?: string;
  }>;
}

/**
 * Map a live, awaited {@link ImageGenerationResult} to the plain
 * {@link ImageResultPayload} a resumed step receives across the wire boundary.
 */
export function toImageResumePayload(
  result: ImageGenerationResult,
): ImageResultPayload {
  return {
    // SAP-2576: preserve the generation metadata across the durable pause/resume boundary, so a
    // resumed step (which never sees the launch handle) can still bill against `cost.reference`.
    resolvedModel: result.resolvedModel,
    ...(result.cost !== undefined && { cost: result.cost }),
    outputs: (result.images ?? []).map((img) => ({
      ...(img.fileId !== undefined && { fileId: img.fileId }),
      ...(img.downloadUrl !== undefined && { downloadUrl: img.downloadUrl }),
      ...(img.downloadUrlExpiresAt !== undefined && {
        downloadUrlExpiresAt: img.downloadUrlExpiresAt,
      }),
      ...(img.storageError !== undefined && { storageError: img.storageError }),
    })),
  };
}

/**
 * Submit an image generation job and return a dispatchable handle immediately, rather
 * than holding the request open for the full generate+store the way the routed sync
 * {@link createImage} does. The handle's `dispatch` member lets a workflow step pause
 * until the image is ready; `handle.wait()` blocks inline instead.
 *
 * Routed (SAP-1116) + async (SAP-1802): POSTs `dispatch: 'async'` to
 * `POST /v1/capabilities/content.generation.images`, forwarding the engine's workflow
 * resume token so the service resumes the paused step on completion. The router returns
 * a queue handle (not the image); the result arrives via signal resume or `wait()`.
 * Because the submit returns as soon as the job is enqueued, it never meets Core's 30s
 * router cap — the failure mode the blocking sync path hits under a fan-out.
 *
 * Pass `storage` to persist the output (the result then carries `fileId`). Throws
 * {@link ContentGenerationHttpError} when the submit fails.
 */
export async function launchImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<ImageLaunchHandle> {
  assertPrompt(input.prompt);

  // Mirror createImage's body byte-for-byte, plus `dispatch: 'async'` to select the
  // queue path. `params` rides nested; `storage` uses a truthy check (so `storage: null`
  // is "no storage"); `!= null` keeps an explicit JS null off the wire.
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    dispatch: "async",
  };
  if (input.model != null) body.model = input.model;
  if (input.numImages !== undefined) body.numImages = input.numImages;
  if (input.storage) body.storage = input.storage;
  if (input.params != null) body.params = input.params;

  const handle = await capabilityCall<ImageDispatchResponse>(
    "content.generation.images",
    body,
    {
      transport,
      baseUrl,
      // Forward the resume token so the service resumes a paused workflow step when the
      // job completes (no header, no behavior change outside a workflow context).
      headers: workflowResumeHeaders(transport.resumeToken),
      makeError: (message, status, errorBody) =>
        new ContentGenerationHttpError(message, status, errorBody),
      errorPrefix: "Failed to launch image generation",
    },
  );

  const responseUrl = imageResultUrl(handle);
  if (!responseUrl) {
    throw new Error("Image submit did not return a result URL to poll");
  }
  const requestId = handle.requestId ?? "unknown";

  const wait = async ({
    timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS,
    pollMs = DEFAULT_IMAGE_POLL_INTERVAL_MS,
  }: {
    timeoutMs?: number;
    pollMs?: number;
  } = {}): Promise<ImageGenerationResult> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await transport.fetch(responseUrl, { method: "GET" });
      if (res.ok) {
        const raw = (await res.json()) as RawImageResult;
        // Thread the submit handle's SAP-2576 cost + resolvedModel onto the polled result.
        if (Array.isArray(raw.images))
          return withDispatchCost(mapResult(raw), handle);
      } else {
        // Still generating, or a transient error. Drain the unread body so the
        // connection can be reused, then keep polling — `timeoutMs` is the backstop.
        try {
          await res.body?.cancel();
        } catch {
          // best-effort drain
        }
      }
      await sleep(pollMs);
    }
    throw new Error(
      `Image generation did not complete within ${timeoutMs}ms (request id: ${requestId})`,
    );
  };

  return {
    requestId,
    // SAP-2576: surface the submit handle's resolvedModel + cost envelope on the handle too,
    // so a caller reading them off `launch()` needn't await `wait()`.
    resolvedModel: handle.resolvedModel,
    ...(handle.cost !== undefined && { cost: handle.cost }),
    dispatch: { correlationId: requestId, resultSignal: IMAGE_RESULT_SIGNAL },
    wait,
  };
}

/**
 * The `images` sub-namespace: `contentGeneration.images.create(...)` (routed sync) and
 * `contentGeneration.images.launch(...)` (routed async-dispatch, for workflow pause or
 * inline `wait()`), read the same whether imported from the barrel or used on a client.
 */
export const images = { create: createImage, launch: launchImage };

// ----- Video (async) -----

/**
 * `T` plus any other string — keeps editor autocomplete for the known literals in `T`
 * while still accepting an arbitrary id (new gateway models work before this list catches
 * up). The `Record<never, never>` is the lint-safe spelling of the `string & {}` idiom.
 */
type LiteralUnion<T extends string> = T | (string & Record<never, never>);

/**
 * The concrete provider video model ids the Sapiom video gateway serves, ready to pass as
 * {@link VideoCreateInput.model} — e.g. `VIDEO_MODELS.veo3Fast`.
 *
 * @deprecated Raw provider ids are no longer required. `video.create`/`video.launch` route
 * through the `content.generation.video` capability (SAP-2575), and that capability's adapter
 * resolves Sapiom's semantic aliases (`"veo3-fast"`, `"kling-standard"`, …) server-side — pass
 * one of those directly to {@link VideoCreateInput.model} instead. Kept exported for
 * back-compat: a raw provider id from this object still works, the adapter passes an
 * already-resolved id straight through.
 */
export const VIDEO_MODELS = {
  /** Google Veo 3 Fast — fast text-to-video. The default. */
  veo3Fast: "fal-ai/veo3/fast",
  /** Kling Video v1.6 Standard — text-to-video. */
  klingV16StandardText: "fal-ai/kling-video/v1.6/standard/text-to-video",
  /** WAN v2.2 (a14b) — text-to-video. */
  wanV22Text: "fal-ai/wan/v2.2-a14b/text-to-video",
  /** ByteDance Seedance 2.0 Fast — native-audio single-call text-to-video. */
  seedance20Fast: "bytedance/seedance-2.0/fast/text-to-video",
  /** Minimax Video-01 — text-to-video (per-video pricing). */
  minimaxVideo01: "fal-ai/minimax/video-01",
} as const;

/** A known video model id — one of the values of {@link VIDEO_MODELS}. */
export type KnownVideoModel = (typeof VIDEO_MODELS)[keyof typeof VIDEO_MODELS];

/** How often to poll for the async result, and when to give up. Caller-overridable. */
const DEFAULT_VIDEO_POLL_INTERVAL_MS = 5_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 5 * 60_000;

export interface VideoCreateInput {
  /** Text prompt describing the video to generate. */
  prompt: string;
  /**
   * Optional video model. Omit to use the router's default (currently Veo 3 Fast).
   *
   * Pass a Sapiom semantic alias (`"veo3-fast"`, `"kling-standard"`, …) or a raw *provider*
   * model id from {@link VIDEO_MODELS} — both resolve: the request routes through the
   * `content.generation.video` capability, whose adapter resolves an alias to its provider
   * id server-side (SAP-2575).
   *
   * @example "veo3-fast"
   */
  model?: LiteralUnion<KnownVideoModel>;
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
  /**
   * The public semantic model alias that served this generation (SAP-2576) — from the submit
   * handle (the polled queue passthrough doesn't carry it). Always present: cataloged raw ids
   * reverse-map to their alias, uncataloged ones are echoed verbatim.
   */
  resolvedModel: string;
  /**
   * Per-generation cost (SAP-2576), threaded from the submit handle: `estimateUsd` inline and
   * the settled charge out-of-band via `cost.reference`. Omitted when the price join was
   * unavailable at submit.
   */
  cost?: MediaCostEnvelope;
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
 * The routed async-submit handle the Core capability router returns for the video
 * capability — camelCase (the router normalizes the provider's snake_case), with `servedBy`
 * stripped at the public `/v1` boundary. Mirrors {@link ImageDispatchResponse}.
 *
 * NOTE: this is only the SUBMIT envelope's shape. The URL it carries
 * (`responseUrl`/`statusUrl`) points at the gateway's queue passthrough, which still
 * returns the provider's RAW snake_case result — see {@link RawVideoResult} and {@link mapVideo}.
 */
interface VideoDispatchResponse {
  requestId: string;
  statusUrl: string;
  responseUrl?: string;
  /** The semantic model alias this job was submitted to (SAP-2576). Always present. */
  resolvedModel: string;
  /**
   * Per-generation cost envelope (SAP-2576), resolved at submit. Carries the `estimateUsd`
   * quote and the transaction `reference` for the settled charge — the poll target (the
   * gateway's queue passthrough) carries neither, so this is the only place they ride.
   */
  cost?: MediaCostEnvelope;
}

/**
 * The result endpoint to poll. Prefer `responseUrl`; fall back to `statusUrl` with a
 * trailing `/status` removed — the same convention as {@link imageResultUrl} — so an
 * async video launch stays usable when only `statusUrl` comes back.
 */
function videoResultUrl(handle: VideoDispatchResponse): string | undefined {
  if (handle.responseUrl) return handle.responseUrl;
  if (!handle.statusUrl) return undefined;
  const url = new URL(handle.statusUrl);
  if (!url.pathname.endsWith("/status")) return undefined;
  url.pathname = url.pathname.slice(0, -"/status".length);
  return url.toString();
}

function mapVideo(raw: RawMedia): GeneratedVideo {
  return {
    url: raw.url,
    ...(raw.content_type !== undefined && { contentType: raw.content_type }),
    ...(raw.file_id !== undefined && { fileId: raw.file_id }),
    ...(raw.download_url !== undefined && { downloadUrl: raw.download_url }),
    ...(raw.download_url_expires_at !== undefined && {
      downloadUrlExpiresAt: raw.download_url_expires_at,
    }),
    ...(raw.storage_error !== undefined && { storageError: raw.storage_error }),
  };
}

// Returns the camelCase video BODY only — the submit-only metadata (`resolvedModel`, `cost`) is
// threaded on separately by `withDispatchCost`, since the queue passthrough omits it.
function mapVideoResult(raw: RawVideoResult): {
  video?: GeneratedVideo;
  [key: string]: unknown;
} {
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
 *
 * Routed (SAP-2575): the submit goes through the shared {@link capabilityCall} seam to
 * `POST /v1/capabilities/content.generation.video` on the single Core base URL — the
 * same seam {@link createImage} uses. `model` is a request-body field the router's video
 * adapter resolves (a semantic alias like `"veo3-fast"`, or a raw provider id, and
 * defaults when omitted); the SDK no longer builds a `/run/<model>` URL itself. The poll
 * loop is unchanged: the submit response's `responseUrl`/`statusUrl` point at the
 * gateway's queue passthrough, which still returns the provider's raw snake_case result.
 */
export async function createVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VideoGenerationResult> {
  assertPrompt(input.prompt);

  // Map to the router's camelCase video request. `params` rides as a nested field
  // (not spread) so the adapter forwards it verbatim; `model` is a body field the
  // adapter resolves — mirrors createImage's body byte-for-byte.
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  // Truthy check (not `!== undefined`) so `storage: null` is treated as "no storage".
  if (input.storage) body.storage = input.storage;
  if (input.params != null) body.params = input.params;

  // Submit through the capability router — the video capability's adapter always
  // returns a queue handle (camelCase requestId/statusUrl/responseUrl), never the
  // finished result inline (its `fromGatewayResponse` throws without a handle).
  const handle = await capabilityCall<VideoDispatchResponse>(
    "content.generation.video",
    body,
    {
      transport,
      baseUrl,
      makeError: (message, status, errorBody) =>
        new ContentGenerationHttpError(message, status, errorBody),
      errorPrefix: "Failed to submit video generation",
    },
  );
  const responseUrl = videoResultUrl(handle);
  if (!responseUrl) {
    throw new Error("Video submit did not return a result URL to poll");
  }

  // Poll the result THROUGH Sapiom until it's ready. The poll is what persists the
  // output when `storage` was requested, so `fileId` is filled in by the time it returns.
  const intervalMs = input.pollIntervalMs ?? DEFAULT_VIDEO_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await transport.fetch(responseUrl, { method: "GET" });
    if (res.ok) {
      const raw = (await res.json()) as RawVideoResult;
      // Thread the submit handle's SAP-2576 cost + resolvedModel onto the polled result —
      // the queue passthrough (this `raw`) carries neither.
      if (raw.video?.url) return withDispatchCost(mapVideoResult(raw), handle);
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
    `Video generation did not complete within ${timeoutMs}ms (request id: ${handle.requestId ?? "unknown"})`,
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
  /** The semantic model alias this job was submitted to (SAP-2576), from the submit handle. */
  resolvedModel: string;
  /**
   * Per-generation cost envelope (SAP-2576), resolved at submit — `estimateUsd` inline and the
   * settled charge out-of-band via `cost.reference`. Also merged onto the {@link wait} result.
   */
  cost?: MediaCostEnvelope;
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
export interface VideoResultPayload extends MediaResumeFields {
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
    /**
     * `true` when the output persisted (so `fileId` is set) but the gateway could not mint a
     * `downloadUrl` for this resume payload. An explicit signal to re-fetch from `fileId` — a
     * fresh presigned URL via `fileStorage.getDownloadUrl(fileId)`, or a durable link via
     * `fileStorage.getPublicUrl(fileId)` — rather than treating a missing `downloadUrl` as "no asset".
     */
    downloadUrlUnavailable?: boolean;
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
  // SAP-2576: preserve the generation metadata across the durable pause/resume boundary, so a
  // resumed step (which never sees the launch handle) can still bill against `cost.reference`.
  const metadata = {
    resolvedModel: result.resolvedModel,
    ...(result.cost !== undefined && { cost: result.cost }),
  };
  if (!result.video) return { outputs: [], ...metadata };
  return {
    ...metadata,
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
 *
 * Routed (SAP-2575): the submit is identical to {@link createVideo}'s — same body,
 * same `POST /v1/capabilities/content.generation.video` call through the shared
 * {@link capabilityCall} seam. Unlike images, video has no sync/async choice (it's
 * the first capability that is ASYNC-dispatch only), so there's no `dispatch` field
 * to set here; `launchVideo` differs from `createVideo` only in returning the
 * dispatch handle (for workflow pause/resume) instead of polling to completion
 * itself. Workflow resume is driven by forwarding the engine's resume token via
 * {@link workflowResumeHeaders} so the service resumes the paused step on
 * completion. `model` resolves the same way as `createVideo` (semantic alias or
 * raw provider id, defaulted when omitted). The poll stays unchanged: `wait()`
 * reads the gateway's queue passthrough, which still returns the provider's raw
 * snake_case result.
 */
export async function launchVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VideoLaunchHandle> {
  assertPrompt(input.prompt);

  // Mirror createVideo's body byte-for-byte — video is async-only, so there's no
  // `dispatch` field to add (unlike launchImage, which sets `dispatch: 'async'` to
  // pick the queue path over images' sync default).
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  if (input.storage) body.storage = input.storage;
  if (input.params != null) body.params = input.params;

  const handle = await capabilityCall<VideoDispatchResponse>(
    "content.generation.video",
    body,
    {
      transport,
      baseUrl,
      // Forward the resume token so the service resumes a paused workflow step when the
      // job completes (no header, no behavior change outside a workflow context).
      headers: workflowResumeHeaders(transport.resumeToken),
      makeError: (message, status, errorBody) =>
        new ContentGenerationHttpError(message, status, errorBody),
      errorPrefix: "Failed to submit video generation",
    },
  );

  const responseUrl = videoResultUrl(handle);
  if (!responseUrl) {
    throw new Error("Video submit did not return a result URL to poll");
  }

  const requestId = handle.requestId ?? "unknown";

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
        // Thread the submit handle's SAP-2576 cost + resolvedModel onto the polled result.
        if (raw.video?.url)
          return withDispatchCost(mapVideoResult(raw), handle);
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
    // SAP-2576: surface the submit handle's resolvedModel + cost envelope on the handle too,
    // so a caller reading them off `launch()` needn't await `wait()`.
    resolvedModel: handle.resolvedModel,
    ...(handle.cost !== undefined && { cost: handle.cost }),
    dispatch: { correlationId: requestId, resultSignal: VIDEO_RESULT_SIGNAL },
    wait,
  };
}

/** The `video` sub-namespace: `contentGeneration.video.create(...)` and `contentGeneration.video.launch(...)`. */
export const video = { create: createVideo, launch: launchVideo };
