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

// --- deploy & preview ---

/** Runtime for a deploy. Only Node.js is supported today. */
export type DeployRuntime = "node";

/**
 * Input for the module-level {@link deploy}. The {@link Sandbox.deploy} method
 * takes the same shape minus `name` (it uses the handle's own name).
 */
export interface DeployInput {
  /** Name of an existing sandbox to deploy to. */
  name: string;

  /** File map: path → content. At least one file is required. */
  files: Record<string, string>;

  /**
   * Start command. Auto-detected from `package.json`'s `start` script (else
   * `node index.js`) when omitted.
   */
  entrypoint?: string;

  /** Runtime. Auto-detected from the file map when omitted. Only `"node"` today. */
  runtime?: DeployRuntime;
}

/** Result of a deploy — the gateway's sandbox record after the app starts. */
export interface DeployResult {
  /** Sandbox name (primary identifier). */
  name: string;

  /** Lifecycle status — `"running"` once the deploy succeeds. */
  status: string;

  /**
   * Public URL of the running app, or `null`. Non-null only when the gateway has
   * previews enabled (`COMPUTE_PREVIEWS_ENABLED`); otherwise the app is reachable
   * only from inside the platform.
   */
  url: string | null;

  /** How the sandbox was created (e.g. `"sandbox"`). */
  source?: string;

  /** Memory tier assigned to the sandbox. */
  tier?: string;

  /** ISO-8601 timestamp of sandbox creation. */
  createdAt?: string;
}

/**
 * Input for the module-level {@link createPreview}. The
 * {@link Sandbox.createPreview} method takes the same shape minus `name`.
 */
export interface PreviewInput {
  /** Name of the sandbox to expose. */
  name: string;

  /** Port inside the sandbox to expose. */
  port: number;

  /** Stable preview name. Pin it for blue-green pivots / idempotent re-creates. */
  previewName?: string;

  /**
   * If true, the preview is reachable without an access token. When omitted, the
   * platform default applies.
   */
  public?: boolean;

  /** Subdomain prefix when paired with `customDomain` (final URL: `https://{prefixUrl}.{customDomain}`). */
  prefixUrl?: string;

  /** Workspace-level custom domain to mint the preview under (paired with `prefixUrl`). */
  customDomain?: string;

  /** Optional human-readable label. */
  label?: string;
}

/** Result of creating a preview — the public URL plus its normalized metadata. */
export interface PreviewResult {
  /** The HTTPS URL that proxies to the sandbox port. Present once the preview is live. */
  url?: string;

  /** Preview status as reported by the platform. */
  status?: string;

  /** Preview name. */
  name?: string;

  /** The exposed port. */
  port?: number;

  /** Whether the preview is publicly reachable without a token. */
  public?: boolean;

  /** Subdomain prefix, when a custom domain was used. */
  prefixUrl?: string;

  /** Custom domain, when one was used. */
  customDomain?: string;

  /** Human-readable label, when set. */
  label?: string;
}

// --- internal wire shapes (not part of the public surface) ---

/** @internal Raw preview spec — fields the platform may return flat or under `spec`. */
export interface RawPreviewSpec {
  port?: number;
  url?: string;
  status?: string;
  label?: string;
  public?: boolean;
  prefixUrl?: string;
  customDomain?: string;
}

/** @internal Raw preview response — fields may be flat or nested under `spec` / `metadata`. */
export interface RawPreviewResponse extends RawPreviewSpec {
  name?: string;
  metadata?: { name?: string };
  spec?: RawPreviewSpec;
}

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
