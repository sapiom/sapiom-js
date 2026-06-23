/**
 * `contentGeneration` capability — generate media (images today; video / audio to
 * come) with an optional `storage` param that persists each output into Sapiom
 * file-storage server-side. Provider-neutral by design: the surface names the
 * *capability*, never the upstream provider.
 *
 *   import { contentGeneration } from "@sapiom/tools";        // ambient auth
 *   const out = await contentGeneration.images.create({
 *     prompt: "a red bicycle",
 *     storage: { visibility: "private" },                     // optional — persist outputs
 *   });
 *   out.images[0].url;        // hosted URL of the generated image
 *   out.images[0].file_id;    // present when `storage` was passed → use with fileStorage
 *
 * Or via an explicit client: `createClient({ apiKey }).contentGeneration.images.create(...)`.
 *
 * The result is forwarded from the generation gateway largely verbatim (snake_case
 * fields like `content_type`, `seed`); the stitch only adds `file_id` /
 * `storage_error` inline on each output.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, ContentGenerationHttpError } from "./errors.js";

export { ContentGenerationHttpError };

/** Generation gateway host. An internal detail — override via SAPIOM_CONTENT_GENERATION_URL. */
const DEFAULT_BASE_URL =
  process.env.SAPIOM_CONTENT_GENERATION_URL || "https://fal.services.sapiom.ai";

/** Default image model when the caller doesn't pick one — a fast, low-cost model. */
const DEFAULT_IMAGE_MODEL = "fal-ai/flux/schnell";

// ----- SDK-facing types -----

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
  /**
   * Optional model selector. Defaults to a fast image model; most callers omit it.
   * (Model identifiers are an advanced, evolving surface.)
   */
  model?: string;
  /**
   * Optional: persist each generated output into Sapiom file-storage server-side.
   * When set, every item in `images` comes back annotated with `file_id` (or
   * `storage_error` if persisting that one failed).
   */
  storage?: StorageOptions;
  /**
   * Additional generation parameters, passed through to the model verbatim
   * (e.g. `num_images`, `image_size`, `seed`).
   */
  [key: string]: unknown;
}

export interface GeneratedImage {
  /** Hosted URL of the generated image. */
  url: string;
  /** MIME type, when reported. */
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
  /** Other model-specific fields (kept verbatim). */
  [key: string]: unknown;
}

export interface ImageGenerationResult {
  /** Generated images. */
  images?: GeneratedImage[];
  /** Other top-level fields the model returns (`seed`, `timings`, `has_nsfw_concepts`, …). */
  [key: string]: unknown;
}

// ----- capability operations -----

/**
 * Encode a model id as a path while preserving its `/` separators (the gateway
 * routes on them). Empty segments (leading/trailing/double slashes) are dropped.
 */
function modelToPath(model: string): string {
  return model.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * Generate one or more images from a prompt. Pass `storage` to persist each output
 * (the returned images then carry `file_id`). Non-2xx responses throw
 * {@link ContentGenerationHttpError}.
 */
export async function createImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ImageGenerationResult> {
  const { model, storage, ...params } = input;
  const path = modelToPath(model || DEFAULT_IMAGE_MODEL);

  // `params` (prompt + any passthrough fields) is forwarded verbatim; `storage` is
  // the one Sapiom-owned field the gateway reads + strips before proxying upstream.
  // The top-level `storage` arg intentionally wins over any same-named passthrough
  // key — `storage` is reserved for the stitch. Truthy check (not `!== undefined`)
  // so a JS caller passing `storage: null` doesn't leak a null field upstream.
  const body: Record<string, unknown> = { ...params };
  if (storage) body.storage = storage;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/run/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to generate image",
  );
  return (await res.json()) as ImageGenerationResult;
}

/**
 * The `images` sub-namespace, so both the ambient barrel import and the bound
 * client read `contentGeneration.images.create(...)`. Video / audio land here as
 * sibling sub-namespaces (SAP-970).
 */
export const images = { create: createImage };
