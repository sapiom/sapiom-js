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
 *   out.images[0].url;       // hosted URL of the generated image
 *   out.images[0].fileId;    // present when `storage` was passed → use with fileStorage
 *
 * Or via an explicit client: `createClient({ apiKey }).contentGeneration.images.create(...)`.
 *
 * Wire fields are snake_case; this module maps them to the camelCase SDK surface
 * (matching `fileStorage` / `agent`). Model-specific input goes through `params`
 * verbatim; provider-native response extras (`seed`, `timings`, …) pass through.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, ContentGenerationHttpError } from "./errors.js";

export { ContentGenerationHttpError };

/** Generation gateway host. An internal detail — override via SAPIOM_CONTENT_GENERATION_URL. */
const DEFAULT_BASE_URL =
  process.env.SAPIOM_CONTENT_GENERATION_URL || "https://fal.services.sapiom.ai";

/** Default image model when the caller doesn't pick one — a fast, low-cost model. */
const DEFAULT_IMAGE_MODEL = "fal-ai/flux/schnell";

// ----- SDK-facing types (camelCase) -----

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
   * Optional: persist each generated output into Sapiom file-storage server-side.
   * When set, every item in `images` comes back annotated with `fileId` (or
   * `storageError` if persisting that one failed).
   */
  storage?: StorageOptions;
  /**
   * Advanced: extra model-specific parameters, forwarded to the model verbatim
   * (provider-native names, e.g. `image_size`, `seed`, `guidance_scale`).
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
  /**
   * Provider-native top-level extras the model returns (`seed`, `timings`,
   * `has_nsfw_concepts`, …), passed through as-is.
   */
  [key: string]: unknown;
}

// ----- wire shapes (snake_case, as served by the gateway) -----

interface WireImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
  file_id?: string;
  storage_error?: string;
}

interface WireImageResult {
  images?: WireImage[];
  [key: string]: unknown;
}

function mapImage(raw: WireImage): GeneratedImage {
  return {
    url: raw.url,
    ...(raw.content_type !== undefined && { contentType: raw.content_type }),
    ...(raw.width !== undefined && { width: raw.width }),
    ...(raw.height !== undefined && { height: raw.height }),
    ...(raw.file_id !== undefined && { fileId: raw.file_id }),
    ...(raw.storage_error !== undefined && { storageError: raw.storage_error }),
  };
}

function mapResult(raw: WireImageResult): ImageGenerationResult {
  const { images, ...rest } = raw;
  // `rest` carries provider-native top-level extras (seed, timings, …) verbatim.
  return images === undefined
    ? { ...rest }
    : { ...rest, images: images.map(mapImage) };
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
 * (the returned images then carry `fileId`). Non-2xx responses throw
 * {@link ContentGenerationHttpError}.
 */
export async function createImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ImageGenerationResult> {
  const path = modelToPath(input.model || DEFAULT_IMAGE_MODEL);

  // camelCase surface → snake wire: `prompt` + the model-native `params` are
  // forwarded; `numImages` maps to `num_images`. `storage` is the one Sapiom-owned
  // field the gateway reads + strips before proxying upstream. Truthy check (not
  // `!== undefined`) so a JS caller passing `storage: null` doesn't leak a null field.
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    ...input.params,
  };
  if (input.numImages !== undefined) body.num_images = input.numImages;
  if (input.storage) body.storage = input.storage;

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/run/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to generate image",
  );
  return mapResult((await res.json()) as WireImageResult);
}

/**
 * The `images` sub-namespace, so both the ambient barrel import and the bound
 * client read `contentGeneration.images.create(...)`. Video / audio land here as
 * sibling sub-namespaces (SAP-970).
 */
export const images = { create: createImage };
