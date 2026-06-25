/**
 * `contentGeneration` capability — generate media (images today; video and audio
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
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, ContentGenerationHttpError } from "./errors.js";

export { ContentGenerationHttpError };

const DEFAULT_BASE_URL = resolveServiceUrl(
  "fal",
  process.env.SAPIOM_CONTENT_GENERATION_URL,
);

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
 * Generate one or more images from a prompt. Pass `storage` to persist each output
 * (the returned images then carry `fileId`). Failed requests throw
 * {@link ContentGenerationHttpError}.
 */
export async function createImage(
  input: ImageCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ImageGenerationResult> {
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
 * same whether imported from the barrel or used on a client. Video and audio will
 * land here as sibling sub-namespaces.
 */
export const images = { create: createImage };
