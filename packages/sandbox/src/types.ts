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

  /** Sandbox image to use. */
  image?: string;

  /** Memory allocation in MB. */
  memory?: number;

  /** CPU allocation in cores. */
  cpu?: number;

  /** Environment variables to set in the sandbox. */
  env?: Record<string, string>;
}

/** Raw response from POST /v1/sandboxes. */
export interface SandboxCreateResponse {
  name: string;
  workspaceRoot: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Options for executing a command in the sandbox.
 */
export interface ExecOptions {
  /** Working directory for the command (relative to workspaceRoot). */
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
}

/**
 * Result of a process execution.
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
