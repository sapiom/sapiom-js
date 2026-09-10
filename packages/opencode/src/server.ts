import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface StartOpenCodeServerOptions {
  cwd: string;
  stateRoot: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  command?: { executable: string; prefixArgs?: string[] };
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  beforeLaunch?: (identity: OpenCodeProcessIdentity) => void | Promise<void>;
}
export interface OpenCodeCleanupProof {
  path: string;
  token: string;
}
export interface OpenCodeProcessIdentity {
  pid: number;
  birthId?: string;
  cleanupProof: OpenCodeCleanupProof;
}
export interface OpenCodeServer {
  pid: number;
  exited: Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

interface SupervisorProcessIdentity {
  pid: number;
  birthId: string;
  state: string;
}

/** @internal Shared verbatim with the generated supervisor for deterministic tests. */
export function evaluateTrackedClosure(
  tracked: ReadonlyMap<
    string,
    Pick<SupervisorProcessIdentity, "pid" | "birthId">
  >,
  processes: ReadonlyMap<number, SupervisorProcessIdentity>,
): "stopped" | "waiting" | "uncertain" {
  let allStopped = true;
  for (const identity of tracked.values()) {
    const current = processes.get(identity.pid);
    if (!current || current.birthId !== identity.birthId) return "uncertain";
    if (current.state.startsWith("Z")) return "uncertain";
    if (!current.state.startsWith("T")) allStopped = false;
  }
  return allStopped ? "stopped" : "waiting";
}

export type OpenCodeStartupFailureCode =
  | "executable-not-found"
  | "permission-denied"
  | "launch-failed"
  | "exited"
  | "timed-out"
  | "cancelled";

const startupMessages: Record<OpenCodeStartupFailureCode, string> = {
  "executable-not-found":
    "Studio's OpenCode runtime is missing. Update or reinstall Studio, then retry.",
  "permission-denied":
    "Studio cannot launch its OpenCode runtime because the executable is not permitted. Check the installation permissions or reinstall Studio, then retry.",
  "launch-failed":
    "Studio could not launch its OpenCode runtime. Retry, then update or reinstall Studio if the problem continues.",
  exited:
    "OpenCode exited before it became ready. Retry, then update or reinstall Studio if the problem continues.",
  "timed-out": "OpenCode took too long to start. Retry the connection.",
  cancelled: "OpenCode startup was cancelled.",
};

const permanentlyBlocked = new Set<OpenCodeStartupFailureCode>([
  "executable-not-found",
  "permission-denied",
]);

/** A credential-free, stable reason for a native runtime startup failure. */
export class OpenCodeStartupError extends Error {
  readonly retryable: boolean;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;

  constructor(
    readonly code: OpenCodeStartupFailureCode,
    termination?: { exitCode: number | null; signal: NodeJS.Signals | null },
  ) {
    super(startupMessages[code]);
    this.name = "OpenCodeStartupError";
    this.retryable = !permanentlyBlocked.has(code);
    if (code === "exited") {
      if (typeof termination?.exitCode === "number")
        this.exitCode = termination.exitCode;
      if (termination?.signal) this.signal = termination.signal;
    }
  }
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function createCredentialIsolationPlugin(
  launchRoot: string,
  toolHomeEnvironment: NodeJS.ProcessEnv,
): Promise<{ pluginUrl: string; readyPath: string }> {
  const pluginPath = join(launchRoot, "credential-isolation.mjs");
  const readyPath = join(launchRoot, "credential-isolation.ready");
  const compiledHook = fileURLToPath(
    new URL("./completion-hook.js", import.meta.url),
  );
  let hookPath = compiledHook;
  try {
    await access(hookPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hookPath = fileURLToPath(new URL("./completion-hook.ts", import.meta.url));
    await access(hookPath);
  }
  hookPath = hookPath.replace(
    /([/\\])app\.asar([/\\])/,
    "$1app.asar.unpacked$2",
  );
  const source = `import { writeFile } from "node:fs/promises";
import { createStudioCompletionHooks } from ${JSON.stringify(pathToFileURL(hookPath).href)};
const keys = ${JSON.stringify(runtimeCredentialKeys)};
const toolHomeKeys = ${JSON.stringify(toolHomeKeys)};
const toolHomeEnvironment = ${JSON.stringify(toolHomeEnvironment)};
export const SapiomCredentialIsolation = async (input) => {
  for (const key of keys) delete process.env[key];
  const completionHooks = createStudioCompletionHooks(async (sessionID) => {
    const response = await input.client.session.messages({ path: { id: sessionID } });
    return response.data ?? [];
  });
  await writeFile(${JSON.stringify(readyPath)}, "ready\\n", { flag: "wx", mode: 0o600 });
  return {
    ...completionHooks,
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

async function createRuntimeSupervisor(
  launchRoot: string,
  cleanupProof: OpenCodeCleanupProof,
  shutdownTimeoutMs: number,
): Promise<string> {
  const supervisorPath = join(launchRoot, "runtime-supervisor.mjs");
  const source = `import { spawn, spawnSync } from "node:child_process";
import { link, open, readdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
const cleanupPath = ${JSON.stringify(cleanupProof.path)};
const cleanupToken = ${JSON.stringify(cleanupProof.token)};
const shutdownTimeoutMs = ${JSON.stringify(shutdownTimeoutMs)};
const evaluateTrackedClosure = ${evaluateTrackedClosure.toString()};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let native;
let nativePid;
let launched = false;
let stopping;
const tracked = new Map();
async function syncDirectory(directory) {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code ?? "")) throw error;
  }
}
async function publishCleanupProof() {
  const pending = cleanupPath + ".pending-" + randomUUID();
  try {
    const file = await open(pending, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ status: "complete", token: cleanupToken }) + "\\n", "utf8");
      await file.sync();
    } finally { await file.close(); }
    await link(pending, cleanupPath);
    await syncDirectory(dirname(cleanupPath));
  } finally { await rm(pending, { force: true }).catch(() => {}); }
}
async function linuxProcesses() {
  const processes = new Map();
  for (const entry of await readdir("/proc")) {
    if (!/^\\d+$/.test(entry)) continue;
    try {
      const stat = await readFile("/proc/" + entry + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.set(Number(entry), {
        pid: Number(entry),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        state: fields[0],
        birthId: fields[19],
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return processes;
}
function darwinProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const processes = new Map();
  for (const line of result.stdout.split("\\n")) {
    const match = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.+)$/);
    if (!match) continue;
    processes.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      birthId: match[5],
    });
  }
  return processes;
}
async function processTable() {
  if (process.platform === "linux") return linuxProcesses();
  if (process.platform === "darwin") return darwinProcesses();
  return null;
}
async function captureDescendants() {
  const processes = await processTable();
  if (processes === null || !nativePid) return false;
  const roots = new Set([nativePid]);
  for (const identity of tracked.values()) {
    const current = processes.get(identity.pid);
    if (current?.birthId === identity.birthId && !current.state.startsWith("Z"))
      roots.add(identity.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of processes.values()) {
      if (current.pid === nativePid || roots.has(current.pid) || !roots.has(current.ppid)) continue;
      roots.add(current.pid);
      tracked.set(current.pid + ":" + current.birthId, current);
      changed = true;
    }
  }
  return true;
}
async function runningTracked() {
  const processes = await processTable();
  if (processes === null) return null;
  return [...tracked.values()].filter((identity) => {
    const current = processes.get(identity.pid);
    return current?.birthId === identity.birthId && !current.state.startsWith("Z");
  });
}
async function groupMembers(pgid) {
  const processes = await processTable();
  if (processes === null) return null;
  return [...processes.values()].filter(
    (identity) => identity.pgid === pgid && !identity.state.startsWith("Z"),
  );
}
function signalOwnedGroup(signal) {
  if (!nativePid) return;
  try { process.kill(-nativePid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}
async function signalTrackedGroups(signal) {
  const running = await runningTracked();
  if (running === null) return false;
  for (const pgid of new Set(running.map((identity) => identity.pgid))) {
    if (pgid === nativePid) continue;
    try { process.kill(-pgid, signal); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  return true;
}
async function waitForEmptyGroup(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const members = await groupMembers(pgid);
    if (members === null) return false;
    if (members.length === 0) return true;
    await wait(25);
  } while (Date.now() < deadline);
  return false;
}
async function freezeOwnedGroup() {
  signalOwnedGroup("SIGSTOP");
  const deadline = Date.now() + 1000;
  do {
    const members = await groupMembers(nativePid);
    if (members === null || members.length === 0) return false;
    if (members.every((identity) => identity.state.startsWith("T"))) return true;
    await wait(10);
  } while (Date.now() < deadline);
  return false;
}
async function freezeDescendants() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = tracked.size;
    if (!(await captureDescendants())) return false;
    if (!(await signalTrackedGroups("SIGSTOP"))) return false;
    await wait(10);
    const processes = await processTable();
    if (processes === null) return false;
    const closure = evaluateTrackedClosure(tracked, processes);
    if (closure === "uncertain") return false;
    if (closure === "stopped" && tracked.size === before) return true;
  }
  return false;
}
async function cleanupWindows() {
  if (!nativePid || native?.exitCode !== null) return false;
  const result = spawnSync("taskkill", ["/pid", String(nativePid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  if (result.status !== 0) return false;
  const deadline = Date.now() + shutdownTimeoutMs;
  do {
    try { process.kill(nativePid, 0); } catch (error) {
      if (error?.code === "ESRCH") return true;
      return false;
    }
    await wait(25);
  } while (Date.now() < deadline);
  return false;
}
async function cleanupPosix(cause) {
  if (!nativePid) return true;
  if (cause === "native-exit") return false;
  if (!(await freezeOwnedGroup())) return false;
  if (!(await freezeDescendants())) return false;
  if (!(await signalTrackedGroups("SIGKILL"))) return false;
  signalOwnedGroup("SIGKILL");
  const forcedDeadline = Date.now() + 2000;
  do {
    await captureDescendants();
    const running = await runningTracked();
    if (running !== null && running.length === 0 && (await waitForEmptyGroup(nativePid, 25)))
      return true;
    await wait(25);
  } while (Date.now() < forcedDeadline);
  return false;
}
function stop(cause = "stop") {
  if (stopping) return stopping;
  stopping = (async () => {
    const confirmed = !launched
      ? true
      : process.platform === "win32"
        ? await cleanupWindows()
        : await cleanupPosix(cause);
    if (confirmed) await publishCleanupProof();
    process.exitCode = confirmed ? 0 : 1;
    if (process.connected) process.disconnect();
    setTimeout(() => process.exit(process.exitCode ?? 1), 0);
  })().catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    setTimeout(() => process.exit(1), 0);
  });
  return stopping;
}
process.once("disconnect", () => void stop("disconnect"));
process.once("SIGTERM", () => void stop("signal"));
process.once("SIGINT", () => void stop("signal"));
process.on("message", (message) => {
  if (message?.type === "stop") {
    void stop();
    return;
  }
  if (launched || stopping || !message || message.type !== "launch") return;
  launched = true;
  try {
    native = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: message.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    nativePid = native.pid;
    native.stdout?.resume();
    native.stderr?.resume();
    native.once("error", (error) => {
      process.send?.({ type: "spawn-error", code: error?.code });
      void stop();
    });
    native.once("exit", (exitCode, signal) => {
      process.send?.({ type: "native-exit", exitCode, signal });
      void stop("native-exit");
    });
  } catch (error) {
    process.send?.({ type: "spawn-error", code: error?.code });
    void stop();
  }
});
`;
  await writeFile(supervisorPath, source, { mode: 0o600 });
  return supervisorPath;
}

export async function startOpenCodeServer(
  options: StartOpenCodeServerOptions,
): Promise<OpenCodeServer> {
  if (options.signal?.aborted) throw new OpenCodeStartupError("cancelled");
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
  if (options.signal?.aborted) {
    await rm(launchRoot, { recursive: true, force: true }).catch(() => {});
    throw new OpenCodeStartupError("cancelled");
  }
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2000;
  const cleanupProof: OpenCodeCleanupProof = {
    path: join(
      options.stateRoot,
      `cleanup-${randomBytes(16).toString("hex")}.json`,
    ),
    token: randomBytes(32).toString("hex"),
  };
  const supervisorPath = await createRuntimeSupervisor(
    launchRoot,
    cleanupProof,
    shutdownTimeoutMs,
  );
  const nativeArgs = [
    ...(command.prefixArgs ?? []),
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  const nativeEnvironment = {
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
    // Native discovery retains the complete MCP catalog without placing every
    // remote tool schema in every model request.
    OPENCODE_EXPERIMENTAL_CODE_MODE: "1",
  };
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [supervisorPath], {
      cwd: launchRoot,
      env: { ...platform, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    await rm(launchRoot, { recursive: true, force: true }).catch(() => {});
    throw startupLaunchError(error);
  }
  // Raw diagnostics can contain configuration or provider credentials.
  child.stdout?.resume();
  child.stderr?.resume();
  let exited = false;
  let disconnected = false;
  let protectionAcknowledged = false;
  let termination:
    | {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        spawnErrorCode?: string;
      }
    | undefined;
  child.once("disconnect", () => {
    disconnected = true;
  });
  child.on("message", (message: unknown) => {
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "spawn-error") {
      termination = {
        exitCode: null,
        signal: null,
        ...(typeof message.code === "string"
          ? { spawnErrorCode: message.code }
          : {}),
      };
    } else if (
      message.type === "native-exit" &&
      (message.exitCode === null || typeof message.exitCode === "number") &&
      (message.signal === null || typeof message.signal === "string")
    ) {
      termination = {
        exitCode: message.exitCode,
        signal: message.signal as NodeJS.Signals | null,
      };
    }
  });
  const exit = new Promise<void>((resolve) => {
    const done = (next: typeof termination) => {
      if (exited) return;
      exited = true;
      termination = next;
      resolve();
    };
    child.once("exit", (exitCode, signal) =>
      done(termination ?? { exitCode, signal }),
    );
    child.once("error", (error) =>
      done({
        exitCode: null,
        signal: null,
        spawnErrorCode: (error as NodeJS.ErrnoException).code,
      }),
    );
  });
  const cleanupConfirmed = async (): Promise<boolean> => {
    try {
      const decoded = JSON.parse(
        await readFile(cleanupProof.path, "utf8"),
      ) as unknown;
      return (
        isRecord(decoded) &&
        Object.keys(decoded).sort().join(",") === "status,token" &&
        decoded.status === "complete" &&
        decoded.token === cleanupProof.token
      );
    } catch {
      return false;
    }
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (!exited && child.connected)
        await sendToChild(child, { type: "stop" }).catch(() => {});
      if (!exited) await Promise.race([exit, delay(shutdownTimeoutMs + 2500)]);
      if (!exited) {
        signalChild(child, "SIGKILL");
        await Promise.race([exit, delay(2000)]);
      }
      if (!exited || !(await cleanupConfirmed()))
        throw new OpenCodeShutdownError();
      await rm(launchRoot, { recursive: true, force: true }).catch(() => {});
      if (!protectionAcknowledged)
        await rm(cleanupProof.path, { force: true }).catch(() => {});
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
    if (!child.pid) throw new OpenCodeStartupError("launch-failed");
    const birthId = await processBirthId(child.pid);
    if (options.beforeLaunch) {
      await options.beforeLaunch({
        pid: child.pid,
        ...(birthId === undefined ? {} : { birthId }),
        cleanupProof,
      });
      protectionAcknowledged = true;
    }
    if (options.signal?.aborted) throw new OpenCodeStartupError("cancelled");
    if (exited || disconnected || !child.connected)
      throw new OpenCodeStartupError("launch-failed");
    await sendToChild(child, {
      type: "launch",
      executable: command.executable,
      args: nativeArgs,
      cwd: options.cwd,
      env: nativeEnvironment,
    });
    if (options.signal?.aborted) throw new OpenCodeStartupError("cancelled");
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
    if (!child.pid || exited || disconnected || !child.connected)
      throw new Error("OpenCode exited during startup");
    await sendToChild(child, { type: "ready" });
    if (exited) throw new Error("OpenCode exited during startup");
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
  } catch (error) {
    let startupError: OpenCodeStartupError;
    if (options.signal?.aborted) {
      startupError = new OpenCodeStartupError("cancelled");
    } else if (timeout.aborted) {
      startupError = new OpenCodeStartupError("timed-out");
    } else if (exited) {
      startupError = termination?.spawnErrorCode
        ? startupLaunchError(termination.spawnErrorCode)
        : new OpenCodeStartupError("exited", termination);
    } else {
      startupError =
        error instanceof OpenCodeStartupError
          ? error
          : new OpenCodeStartupError("launch-failed");
    }
    await close();
    await rm(launchRoot, { recursive: true, force: true }).catch(() => {});
    throw startupError;
  }
}

function startupLaunchError(error: unknown): OpenCodeStartupError {
  const code =
    typeof error === "string"
      ? error
      : (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR")
    return new OpenCodeStartupError("executable-not-found");
  if (code === "EACCES" || code === "EPERM")
    return new OpenCodeStartupError("permission-denied");
  return new OpenCodeStartupError("launch-failed");
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function sendToChild(
  child: ChildProcess,
  message: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function processBirthId(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
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
