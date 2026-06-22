import { ensureOk, FileStorageHttpError } from "./errors.js";
import type {
  FileStorageCreateOptions,
  UploadInput,
  UploadResponse,
  DownloadUrlResponse,
  FileMetadata,
  ListResponse,
  ListOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "https://file-storage.services.sapiom.ai";

/** Raw gateway response shape for POST /upload (201). */
interface GatewayUploadResponse {
  file_id: string;
  upload_url: string;
  expires_at: string;
  required_headers: Record<string, string>;
}

/** Raw gateway response shape for GET /download/:fileId. */
interface GatewayDownloadResponse {
  download_url: string;
  expires_at: string;
}

/** Raw gateway response shape for a file metadata record. */
interface GatewayFileMetadata {
  file_id: string;
  file_name?: string;
  content_type: string;
  visibility: "private" | "public";
  status: string;
  expected_file_size?: number;
  actual_file_size?: number;
  created_at: string;
  uploaded_at?: string;
  deleted_at?: string;
  download_request_count: number;
}

/** Raw gateway response shape for GET /files. */
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

/**
 * Typed client for the Sapiom file-storage gateway.
 *
 * Create an instance via `SapiomFileStorage.create({ apiKey?, baseUrl?, fetch? })`.
 *
 * ## Upload flow
 * 1. Call `upload()` to get a presigned GCS upload URL.
 * 2. PUT the file bytes directly to `uploadUrl` with the `requiredHeaders`.
 *    The `SapiomFileStorage` client intentionally does NOT PUT bytes — it owns
 *    only the control-plane calls so callers can handle streaming, progress,
 *    resumable uploads, etc. themselves.
 */
export class SapiomFileStorage {
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _baseUrl: string;
  private readonly _apiKey: string | undefined;

  private constructor(
    fetchFn: typeof globalThis.fetch,
    baseUrl: string,
    apiKey: string | undefined,
  ) {
    this._fetch = fetchFn;
    this._baseUrl = baseUrl;
    this._apiKey = apiKey;
  }

  /**
   * Create a SapiomFileStorage client.
   *
   * @param opts.apiKey   - Sapiom API key (falls back to `SAPIOM_API_KEY` env var).
   * @param opts.baseUrl  - Override gateway base URL (default: file-storage.services.sapiom.ai).
   * @param opts.fetch    - Injectable fetch implementation (default: globalThis.fetch).
   */
  static create(opts: FileStorageCreateOptions = {}): SapiomFileStorage {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const fetchFn = opts.fetch ?? globalThis.fetch;
    const apiKey =
      opts.apiKey ??
      (typeof process !== "undefined"
        ? process.env["SAPIOM_API_KEY"]
        : undefined);
    return new SapiomFileStorage(fetchFn, baseUrl, apiKey);
  }

  private _headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this._apiKey) {
      headers["x-sapiom-api-key"] = this._apiKey;
    }
    if (extra) {
      Object.assign(headers, extra);
    }
    return headers;
  }

  /**
   * Initiate a file upload (control-plane call).
   *
   * Returns a presigned GCS upload URL. The caller must PUT the file bytes
   * directly to `uploadUrl` with the `requiredHeaders` included. This client
   * does not perform the byte transfer — see class-level docs.
   *
   * @param input.contentType       - MIME type of the file (required).
   * @param input.fileName          - Display file name (optional).
   * @param input.visibility        - "private" (default) or "public".
   * @param input.expectedFileSize  - Expected size in bytes (optional).
   *
   * @returns fileId, uploadUrl, expiresAt, requiredHeaders
   */
  async upload(input: UploadInput): Promise<UploadResponse> {
    const body: Record<string, unknown> = {
      content_type: input.contentType,
    };
    if (input.fileName !== undefined) body["file_name"] = input.fileName;
    if (input.visibility !== undefined) body["visibility"] = input.visibility;
    if (input.expectedFileSize !== undefined) {
      body["expected_file_size"] = input.expectedFileSize;
    }

    const response = await ensureOk(
      await this._fetch(`${this._baseUrl}/upload`, {
        method: "POST",
        headers: this._headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      }),
      "Failed to initiate file upload",
    );

    const raw = (await response.json()) as GatewayUploadResponse;
    return {
      fileId: raw.file_id,
      uploadUrl: raw.upload_url,
      expiresAt: raw.expires_at,
      requiredHeaders: raw.required_headers,
    };
  }

  /**
   * Generate a presigned download URL for a file.
   *
   * @param fileId - The file identifier returned from `upload()`.
   * @returns downloadUrl and expiresAt.
   */
  async getDownloadUrl(fileId: string): Promise<DownloadUrlResponse> {
    const response = await ensureOk(
      await this._fetch(
        `${this._baseUrl}/download/${encodeURIComponent(fileId)}`,
        {
          headers: this._headers(),
        },
      ),
      `Failed to get download URL for file '${fileId}'`,
    );

    const raw = (await response.json()) as GatewayDownloadResponse;
    return {
      downloadUrl: raw.download_url,
      expiresAt: raw.expires_at,
    };
  }

  /**
   * List files owned by the authenticated user/org.
   *
   * @param opts.limit  - Maximum number of files to return.
   * @param opts.offset - Number of files to skip (for pagination).
   *
   * @returns files, limit, offset, hasMore
   */
  async list(opts?: ListOptions): Promise<ListResponse> {
    const url = new URL(`${this._baseUrl}/files`);
    if (opts?.limit !== undefined) {
      url.searchParams.set("limit", String(opts.limit));
    }
    if (opts?.offset !== undefined) {
      url.searchParams.set("offset", String(opts.offset));
    }

    const response = await ensureOk(
      await this._fetch(url.toString(), {
        headers: this._headers(),
      }),
      "Failed to list files",
    );

    const raw = (await response.json()) as GatewayListResponse;
    return {
      files: raw.files.map(mapFileMetadata),
      limit: raw.limit,
      offset: raw.offset,
      hasMore: raw.has_more,
    };
  }

  /**
   * Delete a file.
   *
   * @param fileId - The file identifier returned from `upload()`.
   */
  async delete(fileId: string): Promise<void> {
    const response = await this._fetch(
      `${this._baseUrl}/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: this._headers(),
      },
    );

    if (!response.ok) {
      let body: unknown;
      const text = await response.text().catch(() => "");
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      throw new FileStorageHttpError(
        `Failed to delete file '${fileId}': ${response.status} ${text}`,
        response.status,
        body,
      );
    }
    // 204 No Content — no body to parse
  }

  /**
   * Update the visibility of a file.
   *
   * @param fileId     - The file identifier returned from `upload()`.
   * @param visibility - "private" or "public".
   *
   * @returns Updated file metadata.
   */
  async setVisibility(
    fileId: string,
    visibility: "private" | "public",
  ): Promise<FileMetadata> {
    const response = await ensureOk(
      await this._fetch(`${this._baseUrl}/${encodeURIComponent(fileId)}`, {
        method: "PATCH",
        headers: this._headers({ "content-type": "application/json" }),
        body: JSON.stringify({ visibility }),
      }),
      `Failed to set visibility for file '${fileId}'`,
    );

    const raw = (await response.json()) as GatewayFileMetadata;
    return mapFileMetadata(raw);
  }
}
