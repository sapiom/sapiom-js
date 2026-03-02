import { createFetch } from "@sapiom/fetch";
import type {
  SandboxCreateOptions,
  SandboxCreateResponse,
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
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

function parseOutputLine(line: string): OutputLine {
  if (line.startsWith("stdout:")) {
    return { stream: "stdout", data: line.slice(7) };
  }
  if (line.startsWith("stderr:")) {
    return { stream: "stderr", data: line.slice(7) };
  }
  // Unrecognized framing — treat as stdout rather than dropping
  return { stream: "stdout", data: line };
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

    if (opts.port !== undefined && opts.ports !== undefined) {
      throw new Error("Cannot specify both 'port' and 'ports'");
    }

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
   * Execute a command in the sandbox.
   *
   * By default waits for the process to finish (polls process status).
   * Set `opts.waitForCompletion = false` for fire-and-forget execution.
   * Use {@link execStream} for real-time streaming output.
   *
   * @param command - The shell command to run.
   * @param opts - Execution options.
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
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
   * Execute a command and stream its output in real time.
   *
   * Returns a {@link StreamingExecResult} whose `output` property is an
   * async iterable of {@link OutputLine} objects. `exitCode` is populated
   * after the iterable is fully consumed.
   *
   * @param command - The shell command to run.
   * @param opts - Stream execution options.
   */
  async execStream(
    command: string,
    opts?: ExecStreamOptions,
  ): Promise<StreamingExecResult> {
    const proc = await this._createProcess(command, opts);

    // If the process already completed synchronously, return without
    // opening the log stream — yield the stdout/stderr from the create
    // response directly.
    if (proc.completed) {
      const code = proc.exitCode ?? 0;
      const stdout = proc.stdout ?? "";
      const stderr = proc.stderr ?? "";
      const output = (async function* (): AsyncGenerator<OutputLine> {
        if (stdout) yield { stream: "stdout" as const, data: stdout };
        if (stderr) yield { stream: "stderr" as const, data: stderr };
      })();
      return {
        pid: proc.pid,
        get exitCode() {
          return code;
        },
        output,
      };
    }

    let finalExitCode = -1;

    // Capture references for the generator closure
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
            yield parseOutputLine(line);
          }
        }

        // Flush remaining multibyte bytes from the decoder
        buffer += decoder.decode();

        if (buffer) {
          yield parseOutputLine(buffer);
        }
      } finally {
        reader.releaseLock();
      }

      // Fetch final process status for the exit code
      const statusResponse = await fetchFn(
        `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/process/${proc.pid}`,
        { signal },
      );

      if (!statusResponse.ok) {
        const text = await statusResponse.text();
        throw new Error(
          `Failed to get final status for process ${proc.pid}: ${statusResponse.status} ${text}`,
        );
      }

      const status =
        (await statusResponse.json()) as ProcessStatusResponse;
      finalExitCode = status.exitCode ?? 0;
    }

    return {
      pid: proc.pid,
      get exitCode() {
        return finalExitCode;
      },
      output: streamOutput(),
    };
  }

  /**
   * Get the current status of a process by PID.
   *
   * Useful for checking on processes started with
   * `exec(cmd, { waitForCompletion: false })`.
   *
   * @param pid - The process ID returned from exec.
   */
  async getProcess(pid: number): Promise<ProcessStatusResponse> {
    const response = await this._fetch(
      `${this._baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/process/${pid}`,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to get process ${pid}: ${response.status} ${text}`,
      );
    }

    return (await response.json()) as ProcessStatusResponse;
  }

  /**
   * Wait for a process to complete by polling its status.
   *
   * Useful for processes started with
   * `exec(cmd, { waitForCompletion: false })`.
   *
   * @param pid - The process ID returned from exec.
   * @param opts - Polling options.
   */
  async waitForProcess(
    pid: number,
    opts?: { pollInterval?: number; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    return this._pollProcess(pid, opts);
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
    opts?: ExecStreamOptions,
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

  private async _pollProcess(
    pid: number,
    opts?: { pollInterval?: number; timeout?: number; signal?: AbortSignal },
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
