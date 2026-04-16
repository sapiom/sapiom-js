import { createFetch } from "@sapiom/fetch";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PART_SIZE,
  planParts,
  runWithConcurrency,
  toBlob,
} from "./multipart.js";
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
  MultipartInitiateResponse,
  MultipartPartInfo,
  MultipartUploadedPart,
  UploadFileOptions,
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
  // Strip leading slash so the URL path is well-formed, then encode each segment
  const cleanPath = absolutePath.startsWith("/")
    ? absolutePath.slice(1)
    : absolutePath;
  return `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/filesystem/${encodePathSegments(cleanPath)}`;
}

function multipartUrl(
  baseUrl: string,
  sandboxName: string,
  suffix: string,
): string {
  return `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/filesystem/multipart${suffix}`;
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

  /**
   * Presigned S3 upload URL for custom image builds.
   * Only present when the sandbox was created with `upload: true`.
   * Upload a ZIP containing a Dockerfile to this URL via PUT.
   */
  readonly uploadUrl?: string;

  private readonly _fetch: typeof globalThis.fetch;
  private readonly _baseUrl: string;

  private constructor(
    name: string,
    workspaceRoot: string,
    fetchFn: typeof globalThis.fetch,
    baseUrl: string,
    uploadUrl?: string,
  ) {
    this.name = name;
    this.workspaceRoot = workspaceRoot;
    this._fetch = fetchFn;
    this._baseUrl = baseUrl;
    if (uploadUrl) this.uploadUrl = uploadUrl;
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
    if (opts.image !== undefined && opts.upload) {
      throw new Error("Cannot specify both 'image' and 'upload'");
    }

    const body: Record<string, unknown> = { name: opts.name };
    if (opts.tier !== undefined) body.tier = opts.tier;
    if (opts.ttl !== undefined) body.ttl = opts.ttl;
    if (opts.envs !== undefined) body.envs = opts.envs;
    if (opts.port !== undefined) body.port = opts.port;
    if (opts.ports !== undefined) body.ports = opts.ports;
    if (opts.image !== undefined) body.image = opts.image;

    const url = opts.upload
      ? `${baseUrl}/v1/sandboxes?upload=true`
      : `${baseUrl}/v1/sandboxes`;

    const response = await fetchFn(url, {
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
    return new SapiomSandbox(data.name, data.workspaceRoot, fetchFn, baseUrl, data.uploadUrl);
  }

  /**
   * Write a file inside the sandbox.
   *
   * @param path - File path relative to workspaceRoot.
   * @param content - File content as a string.
   */
  async writeFile(path: string, content: string): Promise<void> {
    assertRelativePath(path);
    const url = fileUrl(this._baseUrl, this.name, path);

    const response = await this._fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
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
    assertRelativePath(path);
    const url = fileUrl(this._baseUrl, this.name, path);

    const response = await this._fetch(url);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to read file '${path}': ${response.status} ${text}`,
      );
    }

    const data = (await response.json()) as { content: string };
    return data.content;
  }

  /**
   * Upload a file to the sandbox using multipart upload.
   *
   * Handles the full initiate → part upload → complete lifecycle, with
   * parallel part uploads and automatic abort on any failure (including
   * `signal` aborts).
   *
   * Prefer this over {@link writeFile} for binary content or any file over
   * a few MB. `writeFile` stays available for small text files.
   *
   * @param path - File path relative to workspaceRoot.
   * @param content - Blob, Uint8Array, or string. Strings are UTF-8 encoded.
   * @param opts - Upload options.
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

      const uploaded = await runWithConcurrency(
        plans,
        concurrency,
        async (plan) => {
          const slice = blob.slice(plan.start, plan.end);
          const ack = await this.uploadPart(uploadId, plan.partNumber, slice, {
            signal: opts?.signal,
          });
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
   * Initiate a multipart upload for a file path.
   *
   * Low-level: prefer {@link uploadFile} for the full lifecycle. Use this
   * when you need custom retry/progress/resumable behavior.
   */
  async initiateMultipartUpload(
    path: string,
    opts?: { permissions?: string; signal?: AbortSignal },
  ): Promise<MultipartInitiateResponse> {
    assertRelativePath(path);
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    const url = multipartUrl(
      this._baseUrl,
      this.name,
      `/initiate/${encodePathSegments(cleanPath)}`,
    );

    const body: Record<string, unknown> = {};
    if (opts?.permissions !== undefined) body.permissions = opts.permissions;

    const response = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to initiate multipart upload for '${path}': ${response.status} ${text}`,
      );
    }

    return (await response.json()) as MultipartInitiateResponse;
  }

  /**
   * Upload a single part of a multipart upload.
   *
   * Low-level: prefer {@link uploadFile} for the full lifecycle.
   *
   * @param uploadId - Upload session ID from {@link initiateMultipartUpload}.
   * @param partNumber - 1-indexed part number (1 to 10000).
   * @param part - The part bytes.
   */
  async uploadPart(
    uploadId: string,
    partNumber: number,
    part: Blob | Uint8Array,
    opts?: { signal?: AbortSignal },
  ): Promise<MultipartUploadedPart> {
    const url =
      multipartUrl(
        this._baseUrl,
        this.name,
        `/${encodeURIComponent(uploadId)}/part`,
      ) + `?partNumber=${encodeURIComponent(String(partNumber))}`;

    const form = new FormData();
    form.append("file", part instanceof Blob ? part : new Blob([part]));

    // Intentionally no Content-Type header — fetch sets the multipart
    // boundary automatically.
    const response = await this._fetch(url, {
      method: "PUT",
      body: form,
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to upload part ${partNumber} for upload '${uploadId}': ${response.status} ${text}`,
      );
    }

    return (await response.json()) as MultipartUploadedPart;
  }

  /**
   * Complete a multipart upload by committing the uploaded parts.
   *
   * Low-level: prefer {@link uploadFile} for the full lifecycle.
   */
  async completeMultipartUpload(
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ message: string; path: string }> {
    const url = multipartUrl(
      this._baseUrl,
      this.name,
      `/${encodeURIComponent(uploadId)}/complete`,
    );

    const response = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to complete multipart upload '${uploadId}': ${response.status} ${text}`,
      );
    }

    return (await response.json()) as { message: string; path: string };
  }

  /**
   * Abort a multipart upload and clean up any uploaded parts on the server.
   */
  async abortMultipartUpload(
    uploadId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const url = multipartUrl(
      this._baseUrl,
      this.name,
      `/${encodeURIComponent(uploadId)}`,
    );

    const response = await this._fetch(url, {
      method: "DELETE",
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to abort multipart upload '${uploadId}': ${response.status} ${text}`,
      );
    }
  }

  /**
   * List the parts already uploaded for a multipart upload.
   *
   * Useful for resumable uploads: after reconnecting, call this to see
   * which part numbers you still need to upload.
   */
  async listMultipartParts(
    uploadId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<MultipartPartInfo[]> {
    const url = multipartUrl(
      this._baseUrl,
      this.name,
      `/${encodeURIComponent(uploadId)}/parts`,
    );

    const response = await this._fetch(url, { signal: opts?.signal });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to list parts for multipart upload '${uploadId}': ${response.status} ${text}`,
      );
    }

    const data = (await response.json()) as {
      uploadId: string;
      parts: MultipartPartInfo[];
    };
    return data.parts;
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
    if (proc.status === "completed") {
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
    if (proc.status === "completed") {
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

      let status =
        (await statusResponse.json()) as ProcessStatusResponse;

      // If the process hasn't completed yet (e.g. stream disconnected
      // before the process finished), poll until it does.
      while (status.status !== "completed") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const retry = await fetchFn(
          `${baseUrl}/v1/sandboxes/${encodeURIComponent(sandboxName)}/process/${proc.pid}`,
          { signal },
        );
        if (!retry.ok) {
          const text = await retry.text();
          throw new Error(
            `Failed to get final status for process ${proc.pid}: ${retry.status} ${text}`,
          );
        }
        status = (await retry.json()) as ProcessStatusResponse;
      }

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
  async getProcess(pid: string): Promise<ProcessStatusResponse> {
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
    pid: string,
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
    opts?: ExecStreamOptions & { keepAlive?: boolean; processTimeout?: number },
  ): Promise<ProcessCreateResponse> {
    const body: Record<string, unknown> = { command };
    if (opts?.cwd !== undefined) {
      body.cwd = resolvePath(this.workspaceRoot, opts.cwd);
    }
    if (opts?.env !== undefined) body.env = opts.env;
    if (opts?.keepAlive !== undefined) body.keepAlive = opts.keepAlive;
    if (opts?.processTimeout !== undefined) body.timeout = opts.processTimeout;

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
    pid: string,
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

      if (status.status === "completed") {
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
