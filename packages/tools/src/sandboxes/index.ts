/**
 * `sandbox` capability — an isolated, ephemeral compute instance for running code
 * or agents securely: create, exec (sync / fire-and-forget / streaming), read &
 * write files, then destroy. Ported from the legacy `@sapiom/sandbox` onto the
 * `_client` transport, with the Blaxel specifics removed:
 *   - auth comes from the transport (ambient or explicit), not per-call apiKey
 *   - the host is a platform routing detail (overridable), not a "blaxel" concept
 *   - custom image build (the Blaxel-runtime Dockerfile) is deferred, not exposed
 *
 *   import { sandbox } from "@sapiom/tools";          // ambient auth
 *   const box = await sandbox.create({ name: "demo" });
 *   const { stdout } = await box.exec("echo hi");
 *   await box.destroy();
 */
import { Transport, defaultTransport } from "../_client/index.js";
import type {
  CreateResponse,
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  OutputLine,
  ProcessCreateResponse,
  ProcessStatus,
  SandboxCreateOptions,
  StreamingExecResult,
} from "./types.js";

export type {
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  OutputLine,
  PortSpec,
  ProcessStatus,
  SandboxCreateOptions,
  SandboxTier,
  StreamingExecResult,
} from "./types.js";

/** Platform sandbox service. Host routing is an internal detail — override via `baseUrl` or SAPIOM_SANDBOX_URL. */
const DEFAULT_BASE_URL = process.env.SAPIOM_SANDBOX_URL || "https://blaxel.services.sapiom.ai";
const DEFAULT_POLL_INTERVAL = 1000;
const DEFAULT_EXEC_TIMEOUT = 60_000;

function assertRelativePath(path: string): void {
  if (path.split("/").some((seg) => seg === "..")) {
    throw new Error(`Path must not contain '..' segments: ${path}`);
  }
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function parseOutputLine(line: string): OutputLine {
  if (line.startsWith("stdout:")) return { stream: "stdout", data: line.slice(7) };
  if (line.startsWith("stderr:")) return { stream: "stderr", data: line.slice(7) };
  return { stream: "stdout", data: line }; // unrecognized framing — keep, don't drop
}

/** A live sandbox handle. Create via {@link create}; pass between steps to share state. */
export class Sandbox {
  /** Name / identifier of the sandbox. */
  readonly name: string;
  /** Absolute workspace root path inside the sandbox. */
  readonly workspaceRoot: string;

  private readonly transport: Transport;
  private readonly baseUrl: string;

  private constructor(name: string, workspaceRoot: string, transport: Transport, baseUrl: string) {
    this.name = name;
    this.workspaceRoot = workspaceRoot;
    this.transport = transport;
    this.baseUrl = baseUrl;
  }

  /** Create a sandbox and return a handle. Uses the ambient transport unless one is supplied. */
  static async create(opts: SandboxCreateOptions, transport: Transport = defaultTransport()): Promise<Sandbox> {
    if (opts.port !== undefined && opts.ports !== undefined) {
      throw new Error("Cannot specify both 'port' and 'ports'");
    }
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

    const body: Record<string, unknown> = { name: opts.name };
    if (opts.tier !== undefined) body.tier = opts.tier;
    if (opts.ttl !== undefined) body.ttl = opts.ttl;
    if (opts.envs !== undefined) body.envs = opts.envs;
    if (opts.port !== undefined) body.port = opts.port;
    if (opts.ports !== undefined) body.ports = opts.ports;
    if (opts.image !== undefined) body.image = opts.image;

    const res = await transport.fetch(`${baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create sandbox: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as CreateResponse;
    return new Sandbox(data.name, data.workspaceRoot, transport, baseUrl);
  }

  /** Adopt an existing sandbox by name (e.g. one a prior step kept). */
  static attach(name: string, opts: { workspaceRoot?: string; baseUrl?: string } = {}, transport: Transport = defaultTransport()): Sandbox {
    return new Sandbox(name, opts.workspaceRoot ?? "/", transport, opts.baseUrl ?? DEFAULT_BASE_URL);
  }

  private fileUrl(path: string): string {
    assertRelativePath(path);
    const base = this.workspaceRoot.endsWith("/") ? this.workspaceRoot.slice(0, -1) : this.workspaceRoot;
    const rel = path.startsWith("/") ? path.slice(1) : path;
    const abs = `${base}/${rel}`.replace(/^\//, "");
    return `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/filesystem/${encodePathSegments(abs)}`;
  }

  private procUrl(suffix = ""): string {
    return `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/process${suffix}`;
  }

  /** Write a file (path relative to the workspace root). */
  async writeFile(path: string, content: string): Promise<void> {
    const res = await this.transport.fetch(this.fileUrl(path), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`Failed to write file '${path}': ${res.status} ${await res.text()}`);
  }

  /** Read a file (path relative to the workspace root). */
  async readFile(path: string): Promise<string> {
    const res = await this.transport.fetch(this.fileUrl(path));
    if (!res.ok) throw new Error(`Failed to read file '${path}': ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { content: string };
    return data.content;
  }

  /**
   * Execute a command. Waits for completion by default; set `waitForCompletion:
   * false` for fire-and-forget, or use {@link execStream} for real-time output.
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const proc = await this.createProcess(command, opts);
    if (proc.status === "completed") {
      return { pid: proc.pid, exitCode: proc.exitCode ?? 0, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
    }
    if (opts?.waitForCompletion === false) {
      return { pid: proc.pid, exitCode: -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
    }
    return this.pollProcess(proc.pid, opts);
  }

  /** Execute a command and stream output lines in real time. `exitCode` populates after `output` drains. */
  async execStream(command: string, opts?: ExecStreamOptions): Promise<StreamingExecResult> {
    const proc = await this.createProcess(command, opts);

    if (proc.status === "completed") {
      const code = proc.exitCode ?? 0;
      const stdout = proc.stdout ?? "";
      const stderr = proc.stderr ?? "";
      const output = (async function* (): AsyncGenerator<OutputLine> {
        if (stdout) yield { stream: "stdout", data: stdout };
        if (stderr) yield { stream: "stderr", data: stderr };
      })();
      return { pid: proc.pid, get exitCode() { return code; }, output };
    }

    let finalExitCode = -1;
    const transport = this.transport;
    const signal = opts?.signal;
    const logsUrl = this.procUrl(`/${proc.pid}/logs/stream`);
    const statusUrl = this.procUrl(`/${proc.pid}`);

    async function* streamOutput(): AsyncGenerator<OutputLine> {
      const res = await transport.fetch(logsUrl, { signal });
      if (!res.ok) throw new Error(`Failed to stream process ${proc.pid}: ${res.status} ${await res.text()}`);
      if (!res.body) throw new Error(`No response body for process ${proc.pid} log stream`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) if (line) yield parseOutputLine(line);
        }
        buffer += decoder.decode();
        if (buffer) yield parseOutputLine(buffer);
      } finally {
        reader.releaseLock();
      }

      let status = await readStatus();
      while (status.status !== "completed") {
        await new Promise((r) => setTimeout(r, 1000));
        status = await readStatus();
      }
      finalExitCode = status.exitCode ?? 0;

      async function readStatus(): Promise<ProcessStatus> {
        const s = await transport.fetch(statusUrl, { signal });
        if (!s.ok) throw new Error(`Failed to get final status for process ${proc.pid}: ${s.status} ${await s.text()}`);
        return (await s.json()) as ProcessStatus;
      }
    }

    return { pid: proc.pid, get exitCode() { return finalExitCode; }, output: streamOutput() };
  }

  /** Current status of a process by PID (useful for fire-and-forget execs). */
  async getProcess(pid: string): Promise<ProcessStatus> {
    const res = await this.transport.fetch(this.procUrl(`/${pid}`));
    if (!res.ok) throw new Error(`Failed to get process ${pid}: ${res.status} ${await res.text()}`);
    return (await res.json()) as ProcessStatus;
  }

  /** Wait for a process to finish by polling its status. */
  async waitForProcess(pid: string, opts?: { pollInterval?: number; timeout?: number; signal?: AbortSignal }): Promise<ExecResult> {
    return this.pollProcess(pid, opts);
  }

  /** Destroy the sandbox and release its resources. */
  async destroy(): Promise<void> {
    const res = await this.transport.fetch(`${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to destroy sandbox: ${res.status} ${await res.text()}`);
  }

  // --- internal ---

  private async createProcess(command: string, opts?: ExecOptions): Promise<ProcessCreateResponse> {
    const body: Record<string, unknown> = { command };
    if (opts?.cwd !== undefined) {
      assertRelativePath(opts.cwd);
      const base = this.workspaceRoot.endsWith("/") ? this.workspaceRoot.slice(0, -1) : this.workspaceRoot;
      body.cwd = `${base}/${opts.cwd.startsWith("/") ? opts.cwd.slice(1) : opts.cwd}`;
    }
    if (opts?.env !== undefined) body.env = opts.env;
    if (opts?.keepAlive !== undefined) body.keepAlive = opts.keepAlive;
    if (opts?.processTimeout !== undefined) body.timeout = opts.processTimeout;

    const res = await this.transport.fetch(this.procUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) throw new Error(`Failed to execute command: ${res.status} ${await res.text()}`);
    return (await res.json()) as ProcessCreateResponse;
  }

  private async pollProcess(pid: string, opts?: { pollInterval?: number; timeout?: number; signal?: AbortSignal }): Promise<ExecResult> {
    const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const deadline = Date.now() + (opts?.timeout ?? DEFAULT_EXEC_TIMEOUT);
    while (Date.now() < deadline) {
      const res = await this.transport.fetch(this.procUrl(`/${pid}`), { signal: opts?.signal });
      if (!res.ok) throw new Error(`Failed to poll process ${pid}: ${res.status} ${await res.text()}`);
      const status = (await res.json()) as ProcessStatus;
      if (status.status === "completed") {
        return { pid, exitCode: status.exitCode ?? 0, stdout: status.stdout ?? "", stderr: status.stderr ?? "" };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new Error(`Process ${pid} timed out after ${opts?.timeout ?? DEFAULT_EXEC_TIMEOUT}ms`);
  }
}

/** Create a sandbox (ambient transport). The namespace's primary entry point. */
export function create(opts: SandboxCreateOptions): Promise<Sandbox> {
  return Sandbox.create(opts);
}

/** Adopt an existing sandbox by name (ambient transport). */
export function attach(name: string, opts?: { workspaceRoot?: string; baseUrl?: string }): Sandbox {
  return Sandbox.attach(name, opts);
}
