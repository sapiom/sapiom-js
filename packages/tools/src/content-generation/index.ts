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

/**
 * Neutral aspect-ratio vocabulary — and the entry point to the E4 (SAP-2579) neutral param contract
 * shared with {@link Resolution} and {@link OutputFormat}. A caller sets these as first-class fields on
 * {@link ImageCreateInput} / {@link VideoCreateInput}; the router validates each against the resolved
 * model's capabilities BEFORE payment and maps it to that model's provider wire key. A value the model
 * doesn't support is rejected `400 unsupported_param` (never silently dropped). Each model supports a
 * subset — the union is the full vocabulary. Mirrors the backend catalog (`media-catalog.types.ts`).
 */
export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
/** Neutral resolution vocabulary (video). See {@link AspectRatio} for how neutral params validate. */
export type Resolution = "480p" | "720p" | "1080p";
/** Neutral output-format vocabulary (`"mp4"` for video; image formats otherwise). See {@link AspectRatio}. */
export type OutputFormat = "png" | "jpeg" | "webp" | "mp4";

/**
 * `T` plus any other string — keeps editor autocomplete for the known literals in `T` while still
 * accepting an arbitrary value, so a newly-cataloged model alias works before this SDK catches up.
 * The SDK deliberately adds no client-side model validation: the platform catalog is the authority
 * on what it accepts. The `Record<never, never>` is the lint-safe spelling of the `string & {}` idiom.
 */
type LiteralUnion<T extends string> = T | (string & Record<never, never>);

/**
 * What every `select` shares: the opt-in ranking preference. `requires` is NOT here — its vocabulary
 * is per media type (an image model cannot lip-sync), so it lives on the media type that can
 * actually satisfy it. See {@link VideoSelect.requires}.
 */
interface MediaSelectBase {
  /**
   * Opt-in preference over the surviving candidates. `"cheapest"` re-ranks them by a LIVE price join
   * and picks the lowest, instead of the default deterministic catalog order. It DEGRADES, never
   * fails: when the price join is unavailable, slow, or incomplete (not every candidate priced),
   * selection falls back to catalog order and the response reports `preferSatisfied: false`. A
   * `preferSatisfied: true` therefore means the cheapest was verified against EVERY candidate, never
   * a partial comparison. Omit for deterministic catalog-order selection.
   *
   * What it compares is the live price of the EXACT request as each candidate would run it, not a
   * fixed per-model tier — a model's price moves with the request. Pin `count` (images) / `duration`
   * (video) to compare candidates on equal terms; omit one and each candidate is priced at its OWN
   * catalog default, so a model with a shorter default can win on absolute price.
   */
  prefer?: "cheapest";
}

/**
 * Capability-based model SELECTION (E5 / SAP-2580) for the IMAGE path — steers the choice when
 * `model` is OMITTED. The neutral params you declare already narrow the candidate models on their
 * own, so `select` is the escape hatch for what they cannot express, not the main path. Whichever
 * model the platform picks comes back as `resolvedModel`. A malformed `select` or an unknown
 * `prefer` value is rejected as an unsupported param BEFORE any charge — never silently ignored.
 *
 * `prefer` is the whole image surface today. Images accept no `requires`: no image model declares a
 * capability tag, so the option could only ever narrow the candidates to none.
 */
export interface ImageSelect extends MediaSelectBase {
  /**
   * Not accepted on the image path — a PROHIBITION, not an option you can set. Typed `never` rather
   * than omitted so that passing `requires` is a direct type error on the property itself, however
   * the value was built: an inline literal, or an object assembled elsewhere and passed by
   * reference. (Omitting it caught the literal via excess-property checking, but let a pre-built
   * object carrying both `prefer` and `requires` through silently.)
   *
   * If the catalog grows an image capability tag, this becomes a real tag list — a non-breaking
   * change to THIS type rather than a new export.
   *
   * Reading the error: this repo leaves `exactOptionalPropertyTypes` off, so the property's type is
   * `never | undefined` — i.e. `undefined` — and TypeScript reports "Type '…' is not assignable to
   * type 'undefined'" rather than naming `never`. Same prohibition, confusing wording.
   */
  requires?: never;
}

/**
 * Capability-based model SELECTION (E5 / SAP-2580) for the VIDEO path. Same contract as
 * {@link ImageSelect}, plus the `requires` vocabulary video models actually declare.
 */
export interface VideoSelect extends MediaSelectBase {
  /**
   * Intrinsic capability tags the selected video model MUST declare — the axes a neutral param
   * cannot express. An unknown tag is rejected as an unsupported param, before any charge.
   *
   * Video-only: no image model declares any of these, so there is no image equivalent. If the
   * platform catalogs a new tag, it works on the wire before this list names it — pass it through
   * {@link VideoCreateInput.passthrough} rather than waiting for an SDK release.
   */
  requires?: Array<"audio" | "lipsync" | "referenceImage">;
}

/**
 * The selection directives BOTH media types accept — for code that is generic over image and video.
 * This is the shared shape itself (the fields common to {@link ImageSelect} and
 * {@link VideoSelect}), not a union of them, so a value of this type is genuinely assignable to
 * {@link ImageCreateInput.select} AND {@link VideoCreateInput.select}.
 *
 * A call site that knows its media type should name the specific type instead: only
 * {@link VideoSelect} exposes `requires`, and going through `MediaSelect` would hide it.
 */
export type MediaSelect = MediaSelectBase;

/**
 * The public semantic image-model aliases the routed image capability serves, ready to pass as
 * {@link ImageCreateInput.model} — e.g. `IMAGE_MODELS.fluxFast`. Listed in the platform's catalog
 * order, which is the order it considers them in when you omit `model`. That is a stable listing,
 * not a price ranking — to get the cheapest, ask for it with `select.prefer`.
 *
 * These are Sapiom's OWN neutral names, resolved to a concrete provider model server-side, and they
 * are the SUPPORTED input for {@link ImageCreateInput.model}. A raw provider model id is DEPRECATED:
 * it still works today, but it is not part of the public surface and support for it will be removed
 * in a future release (SAP-2582) — migrate pins to an alias from this map.
 *
 * The map is an autocomplete convenience, not a closed set: `model` stays a {@link LiteralUnion}, so
 * a newly-cataloged alias works before this SDK catches up.
 */
export const IMAGE_MODELS = {
  /** Fast, low-cost text-to-image. The default when `model` is omitted. */
  fluxFast: "flux-fast",
  /** Higher-fidelity, slower. */
  fluxStandard: "flux-standard",
  /** Strong typography / logo rendering. */
  ideogramV3: "ideogram-v3",
  /** Per-image mid-tier. */
  fluxProKontext: "flux-pro-kontext",
  /** Top-quality text-to-image. */
  nanoBananaPro: "nano-banana-pro",
  /** Strong text rendering; the priciest alias. */
  gptImage2: "gpt-image-2",
} as const;

/** A known public image-model alias — one of the values of {@link IMAGE_MODELS}. */
export type KnownImageModel = (typeof IMAGE_MODELS)[keyof typeof IMAGE_MODELS];

export interface ImageCreateInput {
  /** Text prompt describing the image to generate. */
  prompt: string;
  /**
   * Optional model selector — a PUBLIC semantic alias from {@link IMAGE_MODELS} (e.g.
   * `"flux-fast"`), resolved to a concrete provider model server-side. Most callers omit it: the
   * platform then selects one (the fast default, or the cheapest model that satisfies your params
   * and {@link ImageCreateInput.select}), and echoes the choice as `resolvedModel`.
   *
   * A raw provider model id is DEPRECATED here (SAP-2582). It still routes today — this field
   * deliberately stays a {@link LiteralUnion}, so an existing pin keeps compiling and keeps working
   * — but it is not part of the public surface and support for it will be removed in a future
   * release. Migrate pins to an {@link IMAGE_MODELS} alias. The SDK forwards whatever you pass and
   * adds no local validation: the platform catalog is the authority on what it accepts, so a
   * newly-cataloged alias works before this SDK catches up.
   *
   * @example "flux-fast"
   */
  model?: LiteralUnion<KnownImageModel>;

  /**
   * Optional capability-based model selection (E5 / SAP-2580), honored when `model` is omitted:
   * the platform picks a model satisfying your declared params plus `select.requires`, optionally
   * re-ranked by `select.prefer`. See {@link ImageSelect}.
   */
  select?: ImageSelect;

  /**
   * Optional cross-call idempotency key: a repeat with the same key (per tenant) returns the
   * existing generation instead of a new one, matching `agents.run`. Arbitrary string ≤255 (not a UUID).
   * Forwarded verbatim — the platform validates and deduplicates; the SDK adds no logic.
   */
  idempotencyKey?: string;

  // ── Neutral params (E4/SAP-2579). Validated against the resolved model's capabilities BEFORE
  // payment and mapped to its provider wire keys; an unsupported one → 400 `unsupported_param`
  // (never silently dropped). Omit ⇒ the provider default. See {@link AspectRatio} et al.
  /** Aspect ratio of the generated image. */
  aspectRatio?: AspectRatio;
  /** Number of images to generate. Supersedes the deprecated {@link ImageCreateInput.numImages}. */
  count?: number;
  /** Deterministic seed, where the model exposes one. */
  seed?: number;
  /** Negative prompt, where the model supports one. */
  negativePrompt?: string;
  /** Reference image (a hosted URL or a Sapiom `fileId`) for img2img, where the model supports it. */
  referenceImage?: string;
  /** Output image format. */
  outputFormat?: OutputFormat;
  /**
   * Escape hatch: raw provider wire params, merged last so they win over the neutral fields.
   * Supersedes the deprecated {@link ImageCreateInput.params}; use only for a knob the neutral
   * vocabulary lacks.
   */
  passthrough?: Record<string, unknown>;

  /**
   * Optional: persist each generated output to Sapiom file storage. When set, every
   * item in `images` comes back annotated with `fileId` (or `storageError` if
   * persisting that one failed).
   */
  storage?: StorageOptions;
  /** @deprecated use {@link ImageCreateInput.count}. Number of images to generate. Still honored. */
  numImages?: number;
  /**
   * @deprecated use the neutral fields above, or {@link ImageCreateInput.passthrough} for an
   * uncovered knob. Extra model-specific parameters, forwarded verbatim (e.g. `image_size`,
   * `guidance_scale`). Still honored.
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
  /**
   * E5 (SAP-2580): present ONLY when `select.prefer` was requested — `true` when the preference was
   * honored (the cheapest verified against EVERY candidate), `false` when it degraded to
   * deterministic catalog order because the live price join was unavailable, slow, or incomplete.
   * Absent when you asked for no preference.
   */
  preferSatisfied?: boolean;
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
  preferSatisfied?: boolean;
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
 * Thread a dispatch handle's submit-time metadata — SAP-2576 `resolvedModel` (always present) +
 * optional `cost` envelope, and the E5 (SAP-2580) `preferSatisfied` flag — onto a polled result.
 * For video (and async image) the model choice, price quote, and transaction `reference` all
 * resolve at SUBMIT, so they ride the dispatch handle — but the result is polled from the gateway's
 * queue passthrough, which carries none of them. Merge them here: `resolvedModel` unconditionally
 * (the contract guarantees it), `cost` and `preferSatisfied` only when they resolved
 * (omit-don't-fabricate — `preferSatisfied` is absent unless `select.prefer` was asked for, and a
 * fabricated `false` would report a degrade that never happened). The `as` narrows the generic
 * object spread.
 */
function withDispatchMetadata<TBody extends Record<string, unknown>>(
  body: TBody,
  handle: {
    cost?: MediaCostEnvelope;
    resolvedModel: string;
    preferSatisfied?: boolean;
  },
): TBody & {
  resolvedModel: string;
  cost?: MediaCostEnvelope;
  preferSatisfied?: boolean;
} {
  return {
    ...body,
    resolvedModel: handle.resolvedModel,
    ...(handle.cost !== undefined && { cost: handle.cost }),
    ...(handle.preferSatisfied !== undefined && {
      preferSatisfied: handle.preferSatisfied,
    }),
  } as TBody & {
    resolvedModel: string;
    cost?: MediaCostEnvelope;
    preferSatisfied?: boolean;
  };
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
 * The E4 (SAP-2579) neutral param fields + the deprecated aliases, forwarded verbatim as top-level
 * camelCase body fields — matching the router's `ImageCreateRequest`. The SDK only forwards; the
 * router validates against the resolved model's caps, maps to provider wire keys, and applies the
 * merge precedence (`params` < neutral fields < `passthrough`). `count`/`outputFormat` are image-only.
 */
const IMAGE_PARAM_KEYS = [
  "aspectRatio",
  "count",
  "seed",
  "negativePrompt",
  "referenceImage",
  "outputFormat",
  "passthrough",
  "numImages",
  "params",
] as const;

/** As {@link IMAGE_PARAM_KEYS}, for video: no `count`/`outputFormat`; adds `resolution`/`duration`/`audio`. */
const VIDEO_PARAM_KEYS = [
  "aspectRatio",
  "resolution",
  "duration",
  "audio",
  "seed",
  "negativePrompt",
  "referenceImage",
  "passthrough",
  "params",
] as const;

/**
 * Copy each present param field from `input` onto the request `body` (top-level, camelCase). `!= null`
 * drops an explicit JS `null` (treated as unset — mirroring the router's `pickNeutralParams` and the
 * sibling `model` / `storage` handling), so `aspectRatio: null` from a JS caller never hits the wire.
 */
function applyMediaParams(
  body: Record<string, unknown>,
  input: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (input[key] != null) body[key] = input[key];
  }
}

/**
 * Generate one or more images from a prompt. Pass `storage` to persist each output
 * (the returned images then carry `fileId`). Failed requests throw
 * {@link ContentGenerationHttpError}.
 *
 * Routed (SAP-1116): goes through the shared {@link capabilityCall} seam to
 * `POST /v1/capabilities/content.generation.images` on the single Core base URL.
 * `model` is a request-body field the router resolves from a public semantic alias to
 * the provider path (defaulting, or SELECTING per `select`, when omitted) — the SDK
 * no longer builds the `/run/<model>` URL itself, and never resolves an alias locally.
 * A public alias is the supported `model` input; a raw provider id is deprecated but
 * still routes (SAP-2582).
 */
export async function createImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<ImageGenerationResult> {
  assertPrompt(input.prompt);

  // Map to the router's camelCase `ImageCreateRequest`. `model`/`storage` keep their own guards
  // (`storage` truthy, so `storage: null` means "no storage"); the E4 neutral params + the
  // deprecated `numImages`/`params` ride top-level via `applyMediaParams` for the router to
  // validate + map (`params`/`passthrough` stay nested objects, forwarded verbatim).
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  // E5 (SAP-2580) selection directives — a request-level control like `model`, forwarded verbatim
  // for the router to validate; the SDK neither inspects nor defaults it.
  if (input.select != null) body.select = input.select;
  if (input.storage) body.storage = input.storage;
  // Request-level control (like `model`/`storage`), not a neutral media param: forwarded
  // verbatim for the platform to validate + dedup. `!= null` drops an explicit JS `null`.
  if (input.idempotencyKey != null) body.idempotencyKey = input.idempotencyKey;
  applyMediaParams(
    body,
    input as unknown as Record<string, unknown>,
    IMAGE_PARAM_KEYS,
  );

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
  /**
   * E5 (SAP-2580): present ONLY when `select.prefer` was requested, resolved at submit — `true` when
   * the preference was honored, `false` when it degraded to deterministic catalog order.
   */
  preferSatisfied?: boolean;
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
  /**
   * E5 (SAP-2580): present ONLY when `select.prefer` was requested — `true` when the preference was
   * honored, `false` when it degraded to catalog order. Also merged onto the {@link wait} result.
   */
  preferSatisfied?: boolean;
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
 * durable pause/resume payload so a workflow step that bills AFTER the generation (a reseller
 * re-billing its own customers) can still read `cost.reference` / `resolvedModel` — the launch
 * handle is gone by then (`pauseUntilSignal` reduces it to its signal + `correlationId`).
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
    // Both spreads are conditional (omit-don't-fabricate): a real webhook resume omits an absent
    // field rather than carrying an `undefined`-valued key, and this mapper matches that wire shape.
    ...(result.resolvedModel !== undefined && {
      resolvedModel: result.resolvedModel,
    }),
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

  // Mirror createImage's body, plus `dispatch: 'async'` to select the queue path.
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    dispatch: "async",
  };
  if (input.model != null) body.model = input.model;
  // E5 (SAP-2580) selection directives — see createImage.
  if (input.select != null) body.select = input.select;
  if (input.storage) body.storage = input.storage;
  // Request-level control (like `model`/`storage`), not a neutral media param: forwarded
  // verbatim for the platform to validate + dedup. `!= null` drops an explicit JS `null`.
  if (input.idempotencyKey != null) body.idempotencyKey = input.idempotencyKey;
  applyMediaParams(
    body,
    input as unknown as Record<string, unknown>,
    IMAGE_PARAM_KEYS,
  );

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
        // Thread the submit handle's SAP-2576 cost + resolvedModel and E5 preferSatisfied
        // onto the polled result.
        if (Array.isArray(raw.images))
          return withDispatchMetadata(mapResult(raw), handle);
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
    // SAP-2576 + E5: surface the submit handle's resolvedModel, cost envelope, and
    // preferSatisfied on the handle too, so a caller reading them off `launch()` needn't
    // await `wait()`.
    resolvedModel: handle.resolvedModel,
    ...(handle.cost !== undefined && { cost: handle.cost }),
    ...(handle.preferSatisfied !== undefined && {
      preferSatisfied: handle.preferSatisfied,
    }),
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
 * The public semantic video-model aliases the routed video capability serves, ready to pass as
 * {@link VideoCreateInput.model} — e.g. `VIDEO_MODEL_ALIASES.veo3Fast`. The video counterpart of
 * {@link IMAGE_MODELS}, in the same catalog order the platform selects in when you omit `model`.
 *
 * Prefer these over the deprecated raw-provider-id map {@link VIDEO_MODELS}: aliases are the
 * supported input, and support for raw ids will be removed in a future release (SAP-2582). Not a
 * closed set — `model` stays a {@link LiteralUnion}, so a newly-cataloged alias works before this
 * SDK catches up.
 */
export const VIDEO_MODEL_ALIASES = {
  /** Fast text-to-video with native audio. The default when `model` is omitted. */
  veo3Fast: "veo3-fast",
  /** Native-audio + lip-sync single-call UGC. */
  seedanceFast: "seedance-fast",
  /** Premium native-audio text-to-video. */
  seedanceStandard: "seedance-standard",
  /** Silent text-to-video at a fixed native resolution. */
  klingStandard: "kling-standard",
  /** Silent text-to-video, 480p/720p. */
  wanStandard: "wan-standard",
  /** Fast silent text-to-video, 5–15s. */
  minimaxH3Max: "minimax-h3-max",
} as const;

/** A known public video-model alias — one of the values of {@link VIDEO_MODEL_ALIASES}. */
export type KnownVideoModelAlias =
  (typeof VIDEO_MODEL_ALIASES)[keyof typeof VIDEO_MODEL_ALIASES];

/**
 * The concrete provider video model ids the Sapiom video gateway serves, ready to pass as
 * {@link VideoCreateInput.model} — e.g. `VIDEO_MODELS.veo3Fast`.
 *
 * @deprecated Pass a public semantic alias from {@link VIDEO_MODEL_ALIASES} instead. Since
 * `video.create`/`video.launch` were repointed onto the `content.generation.video` capability
 * (SAP-2575) they go through the same routed, alias-resolving surface as images, where the alias is
 * the supported input. These raw ids still route today and this map stays exported so existing code
 * keeps compiling and working — but they are not part of the public surface, and support for them
 * will be removed in a future release (SAP-2582). Every entry has an alias to migrate to:
 * `veo3Fast` → `"veo3-fast"`, `klingV16StandardText` → `"kling-standard"`,
 * `wanV22Text` → `"wan-standard"`, `seedance20Fast` → `"seedance-fast"`. The exception is
 * `minimaxVideo01`, which has NO cataloged alias — switch it to a cataloged model such as
 * `"minimax-h3-max"`.
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

/**
 * A known raw provider video model id — one of the values of {@link VIDEO_MODELS}.
 *
 * @deprecated Use {@link KnownVideoModelAlias}. Raw provider ids still work, but the public
 * semantic alias is the supported input and raw-id support will be removed in a future release
 * (SAP-2582).
 */
export type KnownVideoModel = (typeof VIDEO_MODELS)[keyof typeof VIDEO_MODELS];

/** How often to poll for the async result, and when to give up. Caller-overridable. */
const DEFAULT_VIDEO_POLL_INTERVAL_MS = 5_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 5 * 60_000;

export interface VideoCreateInput {
  /** Text prompt describing the video to generate. */
  prompt: string;
  /**
   * Optional model selector — a PUBLIC semantic alias from {@link VIDEO_MODEL_ALIASES} (e.g.
   * `"veo3-fast"`), resolved to a concrete provider model server-side. Omit it and the platform
   * selects one (the fast default, or the cheapest model satisfying your params and
   * {@link VideoCreateInput.select}), echoing the choice as `resolvedModel`.
   *
   * Video routes through the same alias-resolving capability as images (SAP-2575), so the same
   * guidance applies: a raw provider id from the deprecated {@link VIDEO_MODELS} map is DEPRECATED
   * but still routes today. Those ids stay in the accepted type — and this field stays a
   * {@link LiteralUnion} — so existing code keeps compiling and working; support for them will be
   * removed in a future release (SAP-2582). A {@link LiteralUnion} also means a newly-cataloged
   * alias works before this SDK catches up.
   *
   * @example "veo3-fast"
   */
  model?: LiteralUnion<KnownVideoModelAlias | KnownVideoModel>;

  /**
   * Optional capability-based model selection (E5 / SAP-2580), honored when `model` is omitted:
   * the platform picks a model satisfying your declared params plus `select.requires`, optionally
   * re-ranked by `select.prefer`. See {@link VideoSelect}.
   */
  select?: VideoSelect;

  /**
   * Optional cross-call idempotency key: a repeat with the same key (per tenant) returns the
   * existing generation instead of a new one, matching `agents.run`. Arbitrary string ≤255 (not a UUID).
   * Forwarded verbatim — the platform validates and deduplicates; the SDK adds no logic.
   */
  idempotencyKey?: string;

  // ── Neutral params (E4/SAP-2579) — same contract as {@link ImageCreateInput}: validated against
  // the resolved model's capabilities BEFORE payment, mapped to its provider wire keys; an
  // unsupported one → 400 `unsupported_param`. Omit ⇒ the provider default.
  /** Aspect ratio of the generated video. */
  aspectRatio?: AspectRatio;
  /** Output resolution, where the model exposes one. */
  resolution?: Resolution;
  /**
   * Duration in whole seconds. Omit to get the model's catalog default — the priced duration then
   * equals the generated one (no under-authorization on a longer-than-priced render).
   */
  duration?: number;
  /** Native audio, where the model supports it. */
  audio?: boolean;
  /** Deterministic seed, where the model exposes one. */
  seed?: number;
  /** Negative prompt, where the model supports one. */
  negativePrompt?: string;
  /** Reference image (a hosted URL or a Sapiom `fileId`) for image-to-video, where supported. */
  referenceImage?: string;
  /**
   * Escape hatch: raw provider wire params, merged last so they win over the neutral fields.
   * Supersedes the deprecated {@link VideoCreateInput.params}; use only for a knob the neutral
   * vocabulary lacks.
   */
  passthrough?: Record<string, unknown>;

  /**
   * Optional: persist the generated output to Sapiom file storage. When set, the
   * returned `video` comes back annotated with `fileId` (or `storageError` if
   * persisting failed).
   */
  storage?: StorageOptions;
  /**
   * @deprecated use the neutral fields above, or {@link VideoCreateInput.passthrough} for an
   * uncovered knob. Extra model-specific parameters, forwarded verbatim. Still honored.
   */
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
  /**
   * E5 (SAP-2580), threaded from the submit handle: present ONLY when `select.prefer` was
   * requested — `true` when the preference was honored, `false` when it degraded to catalog order.
   */
  preferSatisfied?: boolean;
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
  /**
   * E5 (SAP-2580): present ONLY when `select.prefer` was requested, resolved at submit — `true` when
   * the preference was honored, `false` when it degraded to deterministic catalog order.
   */
  preferSatisfied?: boolean;
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
// threaded on separately by `withDispatchMetadata`, since the queue passthrough omits it.
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
 * adapter resolves from a public semantic alias like `"veo3-fast"` (defaulting, or SELECTING
 * per `select`, when omitted); the SDK no longer builds a `/run/<model>` URL itself. Video
 * shares the routed surface with images, so the same guidance applies — a raw provider id is
 * deprecated but still routes (SAP-2582). The poll
 * loop is unchanged: the submit response's `responseUrl`/`statusUrl` point at the
 * gateway's queue passthrough, which still returns the provider's raw snake_case result.
 */
export async function createVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VideoGenerationResult> {
  assertPrompt(input.prompt);

  // Map to the router's camelCase `VideoCreateRequest` — mirrors createImage. `model` is a body
  // field the adapter resolves; `storage` truthy so `storage: null` is "no storage"; the E4 neutral
  // params + deprecated `params` ride top-level via `applyMediaParams`.
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  // E5 (SAP-2580) selection directives — see createImage.
  if (input.select != null) body.select = input.select;
  if (input.storage) body.storage = input.storage;
  // Request-level control (like `model`/`storage`), not a neutral media param: forwarded
  // verbatim for the platform to validate + dedup. `!= null` drops an explicit JS `null`.
  if (input.idempotencyKey != null) body.idempotencyKey = input.idempotencyKey;
  applyMediaParams(
    body,
    input as unknown as Record<string, unknown>,
    VIDEO_PARAM_KEYS,
  );

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
      // Thread the submit handle's SAP-2576 cost + resolvedModel and E5 preferSatisfied onto
      // the polled result — the queue passthrough (this `raw`) carries none of them.
      if (raw.video?.url)
        return withDispatchMetadata(mapVideoResult(raw), handle);
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
  /**
   * E5 (SAP-2580): present ONLY when `select.prefer` was requested — `true` when the preference was
   * honored, `false` when it degraded to catalog order. Also merged onto the {@link wait} result.
   */
  preferSatisfied?: boolean;
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
  // Both spreads are conditional (omit-don't-fabricate): a real webhook resume omits an absent
  // field rather than carrying an `undefined`-valued key, and this mapper matches that wire shape.
  const metadata = {
    ...(result.resolvedModel !== undefined && {
      resolvedModel: result.resolvedModel,
    }),
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
 * completion. `model` resolves the same way as `createVideo` (a public semantic
 * alias, defaulted or selected when omitted). The poll stays unchanged: `wait()`
 * reads the gateway's queue passthrough, which still returns the provider's raw
 * snake_case result.
 */
export async function launchVideo(
  input: VideoCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl: string = resolveCoreBaseUrl(),
): Promise<VideoLaunchHandle> {
  assertPrompt(input.prompt);

  // Mirror createVideo's body — video is async-only, so there's no `dispatch` field to add
  // (unlike launchImage, which sets `dispatch: 'async'`).
  const body: Record<string, unknown> = { prompt: input.prompt };
  if (input.model != null) body.model = input.model;
  // E5 (SAP-2580) selection directives — see createImage.
  if (input.select != null) body.select = input.select;
  if (input.storage) body.storage = input.storage;
  // Request-level control (like `model`/`storage`), not a neutral media param: forwarded
  // verbatim for the platform to validate + dedup. `!= null` drops an explicit JS `null`.
  if (input.idempotencyKey != null) body.idempotencyKey = input.idempotencyKey;
  applyMediaParams(
    body,
    input as unknown as Record<string, unknown>,
    VIDEO_PARAM_KEYS,
  );

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
        // Thread the submit handle's SAP-2576 cost + resolvedModel and E5 preferSatisfied
        // onto the polled result.
        if (raw.video?.url)
          return withDispatchMetadata(mapVideoResult(raw), handle);
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
    // SAP-2576 + E5: surface the submit handle's resolvedModel, cost envelope, and
    // preferSatisfied on the handle too, so a caller reading them off `launch()` needn't
    // await `wait()`.
    resolvedModel: handle.resolvedModel,
    ...(handle.cost !== undefined && { cost: handle.cost }),
    ...(handle.preferSatisfied !== undefined && {
      preferSatisfied: handle.preferSatisfied,
    }),
    dispatch: { correlationId: requestId, resultSignal: VIDEO_RESULT_SIGNAL },
    wait,
  };
}

/** The `video` sub-namespace: `contentGeneration.video.create(...)` and `contentGeneration.video.launch(...)`. */
export const video = { create: createVideo, launch: launchVideo };
