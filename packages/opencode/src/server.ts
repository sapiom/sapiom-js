import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface StartOpenCodeServerOptions {
  cwd: string;
  stateRoot: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  command?: { executable: string; prefixArgs?: string[] };
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface OpenCodeServer {
  pid: number;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

/** Tools receive platform necessities, never the host's provider/auth variables. */
function platformEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
  ]);
  for (const [key, value] of Object.entries(source))
    if (allowed.has(key.toUpperCase())) result[key] = value;
  return result;
}

export async function startOpenCodeServer(
  options: StartOpenCodeServerOptions,
): Promise<OpenCodeServer> {
  options.signal?.throwIfAborted();
  const command = options.command ?? {
    executable: join(
      dirname(
        createRequire(import.meta.url).resolve("opencode-ai/package.json"),
      ),
      "bin",
      "opencode.exe",
    ).replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2"),
  };
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const directories = Object.fromEntries(
    ["config", "data", "cache", "state"].map((name) => [
      `XDG_${name.toUpperCase()}_HOME`,
      join(options.stateRoot, name),
    ]),
  );
  await Promise.all(
    Object.values(directories).map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  options.signal?.throwIfAborted();
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
        ...platformEnvironment(options.environment ?? process.env),
        ...directories,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  // Raw diagnostics can contain configuration or provider credentials.
  child.stdout?.resume();
  child.stderr?.resume();
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const done = () => {
      exited = true;
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signalChild(child, "SIGTERM");
      if (!exited)
        await Promise.race([exit, delay(options.shutdownTimeoutMs ?? 2000)]);
      signalChild(child, "SIGKILL");
      if (!exited) await Promise.race([exit, delay(2000)]);
      if (!exited)
        throw new Error("OpenCode did not exit within the shutdown deadline");
    })());
  const authenticatedFetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(path, origin);
    if (!path.startsWith("/") || url.origin !== origin)
      throw new Error("Invalid OpenCode request path");
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("Accept-Encoding", "identity");
    return fetch(url, { ...init, headers, redirect: "error" });
  };
  const timeout = AbortSignal.timeout(options.startupTimeoutMs ?? 15000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (exited) throw new Error("OpenCode exited during startup");
      try {
        const response = await authenticatedFetch("/global/health", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        if (
          response.ok &&
          ((await response.json()) as { healthy?: boolean }).healthy === true
        )
          break;
      } catch {
        signal.throwIfAborted();
      }
      await delay(50, undefined, { signal });
    }
    if (!child.pid || exited) throw new Error("OpenCode exited during startup");
    return {
      pid: child.pid,
      fetch: authenticatedFetch,
      close,
      async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await authenticatedFetch(path, init);
        if (!response.ok) throw new Error("OpenCode request failed");
        return (await response.json()) as T;
      },
    };
  } catch {
    await close();
    throw new Error("OpenCode could not start. Please retry.");
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
