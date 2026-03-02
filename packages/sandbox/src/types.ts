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
}

/** Raw response from POST /v1/sandboxes. */
export interface SandboxCreateResponse {
  name: string;
  source: string;
  status: string;
  tier: string;
  url: string;
  image: string;
  uploadUrl: string;
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
  pid: number;

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
  readonly pid: number;

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
  pid: number;
  stdout?: string;
  stderr?: string;
  completed?: boolean;
  exitCode?: number;
  [key: string]: unknown;
}

/** Raw response from GET /v1/sandboxes/:name/process/:pid. */
export interface ProcessStatusResponse {
  pid: number;
  completed: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  [key: string]: unknown;
}
