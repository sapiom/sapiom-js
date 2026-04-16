/** Memory tier for sandbox allocation. */
export type SandboxTier = "xs" | "s" | "m" | "l" | "xl";

/** Port specification for exposed ports. */
export interface PortSpec {
  port: number;
  [key: string]: unknown;
}

/**
 * Configuration for creating a sandbox instance.
 */
export interface SandboxCreateOptions {
  /** Sapiom API key. Falls back to SAPIOM_API_KEY env var. */
  apiKey?: string;

  /** Override the sandbox service base URL. */
  baseUrl?: string;

  /**
   * Pre-configured fetch function. When provided, `apiKey` is ignored
   * and this function is used directly for all HTTP calls.
   */
  fetch?: typeof globalThis.fetch;

  /** Sandbox name. Lowercase alphanumeric and hyphens, 2-63 characters. */
  name: string;

  /** Memory tier. @default 's' */
  tier?: SandboxTier;

  /** Time-to-live (e.g. '1h', '24h', '7d'). */
  ttl?: string;

  /** Environment variables to set in the sandbox. */
  envs?: Record<string, string>;

  /**
   * Single port number to expose.
   * Cannot be used together with `ports`.
   */
  port?: number;

  /**
   * Array of port specs to expose.
   * Cannot be used together with `port`.
   */
  ports?: PortSpec[];

  /** Pre-built Docker image for instant creation. */
  image?: string;

  /**
   * If true, returns a presigned S3 upload URL for a ZIP containing a Dockerfile.
   * Blaxel builds a reusable Docker image from the upload.
   *
   * The Dockerfile **must** include the sandbox-api runtime agent:
   * ```dockerfile
   * COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
   * ENTRYPOINT ["/usr/local/bin/sandbox-api"]
   * ```
   *
   * Cannot be combined with `image`.
   */
  upload?: boolean;
}

/** Raw response from POST /v1/sandboxes. */
export interface SandboxCreateResponse {
  name: string;
  source: string;
  status: string;
  tier: string;
  url: string;
  image?: string;
  uploadUrl?: string;
  workspaceRoot: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/**
 * Options for executing a command in the sandbox.
 */
export interface ExecOptions {
  /** Working directory for the command, resolved relative to workspaceRoot. */
  cwd?: string;

  /** Environment variables for the process. */
  env?: Record<string, string>;

  /**
   * Wait for the process to complete before returning.
   * When false, returns immediately after process creation (fire-and-forget).
   * @default true
   */
  waitForCompletion?: boolean;

  /** Polling interval in ms when waiting for completion. @default 1000 */
  pollInterval?: number;

  /** Timeout in ms when waiting for completion. @default 60000 */
  timeout?: number;

  /**
   * Prevent the sandbox from entering standby while this process runs.
   * Passed through to the Blaxel process API.
   */
  keepAlive?: boolean;

  /**
   * Auto-terminate the process after this many seconds.
   * 0 means no auto-termination. Passed through to the Blaxel process API.
   */
  processTimeout?: number;

  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
}

/**
 * Options for streaming command execution.
 */
export interface ExecStreamOptions {
  /** Working directory for the command, resolved relative to workspaceRoot. */
  cwd?: string;

  /** Environment variables for the process. */
  env?: Record<string, string>;

  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
}

/**
 * A single line of process output from a streaming exec.
 */
export interface OutputLine {
  /** Which output stream this line came from. */
  stream: "stdout" | "stderr";
  /** The line content (without the stream prefix). */
  data: string;
}

/**
 * Result of a process execution (non-streaming).
 */
export interface ExecResult {
  /** Process ID in the sandbox. */
  pid: string;

  /**
   * Exit code of the process.
   * -1 when `waitForCompletion` is false and the process hasn't finished.
   */
  exitCode: number;

  /** Standard output. */
  stdout: string;

  /** Standard error. */
  stderr: string;
}

/**
 * Result of a streaming process execution.
 * Iterate `output` to receive lines in real time.
 * `exitCode` is populated after the output iterable is fully consumed.
 */
export interface StreamingExecResult {
  /** Process ID in the sandbox. */
  readonly pid: string;

  /**
   * Exit code of the process.
   * -1 until the output stream has been fully consumed.
   */
  readonly exitCode: number;

  /** Async iterable of output lines, yielded in real time. */
  readonly output: AsyncIterable<OutputLine>;
}

/** Raw response from POST /v1/sandboxes/:name/process. */
export interface ProcessCreateResponse {
  pid: string;
  status: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  [key: string]: unknown;
}

/** Raw response from GET /v1/sandboxes/:name/process/:pid. */
export interface ProcessStatusResponse {
  pid: string;
  status: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  [key: string]: unknown;
}

/** Raw response from POST /v1/sandboxes/:name/filesystem/multipart/initiate/:path. */
export interface MultipartInitiateResponse {
  uploadId: string;
  path: string;
}

/** Ack returned after a part upload or needed to complete an upload. */
export interface MultipartUploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** Full part record returned by GET .../multipart/:uploadId/parts. */
export interface MultipartPartInfo extends MultipartUploadedPart {
  uploadedAt: string;
}

/** Progress reported to {@link UploadFileOptions.onPartUploaded}. */
export interface UploadProgress {
  partsUploaded: number;
  totalParts: number;
  bytesUploaded: number;
  totalBytes: number;
}

/** Options for {@link SapiomSandbox.uploadFile}. */
export interface UploadFileOptions {
  /** Part size in bytes. @default 5 * 1024 * 1024 (5 MiB) */
  partSize?: number;

  /** Number of parallel part uploads. @default 4 */
  concurrency?: number;

  /** File permissions string passed to initiate. @default "0644" */
  permissions?: string;

  /** AbortSignal to cancel the upload. Triggers an auto-abort of the multipart upload on the server. */
  signal?: AbortSignal;

  /** Invoked after each part finishes uploading (in completion order, not partNumber order). */
  onPartUploaded?: (part: MultipartUploadedPart, progress: UploadProgress) => void;
}
