import { createFetch } from "@sapiom/fetch";
import type {
  SandboxCreateOptions,
  SandboxCreateResponse,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
  OutputLine,
  ProcessCreateResponse,
  ProcessStatusResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://blaxel.services.sapiom.ai";
const DEFAULT_POLL_INTERVAL = 1000;
const DEFAULT_EXEC_TIMEOUT = 60_000;

function assertRelativePath(path: string): void {
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(
        `Path must not contain '..' segments: ${path}`,
      );
    }
  }
}

function resolvePath(workspaceRoot: string, relativePath: string): string {
  assertRelativePath(relativePath);
  const base = workspaceRoot.endsWith("/")
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;
  const rel = relativePath.startsWith("/")
    ? relativePath.slice(1)
    : relativePath;
  return `${base}/${rel}`;
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function fileUrl(
  baseUrl: string,
  sandboxName: string,
  absolutePath: string,
): string {
  const pathSegment = absolutePath.startsWith("/")
    ? absolutePath.slice(1)
    : absolutePath;
  return `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/filesystem/${encodePathSegments(pathSegment)}`;
}

function parseOutputLine(line: string): OutputLine | null {
  if (line.startsWith("stdout:")) {
    return { stream: "stdout", data: line.slice(7) };
  }
  if (line.startsWith("stderr:")) {
    return { stream: "stderr", data: line.slice(7) };
  }
  return null;
}

export class SapiomSandbox {
  /** Name / identifier of the sandbox. */
  readonly name: string;

  /** Absolute workspace root path inside the sandbox. */
  readonly workspaceRoot: string;

  private readonly _fetch: typeof globalThis.fetch;
  private readonly _baseUrl: string;

  private constructor(
    name: string,
    workspaceRoot: string,
    fetchFn: typeof globalThis.fetch,
    baseUrl: string,
  ) {
    this.name = name;
    this.workspaceRoot = workspaceRoot;
    this._fetch = fetchFn;
    this._baseUrl = baseUrl;
  }

  /**
   * Create a new sandbox and return a handle for interacting with it.
   */
  static async create(opts: SandboxCreateOptions): Promise<SapiomSandbox> {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const fetchFn = opts.fetch ?? createFetch({ apiKey: opts.apiKey });

    const body: Record<string, unknown> = { name: opts.name };
    if (opts.tier !== undefined) body.tier = opts.tier;
    if (opts.ttl !== undefined) body.ttl = opts.ttl;
    if (opts.envs !== undefined) body.envs = opts.envs;
    if (opts.port !== undefined) body.port = opts.port;
    if (opts.ports !== undefined) body.ports = opts.ports;
    if (opts.image !== undefined) body.image = opts.image;

    const response = await fetchFn(`${baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to create sandbox: ${response.status} ${text}`,
      );
    }

    const data = (await response.json()) as SandboxCreateResponse;
    return new SapiomSandbox(data.name, data.workspaceRoot, fetchFn, baseUrl);
  }

  /**
   * Write a file inside the sandbox.
   *
   * @param path - File path relative to workspaceRoot.
   * @param content - File content as a string or binary data.
   */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const fullPath = resolvePath(this.workspaceRoot, path);
    const url = fileUrl(this._baseUrl, this.name, fullPath);

    const body =
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : content;

    const response = await this._fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to write file '${path}': ${response.status} ${text}`,
      );
    }
  }

  /**
   * Read a file from the sandbox.
   *
   * @param path - File path relative to workspaceRoot.
   * @returns The file content as a string.
   */
  async readFile(path: string): Promise<string> {
    const fullPath = resolvePath(this.workspaceRoot, path);
    const url = fileUrl(this._baseUrl, this.name, fullPath);

    const response = await this._fetch(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to read file '${path}': ${response.status} ${text}`,
      );
    }

    return response.text();
  }

  /**
   * Execute a command in the sandbox with streaming output.
   *
   * @param command - The shell command to run.
   * @param opts - Execution options with `stream: true`.
   * @returns A streaming result with an async iterable of output lines.
   */
  async exec(
    command: string,
    opts: ExecOptions & { stream: true },
  ): Promise<StreamingExecResult>;
  /**
   * Execute a command in the sandbox.
   *
   * By default waits for the process to finish (polls process status).
   * Set `opts.waitForCompletion = false` for fire-and-forget execution.
   *
   * @param command - The shell command to run.
   * @param opts - Execution options.
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  async exec(
    command: string,
    opts?: ExecOptions,
  ): Promise<ExecResult | StreamingExecResult> {
    if (opts?.stream) {
      return this._execStreaming(command, opts);
    }

    const proc = await this._createProcess(command, opts);

    // If the process already completed synchronously, return immediately
    if (proc.completed) {
      return {
        pid: proc.pid,
        exitCode: proc.exitCode ?? 0,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
      };
    }

    const waitForCompletion = opts?.waitForCompletion ?? true;
    if (!waitForCompletion) {
      return {
        pid: proc.pid,
        exitCode: -1,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
      };
    }

    return this._pollProcess(proc.pid, opts);
  }

  /**
   * Destroy the sandbox and release all resources.
   */
  async destroy(): Promise<void> {
    const response = await this._fetch(
      `${this._baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}`,
      { method: "DELETE" },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to destroy sandbox: ${response.status} ${text}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _createProcess(
    command: string,
    opts?: ExecOptions,
  ): Promise<ProcessCreateResponse> {
    const body: Record<string, unknown> = { command };
    if (opts?.cwd !== undefined) {
      body.cwd = resolvePath(this.workspaceRoot, opts.cwd);
    }
    if (opts?.env !== undefined) body.env = opts.env;

    const response = await this._fetch(
      `${this._baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/process`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts?.signal,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to execute command: ${response.status} ${text}`,
      );
    }

    return (await response.json()) as ProcessCreateResponse;
  }

  private async _execStreaming(
    command: string,
    opts?: ExecOptions,
  ): Promise<StreamingExecResult> {
    const proc = await this._createProcess(command, opts);

    let finalExitCode = -1;

    // Capture what the generator closure needs
    const fetchFn = this._fetch;
    const baseUrl = this._baseUrl;
    const sandboxName = this.name;
    const signal = opts?.signal;

    async function* streamOutput(): AsyncGenerator<OutputLine> {
      const response = await fetchFn(
        `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/process/${proc.pid}/logs/stream`,
        { signal },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to stream process ${proc.pid}: ${response.status} ${text}`,
        );
      }

      if (!response.body) {
        throw new Error(
          `No response body for process ${proc.pid} log stream`,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;

          for (const line of lines) {
            if (!line) continue;
            const parsed = parseOutputLine(line);
            if (parsed) yield parsed;
          }
        }

        // Flush remaining buffer
        if (buffer) {
          const parsed = parseOutputLine(buffer);
          if (parsed) yield parsed;
        }
      } finally {
        reader.releaseLock();
      }

      // After stream ends, fetch final process status for the exit code
      const statusResponse = await fetchFn(
        `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/process/${proc.pid}`,
        { signal },
      );
      if (statusResponse.ok) {
        const status =
          (await statusResponse.json()) as ProcessStatusResponse;
        finalExitCode = status.exitCode ?? 0;
      }
    }

    return {
      pid: proc.pid,
      get exitCode() {
        return finalExitCode;
      },
      output: streamOutput(),
    };
  }

  private async _pollProcess(
    pid: number,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const timeout = opts?.timeout ?? DEFAULT_EXEC_TIMEOUT;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const response = await this._fetch(
        `${this._baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/process/${pid}`,
        { signal: opts?.signal },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to poll process ${pid}: ${response.status} ${text}`,
        );
      }

      const status = (await response.json()) as ProcessStatusResponse;

      if (status.completed) {
        return {
          pid,
          exitCode: status.exitCode ?? 0,
          stdout: status.stdout ?? "",
          stderr: status.stderr ?? "",
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Process ${pid} timed out after ${timeout}ms`);
  }
}
