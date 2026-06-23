/**
 * `fal` capability — image generation through the Sapiom Fal gateway, with an
 * optional `storage` param that persists each output into Sapiom file-storage
 * server-side (the SAP-887 stitch).
 *
 *   import { fal } from "@sapiom/tools";                       // ambient auth
 *   const out = await fal.run({
 *     model: "fal-ai/flux/schnell",
 *     input: { prompt: "a red bicycle", num_images: 1 },
 *     storage: { visibility: "private" },                      // optional — persist outputs
 *   });
 *   out.images[0].url;        // Fal's hosted URL
 *   out.images[0].file_id;    // present when `storage` was passed → use with fileStorage
 *
 * Or via an explicit client: `createClient({ apiKey }).fal.run(...)`.
 *
 * Unlike `fileStorage` (a Sapiom-native API mapped to camelCase), `fal` is a
 * passthrough proxy: both the model `input` and the returned shape are Fal-native
 * (snake_case — `num_images`, `content_type`, `has_nsfw_concepts`, …), matching
 * Fal's own docs. The stitch only adds `file_id` / `storage_error` inline on each
 * generated image, so we forward the response verbatim rather than remapping it.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, FalHttpError } from "./errors.js";

export { FalHttpError };

/** Fal gateway host. Routing is an internal detail — override via SAPIOM_FAL_URL. */
const DEFAULT_BASE_URL =
  process.env.SAPIOM_FAL_URL || "https://fal.services.sapiom.ai";

// ----- SDK-facing types -----

export interface FalStorageOptions {
  /**
   * Visibility of the persisted output.
   * - "private" — download requires the owning tenant (default).
   * - "public"  — download URL is reachable by any tenant.
   */
  visibility?: "private" | "public";
}

export interface FalRunInput {
  /** Fal model id, e.g. "fal-ai/flux/schnell". Becomes the gateway path `/run/<model>`. */
  model: string;
  /**
   * The model's native input payload (`prompt`, `num_images`, `image_url`, …),
   * forwarded to Fal verbatim. Snake_case, as Fal documents it.
   */
  input: Record<string, unknown>;
  /**
   * Optional: persist each generated output into Sapiom file-storage server-side.
   * When set, every item in `images` comes back annotated with `file_id` (or
   * `storage_error` if persisting that one failed). Supported on synchronous image
   * models only — passing it to an async (queued) video/audio model is a `400`.
   */
  storage?: FalStorageOptions;
}

export interface FalImage {
  /** Fal's hosted URL for the generated image. */
  url: string;
  /** MIME type, when Fal reports it. */
  content_type?: string;
  width?: number;
  height?: number;
  /**
   * Present when `storage` was requested and this output was persisted — pass to
   * `fileStorage.getDownloadUrl(file_id)` to retrieve it.
   */
  file_id?: string;
  /**
   * Present when `storage` was requested but persisting THIS output failed
   * (best-effort: other images in the same response may still carry `file_id`).
   */
  storage_error?: string;
  /** Other model-specific fields Fal attaches (kept verbatim). */
  [key: string]: unknown;
}

export interface FalRunResponse {
  /** Generated images (synchronous image models). Absent for async/queued models. */
  images?: FalImage[];
  /** Other top-level fields Fal returns (`seed`, `timings`, `has_nsfw_concepts`, …). */
  [key: string]: unknown;
}

// ----- capability operations -----

/**
 * Encode a Fal model id as a path while preserving its `/` separators (the gateway
 * routes on them). Empty segments (leading/trailing/double slashes) are dropped.
 */
function modelToPath(model: string): string {
  return model.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * Run a Fal model. Forwards `input` to the gateway's `/run/<model>` and returns
 * Fal's response verbatim. Pass `storage` to persist each output (the response's
 * images then carry `file_id`). Non-2xx responses throw {@link FalHttpError}.
 */
export async function run(
  input: FalRunInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<FalRunResponse> {
  // Guard `model` for nullish too (JS callers bypass the types) so a missing model
  // is a clear error, not a `.split` TypeError.
  const path = input.model ? modelToPath(input.model) : "";
  if (!path) {
    throw new Error(
      "fal.run: 'model' is required (e.g. 'fal-ai/flux/schnell')",
    );
  }
  // Fal model input is forwarded verbatim; `storage` is the one Sapiom-owned field
  // the gateway reads + strips before proxying upstream. The top-level `storage` arg
  // intentionally wins over any same-named key inside `input` — `storage` is reserved
  // for the stitch. Truthy check (not `!== undefined`) so a JS caller passing
  // `storage: null` doesn't leak a null field upstream.
  const body: Record<string, unknown> = { ...input.input };
  if (input.storage) body.storage = input.storage;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/run/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    `Failed to run Fal model '${input.model}'`,
  );
  return (await res.json()) as FalRunResponse;
}
