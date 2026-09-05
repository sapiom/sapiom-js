import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_BYTES = 8_192;

export interface OpenCodeCommand {
  executable: string;
  prefixArgs?: string[];
}

export interface StartOpenCodeServerOptions {
  command?: OpenCodeCommand;
  cwd: string;
  stateRoot: string;
  config?: Record<string, unknown>;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface OpenCodeHealth {
  healthy: true;
  version: string;
}

export interface OpenCodeServer {
  origin: string;
  port: number;
  pid: number;
  health: OpenCodeHealth;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

export class OpenCodeStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeStartupError";
  }
}

interface ExitState {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export async function startOpenCodeServer(
  options: StartOpenCodeServerOptions,
): Promise<OpenCodeServer> {
  const command = options.command ?? {
    executable: resolveBundledOpenCodeBinary(),
  };
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const username = "opencode";
  const password = randomBytes(32).toString("hex");
  const authorization =
    "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  const directories = {
    config: join(options.stateRoot, "config"),
    data: join(options.stateRoot, "data"),
    cache: join(options.stateRoot, "cache"),
    state: join(options.stateRoot, "state"),
  };
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

  const child = spawn(
    command.executable,
    [
      ...(command.prefixArgs ?? []),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--pure",
    ],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.environment,
        XDG_CONFIG_HOME: directories.config,
        XDG_DATA_HOME: directories.data,
        XDG_CACHE_HOME: directories.cache,
        XDG_STATE_HOME: directories.state,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let stderr = "";
  let exitState: ExitState | undefined;
  child.stderr.setEncoding("utf8");
  child.stdout.resume();
  child.stdin.end();
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_BYTES);
  });
  child.once("exit", (code, signal) => {
    exitState = { code, signal };
  });
  child.once("error", (error) => {
    exitState = { code: null, signal: null, error };
  });

  const authenticatedFetch = (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization);
    return fetch(new URL(path, origin), { ...init, headers });
  };

  try {
    const health = await waitUntilHealthy(
      authenticatedFetch,
      () => exitState,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("OpenCode child started without a process id");
    }

    const close = createClose(
      child,
      () => exitState,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );

    return {
      origin,
      port,
      pid,
      health,
      fetch: authenticatedFetch,
      async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await authenticatedFetch(path, init);
        if (!response.ok) {
          throw new Error(
            `OpenCode request failed: ${response.status} ${response.statusText}`,
          );
        }
        return (await response.json()) as T;
      },
      close,
    };
  } catch (error) {
    await createClose(child, () => exitState, DEFAULT_SHUTDOWN_TIMEOUT_MS)();
    const detail = stderr.trim();
    const reason =
      detail.length > 0
        ? detail
        : error instanceof Error
          ? error.message
          : String(error);
    throw new OpenCodeStartupError(
      `OpenCode failed to become healthy: ${reason}`,
    );
  }
}

export function resolveBundledOpenCodeBinary(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("opencode-ai/package.json");
  return join(dirname(packageJson), "bin", "opencode.exe");
}

async function waitUntilHealthy(
  authenticatedFetch: (path: string) => Promise<Response>,
  getExitState: () => ExitState | undefined,
  timeoutMs: number,
): Promise<OpenCodeHealth> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const exitState = getExitState();
    if (exitState !== undefined) {
      throw new Error(formatExit(exitState));
    }

    try {
      const response = await authenticatedFetch("/global/health");
      if (response.ok) {
        const health = (await response.json()) as Partial<OpenCodeHealth>;
        if (health.healthy === true && typeof health.version === "string") {
          return health as OpenCodeHealth;
        }
      }
    } catch {
      // Connection failures are expected while the child starts listening.
    }

    await delay(50);
  }

  throw new Error(`startup timed out after ${timeoutMs}ms`);
}

function createClose(
  child: ChildProcessWithoutNullStreams,
  getExitState: () => ExitState | undefined,
  timeoutMs: number,
): () => Promise<void> {
  let closing: Promise<void> | undefined;

  return () => {
    if (closing !== undefined) return closing;
    closing = closeChild(child, getExitState, timeoutMs);
    return closing;
  };
}

async function closeChild(
  child: ChildProcessWithoutNullStreams,
  getExitState: () => ExitState | undefined,
  timeoutMs: number,
): Promise<void> {
  if (getExitState() !== undefined) return;

  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");

  const graceful = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (graceful) return;

  child.kill("SIGKILL");
  await exited;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve an OpenCode port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function formatExit(exit: ExitState): string {
  if (exit.error !== undefined)
    return `child failed to spawn: ${exit.error.message}`;
  if (exit.signal !== null) return `child exited from ${exit.signal}`;
  return `child exited with code ${exit.code ?? "unknown"}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
