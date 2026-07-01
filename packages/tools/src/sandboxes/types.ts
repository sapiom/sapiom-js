/** Memory tier for sandbox allocation. */
export type SandboxTier = "xs" | "s" | "m" | "l" | "xl";

/** Port specification for an exposed port. */
export interface PortSpec {
  port: number;
  [key: string]: unknown;
}

/** Options for creating a sandbox. */
export interface SandboxCreateOptions {
  /** Sandbox name. Lowercase alphanumeric and hyphens, 2-63 characters. */
  name: string;

  /** Memory tier. @default 's' */
  tier?: SandboxTier;

  /** Time-to-live (e.g. '1h', '24h', '7d'). */
  ttl?: string;

  /** Environment variables to set in the sandbox. */
  envs?: Record<string, string>;

  /** Single port to expose. Mutually exclusive with `ports`. */
  port?: number;

  /** Ports to expose. Mutually exclusive with `port`. */
  ports?: PortSpec[];

  /**
   * Pre-built image reference to launch from. The image must be reachable by the
   * Sapiom sandbox service (e.g. a managed `sapiom/...` image or one your tenant
   * has access to).
   *
   * NOTE: building a custom image from a Dockerfile is intentionally NOT exposed
   * here yet — it requires the platform to inject the sandbox runtime agent, which
   * shouldn't leak into the author's Dockerfile. It lands later as a properly
   * abstracted capability. See docs/plans/capability-authoring-sdk.md.
   */
  image?: string;

  /** Override the sandbox service base URL (platform routing detail; rarely needed). */
  baseUrl?: string;
}

/** Options for executing a command (non-streaming). */
export interface ExecOptions {
  /** Working directory, resolved relative to the sandbox workspace root. */
  cwd?: string;

  /** Environment variables for the process. */
  env?: Record<string, string>;

  /**
   * Wait for the process to finish before returning. When false, returns
   * immediately after process creation (fire-and-forget). @default true
   */
  waitForCompletion?: boolean;

  /** Polling interval in ms while waiting for completion. @default 1000 */
  pollInterval?: number;

  /** Timeout in ms while waiting for completion. @default 60000 */
  timeout?: number;

  /** Keep the sandbox awake (no standby) while this process runs. */
  keepAlive?: boolean;

  /** Auto-terminate the process after this many seconds (0 = no auto-termination). */
  processTimeout?: number;

  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
}

/** Options for streaming command execution. */
export interface ExecStreamOptions {
  /** Working directory, resolved relative to the sandbox workspace root. */
  cwd?: string;
  /** Environment variables for the process. */
  env?: Record<string, string>;
  /** AbortSignal to cancel the operation. */
  signal?: AbortSignal;
}

/** A single line of process output from a streaming exec. */
export interface OutputLine {
  stream: "stdout" | "stderr";
  data: string;
}

/** Result of a (non-streaming) process execution. */
export interface ExecResult {
  /** Process ID in the sandbox. */
  pid: string;
  /** Exit code. -1 when `waitForCompletion` is false and the process hasn't finished. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Result of a streaming process execution. Iterate `output`; `exitCode` populates after it drains. */
export interface StreamingExecResult {
  readonly pid: string;
  readonly exitCode: number;
  readonly output: AsyncIterable<OutputLine>;
}

/** Process status as reported by the sandbox service. */
export interface ProcessStatus {
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

/** Options for {@link Sandbox.uploadFile}. */
export interface UploadFileOptions {
  /** Part size in bytes. @default 5 * 1024 * 1024 (5 MiB) */
  partSize?: number;

  /** Number of parallel part uploads. @default 4 */
  concurrency?: number;

  /** File permissions string passed to initiate. @default "0644" */
  permissions?: string;

  /**
   * Max retries per failed part upload. Retries on 408/425/429/5xx and
   * network errors; honors `Retry-After`. Pass `0` to disable.
   * @default 3
   */
  maxRetries?: number;

  /**
   * Initial retry backoff in ms. Doubles each attempt with up to `base` ms
   * jitter, so 3 retries take ≤ ~400ms total at the default.
   * @default 50
   */
  retryBaseDelayMs?: number;

  /** AbortSignal to cancel the upload. Triggers an auto-abort of the multipart upload on the server. */
  signal?: AbortSignal;

  /** Invoked after each part finishes uploading (in completion order, not partNumber order). */
  onPartUploaded?: (
    part: MultipartUploadedPart,
    progress: UploadProgress,
  ) => void;
}

/**
 * Read-model view of a sandbox returned by `get` / `list` — its metadata and
 * current status, not a live handle. Use `attach(name)` to operate on it.
 */
export interface SandboxInfo {
  /** Sandbox name — the identifier `attach(name)` takes. */
  readonly name: string;
  /** What created the sandbox. */
  readonly source: string;
  /** Lifecycle status — e.g. `"deploying"`, `"running"`, `"stopped"`, `"failed"`. */
  readonly status: string;
  /** Memory tier the sandbox was allocated with. */
  readonly tier: string;
  /** Public base URL when one is exposed, otherwise `null`. */
  readonly url: string | null;
  /** Container image, when reported. */
  readonly image?: string;
  /** Last error message, when the sandbox is in a failed state. */
  readonly error?: string;
  /** Absolute workspace root path inside the sandbox. */
  readonly workspaceRoot: string;
  /** ISO-8601 expiry (TTL) timestamp, or `null` when it does not expire. */
  readonly expiresAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string;
}

// --- internal wire shapes (not part of the public surface) ---

/** @internal Raw create response. */
export interface CreateResponse {
  name: string;
  workspaceRoot: string;
  [key: string]: unknown;
}

/** @internal Raw process-create response. */
export interface ProcessCreateResponse {
  pid: string;
  status: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  [key: string]: unknown;
}
