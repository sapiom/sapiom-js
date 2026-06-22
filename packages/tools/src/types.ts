/**
 * Options for creating a SapiomFileStorage client.
 */
export interface FileStorageCreateOptions {
  /**
   * Sapiom API key. Sent as `x-sapiom-api-key` on every request.
   * Falls back to SAPIOM_API_KEY environment variable when not provided.
   */
  apiKey?: string;

  /**
   * Override the file-storage service base URL.
   * @default "https://file-storage.services.sapiom.ai"
   */
  baseUrl?: string;

  /**
   * Pre-configured fetch function. When provided, all HTTP calls go through it.
   * Useful for testing (inject a mock) or custom middleware (retries, logging).
   * @default globalThis.fetch
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Input for uploading a file (control-plane call).
 * After calling upload(), PUT the file bytes directly to the returned uploadUrl.
 */
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

/**
 * Response from the upload control-plane call.
 * The caller must PUT the file bytes to `uploadUrl` with the `requiredHeaders`.
 */
export interface UploadResponse {
  /** Unique file identifier. Use this in subsequent API calls. */
  fileId: string;

  /**
   * GCS presigned upload URL. PUT file bytes here directly.
   * The URL expires at `expiresAt`.
   */
  uploadUrl: string;

  /** ISO-8601 timestamp when the upload URL expires. */
  expiresAt: string;

  /**
   * Headers that must be included when PUTting bytes to `uploadUrl`.
   * Typically includes `Content-Type`.
   */
  requiredHeaders: Record<string, string>;
}

/**
 * Response from the download URL generation call.
 */
export interface DownloadUrlResponse {
  /** Presigned GCS download URL. Expires at `expiresAt`. */
  downloadUrl: string;

  /** ISO-8601 timestamp when the download URL expires. */
  expiresAt: string;
}

/**
 * Metadata for a stored file.
 */
export interface FileMetadata {
  /** Unique file identifier. */
  fileId: string;

  /** Original file name, if provided at upload time. */
  fileName?: string;

  /** MIME content type. */
  contentType: string;

  /** File visibility ("private" or "public"). */
  visibility: "private" | "public";

  /** Upload lifecycle status (e.g. "pending", "uploaded", "deleted"). */
  status: string;

  /** Expected file size in bytes, if provided at upload time. */
  expectedFileSize?: number;

  /** Actual file size in bytes after upload completes. */
  actualFileSize?: number;

  /** ISO-8601 timestamp when the file record was created. */
  createdAt: string;

  /** ISO-8601 timestamp when the file bytes were uploaded. */
  uploadedAt?: string;

  /** ISO-8601 timestamp when the file was soft-deleted. */
  deletedAt?: string;

  /** Number of times a download URL was generated for this file. */
  downloadRequestCount: number;
}

/**
 * Response from the list files call.
 */
export interface ListResponse {
  /** Files on the current page. */
  files: FileMetadata[];

  /** Page size used. */
  limit: number;

  /** Offset used. */
  offset: number;

  /** Whether there are more files beyond this page. */
  hasMore: boolean;
}

/**
 * Options for listing files.
 */
export interface ListOptions {
  /** Maximum number of files to return. */
  limit?: number;

  /** Number of files to skip. */
  offset?: number;
}
