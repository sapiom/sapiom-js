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
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PART_SIZE,
  DEFAULT_RETRY_BASE_DELAY_MS,
  ensureOk,
  planParts,
  runWithConcurrency,
  toBlob,
  withRetry,
} from "./multipart.js";
import type {
  CreateResponse,
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  MultipartInitiateResponse,
  MultipartPartInfo,
  MultipartUploadedPart,
  OutputLine,
  ProcessCreateResponse,
  ProcessStatus,
  SandboxCreateOptions,
  StreamingExecResult,
  UploadFileOptions,
} from "./types.js";

export { SandboxHttpError } from "./multipart.js";

export type {
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  MultipartInitiateResponse,
  MultipartPartInfo,
  MultipartUploadedPart,
  OutputLine,
  PortSpec,
  ProcessStatus,
  SandboxCreateOptions,
  SandboxTier,
  StreamingExecResult,
  UploadFileOptions,
  UploadProgress,
} from "./types.js";

/** Platform sandbox service. Host routing is an internal detail — override via `baseUrl` or SAPIOM_SANDBOX_URL. */
const DEFAULT_BASE_URL =
  process.env.SAPIOM_SANDBOX_URL || "https://blaxel.services.sapiom.ai";
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
  if (line.startsWith("stdout:"))
    return { stream: "stdout", data: line.slice(7) };
  if (line.startsWith("stderr:"))
    return { stream: "stderr", data: line.slice(7) };
  return { stream: "stdout", data: line }; // unrecognized framing — keep, don't drop
}

/**
 * Process statuses that mean the process has finished. The Blaxel sandbox-api
 * reports a non-zero exit as `"failed"` (enum: running/completed/failed/killed/
 * stopped), so polling must treat all of these — not just `"completed"` — as
 * done. Any unrecognized status keeps polling and ultimately hits the exec
 * timeout, which is a loud, debuggable failure rather than a silent wrong result.
 */
const TERMINAL_PROCESS_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "stopped",
]);

function isProcessTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_PROCESS_STATUSES.has(status);
}

/**
 * Resolve a process exit code. A non-`"completed"` terminal status
 * (failed/killed/stopped) that omits `exitCode` must not report success, so it
 * defaults to a non-zero code.
 */
function terminalExitCode(s: { status: string; exitCode?: number }): number {
  return s.exitCode ?? (s.status === "completed" ? 0 : 1);
}

function toExecResult(
  pid: string,
  s: { status: string; exitCode?: number; stdout?: string; stderr?: string },
): ExecResult {
  return {
    pid,
    exitCode: terminalExitCode(s),
    stdout: s.stdout ?? "",
    stderr: s.stderr ?? "",
  };
}

/** A live sandbox handle. Create via {@link create}; pass between steps to share state. */
export class Sandbox {
  /** Name / identifier of the sandbox. */
  readonly name: string;
  /** Absolute workspace root path inside the sandbox. */
  readonly workspaceRoot: string;

  private readonly transport: Transport;
  private readonly baseUrl: string;

  private constructor(
    name: string,
    workspaceRoot: string,
    transport: Transport,
    baseUrl: string,
  ) {
    this.name = name;
    this.workspaceRoot = workspaceRoot;
    this.transport = transport;
    this.baseUrl = baseUrl;
  }

  /** Create a sandbox and return a handle. Uses the ambient transport unless one is supplied. */
  static async create(
    opts: SandboxCreateOptions,
    transport: Transport = defaultTransport(),
  ): Promise<Sandbox> {
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
    if (!res.ok)
      throw new Error(
        `Failed to create sandbox: ${res.status} ${await res.text()}`,
      );

    const data = (await res.json()) as CreateResponse;
    return new Sandbox(data.name, data.workspaceRoot, transport, baseUrl);
  }

  /** Adopt an existing sandbox by name (e.g. one a prior step kept). */
  static attach(
    name: string,
    opts: { workspaceRoot?: string; baseUrl?: string } = {},
    transport: Transport = defaultTransport(),
  ): Sandbox {
    return new Sandbox(
      name,
      opts.workspaceRoot ?? "/",
      transport,
      opts.baseUrl ?? DEFAULT_BASE_URL,
    );
  }

  private fileUrl(path: string): string {
    assertRelativePath(path);
    const base = this.workspaceRoot.endsWith("/")
      ? this.workspaceRoot.slice(0, -1)
      : this.workspaceRoot;
    const rel = path.startsWith("/") ? path.slice(1) : path;
    const abs = `${base}/${rel}`.replace(/^\//, "");
    return `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/filesystem/${encodePathSegments(abs)}`;
  }

  private procUrl(suffix = ""): string {
    return `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/process${suffix}`;
  }

  private multipartUrl(suffix: string): string {
    return `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}/filesystem/multipart${suffix}`;
  }

  /** Write a file (path relative to the workspace root). */
  async writeFile(path: string, content: string): Promise<void> {
    const res = await this.transport.fetch(this.fileUrl(path), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok)
      throw new Error(
        `Failed to write file '${path}': ${res.status} ${await res.text()}`,
      );
  }

  /** Read a file (path relative to the workspace root). */
  async readFile(path: string): Promise<string> {
    const res = await this.transport.fetch(this.fileUrl(path));
    if (!res.ok)
      throw new Error(
        `Failed to read file '${path}': ${res.status} ${await res.text()}`,
      );
    const data = (await res.json()) as { content: string };
    return data.content;
  }

  /**
   * Upload a file using multipart upload. Handles the full initiate → part
   * upload → complete lifecycle, with parallel part uploads and automatic abort
   * on any failure (including `signal` aborts).
   *
   * Prefer this over {@link writeFile} for binary content or any file over a few
   * MB — `writeFile` sends the whole body in one request and is bounded by the
   * ingress body-size ceiling. `content` may be a Blob, Uint8Array, or string
   * (strings are UTF-8 encoded).
   */
  async uploadFile(
    path: string,
    content: Blob | Uint8Array | string,
    opts?: UploadFileOptions,
  ): Promise<void> {
    assertRelativePath(path);

    const blob = toBlob(content);
    const partSize = opts?.partSize ?? DEFAULT_PART_SIZE;
    const concurrency = opts?.concurrency ?? DEFAULT_CONCURRENCY;
    const totalBytes = blob.size;
    const plans = planParts(totalBytes, partSize);

    const { uploadId } = await this.initiateMultipartUpload(path, {
      permissions: opts?.permissions,
      signal: opts?.signal,
    });

    try {
      let partsUploaded = 0;
      let bytesUploaded = 0;

      const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
      const retryBaseDelayMs =
        opts?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

      const uploaded = await runWithConcurrency(
        plans,
        concurrency,
        async (plan) => {
          const slice = blob.slice(plan.start, plan.end);
          const ack = await withRetry(
            () =>
              this.uploadPart(uploadId, plan.partNumber, slice, {
                signal: opts?.signal,
              }),
            {
              maxRetries,
              retryBaseDelayMs,
              signal: opts?.signal,
            },
          );
          partsUploaded += 1;
          bytesUploaded += ack.size;
          opts?.onPartUploaded?.(ack, {
            partsUploaded,
            totalParts: plans.length,
            bytesUploaded,
            totalBytes,
          });
          return ack;
        },
      );

      const parts = uploaded
        .map(({ partNumber, etag }) => ({ partNumber, etag }))
        .sort((a, b) => a.partNumber - b.partNumber);

      await this.completeMultipartUpload(uploadId, parts, {
        signal: opts?.signal,
      });
    } catch (err) {
      // Best-effort cleanup; don't mask the original error.
      this.abortMultipartUpload(uploadId).catch(() => {});
      throw err;
    }
  }

  /**
   * Initiate a multipart upload for a file path. Low-level: prefer
   * {@link uploadFile} for the full lifecycle.
   */
  async initiateMultipartUpload(
    path: string,
    opts?: { permissions?: string; signal?: AbortSignal },
  ): Promise<MultipartInitiateResponse> {
    assertRelativePath(path);
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    const url = this.multipartUrl(`/initiate/${encodePathSegments(cleanPath)}`);

    const body: Record<string, unknown> = {};
    if (opts?.permissions !== undefined) body.permissions = opts.permissions;

    const res = await ensureOk(
      await this.transport.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts?.signal,
      }),
      `Failed to initiate multipart upload for '${path}'`,
    );
    return (await res.json()) as MultipartInitiateResponse;
  }

  /**
   * Upload a single part of a multipart upload. Low-level: prefer
   * {@link uploadFile} for the full lifecycle.
   */
  async uploadPart(
    uploadId: string,
    partNumber: number,
    part: Blob | Uint8Array,
    opts?: { signal?: AbortSignal },
  ): Promise<MultipartUploadedPart> {
    const url =
      this.multipartUrl(`/${encodeURIComponent(uploadId)}/part`) +
      `?partNumber=${encodeURIComponent(String(partNumber))}`;

    const form = new FormData();
    form.append("file", part instanceof Blob ? part : new Blob([part]));

    // Intentionally no Content-Type header — fetch sets the multipart boundary.
    const res = await ensureOk(
      await this.transport.fetch(url, {
        method: "PUT",
        body: form,
        signal: opts?.signal,
      }),
      `Failed to upload part ${partNumber} for upload '${uploadId}'`,
    );
    return (await res.json()) as MultipartUploadedPart;
  }

  /**
   * Complete a multipart upload by committing the uploaded parts. Low-level:
   * prefer {@link uploadFile} for the full lifecycle.
   */
  async completeMultipartUpload(
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ message: string; path: string }> {
    const url = this.multipartUrl(`/${encodeURIComponent(uploadId)}/complete`);
    const res = await ensureOk(
      await this.transport.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
        signal: opts?.signal,
      }),
      `Failed to complete multipart upload '${uploadId}'`,
    );
    return (await res.json()) as { message: string; path: string };
  }

  /** Abort a multipart upload and clean up any uploaded parts on the server. */
  async abortMultipartUpload(
    uploadId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const url = this.multipartUrl(`/${encodeURIComponent(uploadId)}`);
    await ensureOk(
      await this.transport.fetch(url, {
        method: "DELETE",
        signal: opts?.signal,
      }),
      `Failed to abort multipart upload '${uploadId}'`,
    );
  }

  /**
   * List the parts already uploaded for a multipart upload. Useful for resumable
   * uploads: after reconnecting, call this to see which part numbers remain.
   */
  async listMultipartParts(
    uploadId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<MultipartPartInfo[]> {
    const url = this.multipartUrl(`/${encodeURIComponent(uploadId)}/parts`);
    const res = await ensureOk(
      await this.transport.fetch(url, { signal: opts?.signal }),
      `Failed to list parts for multipart upload '${uploadId}'`,
    );
    const data = (await res.json()) as {
      uploadId: string;
      parts: MultipartPartInfo[];
    };
    return data.parts;
  }

  /**
   * Execute a command. Waits for completion by default; set `waitForCompletion:
   * false` for fire-and-forget, or use {@link execStream} for real-time output.
   */
  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const proc = await this.createProcess(command, opts);
    // Process finished synchronously (any terminal status, incl. a non-zero exit).
    if (isProcessTerminal(proc.status)) {
      return toExecResult(proc.pid, proc);
    }
    if (opts?.waitForCompletion === false) {
      return {
        pid: proc.pid,
        exitCode: -1,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
      };
    }
    return this.pollProcess(proc.pid, opts);
  }

  /** Execute a command and stream output lines in real time. `exitCode` populates after `output` drains. */
  async execStream(
    command: string,
    opts?: ExecStreamOptions,
  ): Promise<StreamingExecResult> {
    const proc = await this.createProcess(command, opts);

    if (isProcessTerminal(proc.status)) {
      const code = terminalExitCode(proc);
      const stdout = proc.stdout ?? "";
      const stderr = proc.stderr ?? "";
      const output = (async function* (): AsyncGenerator<OutputLine> {
        if (stdout) yield { stream: "stdout", data: stdout };
        if (stderr) yield { stream: "stderr", data: stderr };
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
    const transport = this.transport;
    const signal = opts?.signal;
    const logsUrl = this.procUrl(`/${proc.pid}/logs/stream`);
    const statusUrl = this.procUrl(`/${proc.pid}`);

    async function* streamOutput(): AsyncGenerator<OutputLine> {
      const res = await transport.fetch(logsUrl, { signal });
      if (!res.ok)
        throw new Error(
          `Failed to stream process ${proc.pid}: ${res.status} ${await res.text()}`,
        );
      if (!res.body)
        throw new Error(`No response body for process ${proc.pid} log stream`);

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
      while (!isProcessTerminal(status.status)) {
        await new Promise((r) => setTimeout(r, 1000));
        status = await readStatus();
      }
      finalExitCode = terminalExitCode(status);

      async function readStatus(): Promise<ProcessStatus> {
        const s = await transport.fetch(statusUrl, { signal });
        if (!s.ok)
          throw new Error(
            `Failed to get final status for process ${proc.pid}: ${s.status} ${await s.text()}`,
          );
        return (await s.json()) as ProcessStatus;
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

  /** Current status of a process by PID (useful for fire-and-forget execs). */
  async getProcess(pid: string): Promise<ProcessStatus> {
    const res = await this.transport.fetch(this.procUrl(`/${pid}`));
    if (!res.ok)
      throw new Error(
        `Failed to get process ${pid}: ${res.status} ${await res.text()}`,
      );
    return (await res.json()) as ProcessStatus;
  }

  /** Wait for a process to finish by polling its status. */
  async waitForProcess(
    pid: string,
    opts?: { pollInterval?: number; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    return this.pollProcess(pid, opts);
  }

  /** Destroy the sandbox and release its resources. */
  async destroy(): Promise<void> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(this.name)}`,
      { method: "DELETE" },
    );
    if (!res.ok)
      throw new Error(
        `Failed to destroy sandbox: ${res.status} ${await res.text()}`,
      );
  }

  // --- internal ---

  private async createProcess(
    command: string,
    opts?: ExecOptions,
  ): Promise<ProcessCreateResponse> {
    const body: Record<string, unknown> = { command };
    if (opts?.cwd !== undefined) {
      assertRelativePath(opts.cwd);
      const base = this.workspaceRoot.endsWith("/")
        ? this.workspaceRoot.slice(0, -1)
        : this.workspaceRoot;
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
    if (!res.ok)
      throw new Error(
        `Failed to execute command: ${res.status} ${await res.text()}`,
      );
    return (await res.json()) as ProcessCreateResponse;
  }

  private async pollProcess(
    pid: string,
    opts?: { pollInterval?: number; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const deadline = Date.now() + (opts?.timeout ?? DEFAULT_EXEC_TIMEOUT);
    while (Date.now() < deadline) {
      const res = await this.transport.fetch(this.procUrl(`/${pid}`), {
        signal: opts?.signal,
      });
      if (!res.ok)
        throw new Error(
          `Failed to poll process ${pid}: ${res.status} ${await res.text()}`,
        );
      const status = (await res.json()) as ProcessStatus;
      if (isProcessTerminal(status.status)) {
        return toExecResult(pid, status);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    throw new Error(
      `Process ${pid} timed out after ${opts?.timeout ?? DEFAULT_EXEC_TIMEOUT}ms`,
    );
  }
}

/** Create a sandbox (ambient transport). The namespace's primary entry point. */
export function create(opts: SandboxCreateOptions): Promise<Sandbox> {
  return Sandbox.create(opts);
}

/** Adopt an existing sandbox by name (ambient transport). */
export function attach(
  name: string,
  opts?: { workspaceRoot?: string; baseUrl?: string },
): Sandbox {
  return Sandbox.attach(name, opts);
}
