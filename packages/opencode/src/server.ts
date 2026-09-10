import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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
  exited: Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

/** The caller must retain its state-owner lock when process exit is unconfirmed. */
export class OpenCodeShutdownError extends Error {
  constructor() {
    super("OpenCode did not exit within the shutdown deadline");
  }
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

const runtimeCredentialKeys = [
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
] as const;
const toolHomeKeys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;

async function createCredentialIsolationPlugin(
  launchRoot: string,
  toolHomeEnvironment: NodeJS.ProcessEnv,
): Promise<{ pluginUrl: string; readyPath: string }> {
  const pluginPath = join(launchRoot, "credential-isolation.mjs");
  const readyPath = join(launchRoot, "credential-isolation.ready");
  const source = `import { writeFile } from "node:fs/promises";
const keys = ${JSON.stringify(runtimeCredentialKeys)};
const toolHomeKeys = ${JSON.stringify(toolHomeKeys)};
const toolHomeEnvironment = ${JSON.stringify(toolHomeEnvironment)};
export const SapiomCredentialIsolation = async () => {
  for (const key of keys) delete process.env[key];
  await writeFile(${JSON.stringify(readyPath)}, "ready\\n", { flag: "wx", mode: 0o600 });
  return {
    "shell.env": async (_input, output) => {
      for (const key of keys) {
        delete process.env[key];
        delete output.env[key];
      }
      for (const key of toolHomeKeys) delete output.env[key];
      Object.assign(output.env, toolHomeEnvironment);
    },
  };
};
`;
  await writeFile(pluginPath, source, { mode: 0o600 });
  return { pluginUrl: pathToFileURL(pluginPath).href, readyPath };
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
  await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  const launchRoot = await mkdtemp(join(options.stateRoot, "launch-"));
  const sourceEnvironment = options.environment ?? process.env;
  const platform = platformEnvironment(sourceEnvironment);
  const toolHomeEnvironment = Object.fromEntries(
    toolHomeKeys.flatMap((key) =>
      sourceEnvironment[key] === undefined
        ? []
        : [[key, sourceEnvironment[key]]],
    ),
  );
  const resolvedToolHome =
    sourceEnvironment.HOME ??
    sourceEnvironment.USERPROFILE ??
    (sourceEnvironment.HOMEDRIVE && sourceEnvironment.HOMEPATH
      ? `${sourceEnvironment.HOMEDRIVE}${sourceEnvironment.HOMEPATH}`
      : userInfo().homedir);
  toolHomeEnvironment.HOME ??= resolvedToolHome;
  toolHomeEnvironment.USERPROFILE ??= resolvedToolHome;
  const { pluginUrl, readyPath } = await createCredentialIsolationPlugin(
    launchRoot,
    toolHomeEnvironment,
  );
  const isolatedHome = join(launchRoot, "home");
  const directories = {
    XDG_CONFIG_HOME: join(launchRoot, "config"),
    ...Object.fromEntries(
      ["data", "cache", "state"].map((name) => [
        `XDG_${name.toUpperCase()}_HOME`,
        join(options.stateRoot, name),
      ]),
    ),
  };
  await Promise.all(
    [...Object.values(directories), isolatedHome].map((path) =>
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
    ],
    {
      cwd: options.cwd,
      env: {
        ...platform,
        HOME: isolatedHome,
        ...(process.platform === "win32" ? { USERPROFILE: isolatedHome } : {}),
        ...directories,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...options.config,
          plugin: [pluginUrl],
        }),
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        // Native discovery retains the complete MCP catalog without placing
        // every remote tool schema in every model request.
        OPENCODE_EXPERIMENTAL_CODE_MODE: "1",
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
      if (!exited) throw new OpenCodeShutdownError();
      await rm(launchRoot, { recursive: true, force: true }).catch(() => {});
    })().catch(() => {
      throw new OpenCodeShutdownError();
    }));
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
    // Loading the instance config also initializes the only allowed external
    // plugin. Its marker makes credential scrubbing fail closed.
    const configResponse = await authenticatedFetch("/config", { signal });
    const configLoaded = configResponse.ok;
    await configResponse.body?.cancel();
    if (!configLoaded)
      throw new Error("OpenCode credential isolation did not initialize");
    for (;;) {
      signal.throwIfAborted();
      try {
        await access(readyPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (exited)
        throw new Error("OpenCode exited during credential isolation");
      await delay(25, undefined, { signal });
    }
    // OpenCode 1.18.29 snapshots server credentials before loading plugins.
    // Verify that invariant so a runtime change cannot silently unprotect the
    // native admin API when the plugin removes its inherited environment.
    const rejected = await Promise.all([
      fetch(`${origin}/global/health`, {
        headers: { "Accept-Encoding": "identity" },
        redirect: "error",
        signal,
      }),
      fetch(`${origin}/global/health`, {
        headers: {
          Authorization: "Basic invalid",
          "Accept-Encoding": "identity",
        },
        redirect: "error",
        signal,
      }),
    ]);
    for (const response of rejected) {
      const wasRejected = !response.ok;
      await response.body?.cancel();
      if (!wasRejected)
        throw new Error(
          "OpenCode credential isolation disabled authentication",
        );
    }
    const protectedHealth = await authenticatedFetch("/global/health", {
      signal,
    });
    const remainsProtected = protectedHealth.ok;
    await protectedHealth.body?.cancel();
    if (!remainsProtected)
      throw new Error(
        "OpenCode credential isolation invalidated authentication",
      );
    if (!child.pid || exited) throw new Error("OpenCode exited during startup");
    return {
      pid: child.pid,
      exited: exit,
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
    await rm(launchRoot, { recursive: true, force: true }).catch(() => {});
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
