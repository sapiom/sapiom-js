/**
 * `fileStorage` capability — tenant-scoped object storage on presigned GCS URLs.
 *
 * The control plane only: `upload` hands back a presigned URL you PUT the bytes to
 * yourself (so you own streaming / progress / resumable uploads), and
 * `getDownloadUrl` hands back a presigned URL you GET. `list`, `setVisibility`, and
 * `delete` round out the lifecycle.
 *
 *   import { fileStorage } from "@sapiom/tools";              // ambient auth
 *   const { uploadUrl, requiredHeaders } = await fileStorage.upload({
 *     contentType: "image/png",
 *     fileName: "photo.png",
 *   });
 *   await fetch(uploadUrl, { method: "PUT", headers: requiredHeaders, body: bytes });
 *
 * Or via an explicit client: `createClient({ apiKey }).fileStorage.upload(...)`.
 *
 * Wire fields are snake_case; this module maps them to the camelCase SDK surface.
 * Byte counts are int64 — the gateway serializes them as strings (precision-safe),
 * so `expectedFileSize` / `actualFileSize` on returned metadata are `string | null`.
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { ensureOk, FileStorageHttpError } from "./errors.js";

export { FileStorageHttpError };

/** Object storage service. Host routing is an internal detail — override via SAPIOM_FILE_STORAGE_URL. */
const DEFAULT_BASE_URL =
  process.env.SAPIOM_FILE_STORAGE_URL ||
  "https://file-storage.services.sapiom.ai";

// ----- SDK-facing types -----

export interface UploadInput {
  /** MIME content type of the file (e.g. "image/png", "application/pdf"). */
  contentType: string;
  /** Original file name for display purposes. */
  fileName?: string;
  /**
   * File visibility.
   * - "private" — download requires authentication (default).
   * - "public"  — download URL is unauthenticated.
   */
  visibility?: "private" | "public";
  /** Expected file size in bytes. Used to pre-allocate storage. */
  expectedFileSize?: number;
}

export interface UploadResponse {
  /** Unique file identifier. Use this in subsequent calls. */
  fileId: string;
  /** GCS presigned upload URL. PUT the file bytes here directly. Expires at `expiresAt`. */
  uploadUrl: string;
  /** ISO-8601 timestamp when the upload URL expires. */
  expiresAt: string;
  /** Headers that must be sent when PUTting bytes to `uploadUrl` (e.g. Content-Type). */
  requiredHeaders: Record<string, string>;
}

export interface DownloadUrlResponse {
  /** Presigned GCS download URL. Expires at `expiresAt`. */
  downloadUrl: string;
  /** ISO-8601 timestamp when the download URL expires. */
  expiresAt: string;
}

export interface FileMetadata {
  /** Unique file identifier. */
  fileId: string;
  /** Original file name, if provided at upload time. */
  fileName?: string;
  /** MIME content type. */
  contentType: string;
  /** File visibility ("private" or "public"). */
  visibility: "private" | "public";
  /** Upload lifecycle status (e.g. "pending_upload", "uploaded", "deleted"). */
  status: string;
  /**
   * Expected (client-declared) size in bytes — a string (int64, precision-safe),
   * `null` when not declared.
   */
  expectedFileSize?: string | null;
  /** Actual size in bytes after upload (string; `null` until the verify sweep records it). */
  actualFileSize?: string | null;
  /** ISO-8601 timestamp when the record was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the bytes were uploaded. */
  uploadedAt?: string;
  /** ISO-8601 timestamp when the file was soft-deleted. */
  deletedAt?: string;
  /** Number of times a download URL was generated for this file. */
  downloadRequestCount: number;
}

export interface ListOptions {
  /** Maximum number of files to return. */
  limit?: number;
  /** Number of files to skip (pagination). */
  offset?: number;
}

export interface ListResponse {
  /** Files on the current page. */
  files: FileMetadata[];
  /** Page size used. */
  limit: number;
  /** Offset used. */
  offset: number;
  /** Whether more files exist beyond this page. */
  hasMore: boolean;
}

// ----- wire shapes (snake_case, as served by the gateway) -----

interface GatewayUploadResponse {
  file_id: string;
  upload_url: string;
  expires_at: string;
  required_headers: Record<string, string>;
}

interface GatewayDownloadResponse {
  download_url: string;
  expires_at: string;
}

interface GatewayFileMetadata {
  file_id: string;
  file_name?: string;
  content_type: string;
  visibility: "private" | "public";
  status: string;
  // int64 byte counts serialized as strings by the gateway (precision-safe); null when unset.
  expected_file_size?: string | null;
  actual_file_size?: string | null;
  created_at: string;
  uploaded_at?: string;
  deleted_at?: string;
  download_request_count: number;
}

interface GatewayListResponse {
  files: GatewayFileMetadata[];
  limit: number;
  offset: number;
  has_more: boolean;
}

function mapFileMetadata(raw: GatewayFileMetadata): FileMetadata {
  return {
    fileId: raw.file_id,
    ...(raw.file_name !== undefined && { fileName: raw.file_name }),
    contentType: raw.content_type,
    visibility: raw.visibility,
    status: raw.status,
    ...(raw.expected_file_size !== undefined && {
      expectedFileSize: raw.expected_file_size,
    }),
    ...(raw.actual_file_size !== undefined && {
      actualFileSize: raw.actual_file_size,
    }),
    createdAt: raw.created_at,
    ...(raw.uploaded_at !== undefined && { uploadedAt: raw.uploaded_at }),
    ...(raw.deleted_at !== undefined && { deletedAt: raw.deleted_at }),
    downloadRequestCount: raw.download_request_count,
  };
}

// ----- capability operations -----

/**
 * Initiate an upload. Returns a presigned GCS URL; PUT the bytes to `uploadUrl`
 * with `requiredHeaders` yourself (this capability owns only the control plane).
 */
export async function upload(
  input: UploadInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<UploadResponse> {
  const body: Record<string, unknown> = { content_type: input.contentType };
  if (input.fileName !== undefined) body.file_name = input.fileName;
  if (input.visibility !== undefined) body.visibility = input.visibility;
  if (input.expectedFileSize !== undefined) {
    body.expected_file_size = input.expectedFileSize;
  }

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "Failed to initiate file upload",
  );
  const raw = (await res.json()) as GatewayUploadResponse;
  return {
    fileId: raw.file_id,
    uploadUrl: raw.upload_url,
    expiresAt: raw.expires_at,
    requiredHeaders: raw.required_headers,
  };
}

/** Generate a presigned download URL for a file. */
export async function getDownloadUrl(
  fileId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<DownloadUrlResponse> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/download/${encodeURIComponent(fileId)}`),
    `Failed to get download URL for file '${fileId}'`,
  );
  const raw = (await res.json()) as GatewayDownloadResponse;
  return { downloadUrl: raw.download_url, expiresAt: raw.expires_at };
}

/** List files owned by the authenticated tenant. */
export async function list(
  opts?: ListOptions,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<ListResponse> {
  const url = new URL(`${baseUrl}/files`);
  if (opts?.limit !== undefined) {
    url.searchParams.set("limit", String(opts.limit));
  }
  if (opts?.offset !== undefined) {
    url.searchParams.set("offset", String(opts.offset));
  }
  const res = await ensureOk(
    await transport.fetch(url.toString()),
    "Failed to list files",
  );
  const raw = (await res.json()) as GatewayListResponse;
  return {
    files: raw.files.map(mapFileMetadata),
    limit: raw.limit,
    offset: raw.offset,
    hasMore: raw.has_more,
  };
}

/** Update a file's visibility. */
export async function setVisibility(
  fileId: string,
  visibility: "private" | "public",
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<FileMetadata> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility }),
    }),
    `Failed to set visibility for file '${fileId}'`,
  );
  const raw = (await res.json()) as GatewayFileMetadata;
  return mapFileMetadata(raw);
}

/**
 * Delete a file. Idempotent on the gateway (deleting an already-deleted file is a
 * no-op success). Exported as `delete`:
 * `import { fileStorage } from "@sapiom/tools"; await fileStorage.delete(id)`.
 */
async function deleteFile(
  fileId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<void> {
  const res = await transport.fetch(
    `${baseUrl}/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    throw new FileStorageHttpError(
      `Failed to delete file '${fileId}': ${res.status} ${text}`,
      res.status,
      parsed,
    );
  }
  // 204 No Content — nothing to parse.
}

export { deleteFile as delete };
