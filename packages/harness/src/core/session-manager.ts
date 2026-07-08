/**
 * SessionManager — node-pty registry implementing the session lifecycle from
 * the shared contract: create, resume, kill, list. Persists HarnessSession[]
 * to disk (HARNESS_PATHS.sessions) so the SPA's session dropdown survives
 * server restarts, even though the ptys themselves do not.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

import {
  ENV,
  HARNESS_PATHS,
  type CreateSessionRequest,
  type HarnessAdapter,
  type HarnessKind,
  type HarnessSession,
  type LaunchOpts,
  type SpawnSpec,
} from "../shared/types.js";
import { expandHome } from "./paths.js";

// node-pty is a native module. Load it lazily so a missing/broken prebuild on
// an unsupported platform surfaces as a spawn-time error instead of crashing
// the whole server at import time.
type IPty = import("node-pty").IPty;
type PtyForkOptions = import("node-pty").IPtyForkOptions;
export type PtySpawnFn = (file: string, args: string[], options: PtyForkOptions) => IPty;

let defaultSpawn: PtySpawnFn | undefined;
let defaultSpawnError: Error | undefined;

/**
 * node-pty ships prebuilt native binaries (including a tiny `spawn-helper`
 * on macOS/Linux) rather than compiling from source. Observed in the wild:
 * a pnpm-managed install can extract that helper without its executable bit
 * set, which fails every single spawn with an opaque "posix_spawnp failed"
 * — nothing to do with the harness's own code, but fatal to every session
 * launch. Best-effort self-heal before the first real spawn; silently a
 * no-op if the file's missing (wrong platform/arch) or already executable.
 */
async function ensureSpawnHelperExecutable(): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const nodePtyPkgJson = createRequire(import.meta.url).resolve("node-pty/package.json");
    const helperPath = join(
      dirname(nodePtyPkgJson),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await chmod(helperPath, 0o755);
  } catch {
    // Not present for this platform/arch — nothing to fix.
  }
}

async function loadDefaultSpawn(): Promise<PtySpawnFn> {
  if (defaultSpawn) return defaultSpawn;
  if (defaultSpawnError) throw defaultSpawnError;
  try {
    await ensureSpawnHelperExecutable();
    const nodePty = await import("node-pty");
    defaultSpawn = nodePty.spawn as PtySpawnFn;
    return defaultSpawn;
  } catch (err) {
    defaultSpawnError = err instanceof Error ? err : new Error(String(err));
    throw defaultSpawnError;
  }
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Bytes of terminal output retained per session for replay on WS (re)attach. */
const SCROLLBACK_BYTES = 131_072;
/**
 * Delay between writing prompt text and a trailing Enter, when submitting
 * non-empty text in one call (see `submitInput`). Claude Code — like many
 * bracketed-paste-aware TUIs — treats a single write containing both text
 * and a newline as one paste event: the newline lands inside the pasted
 * content instead of registering as a separate "submit" keypress, so the
 * prompt sits in the input box and is never sent. Splitting the write with
 * a short delay makes the terminal see two distinct input events instead —
 * a paste, then a separate Enter.
 */
const SUBMIT_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SessionStatusListener = (session: HarnessSession) => void;
export type SessionDataListener = (chunk: string) => void;

/**
 * Builds the harness-specific part of LaunchOpts (generated system-prompt /
 * mcp-config / settings file paths). SessionManager owns cwd + harnessSessionId;
 * this lets the server layer inject config-file generation (profiles, MCP
 * wiring) without SessionManager needing to know how those files are produced.
 * May return synchronously or a Promise — generating the config files is
 * inherently async (they're written to disk), so `create()`/`resume()` await
 * whichever shape is handed in; existing sync test doubles keep working
 * unchanged (`await` on a plain value just resolves immediately).
 */
export type LaunchOptsBuilder = (
  harnessSessionId: string,
  req: Pick<CreateSessionRequest, "cwd" | "harness" | "profile">,
) => Omit<LaunchOpts, "harnessSessionId" | "cwd"> | Promise<Omit<LaunchOpts, "harnessSessionId" | "cwd">>;

const defaultBuildLaunchOpts: LaunchOptsBuilder = () => ({});

export interface SessionManagerOptions {
  adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  /** Base URL the harness server is reachable at, e.g. http://127.0.0.1:4100. */
  ingestUrl: string;
  /** Per-boot secret; injected into every session's env so hook scripts can auth to /ingest. */
  ingestToken: string;
  /** Forwarded to sessions as SAPIOM_COLLECTOR_URL when set. */
  collectorUrl?: string;
  /** Absolute path to the session registry file. Defaults to HARNESS_PATHS.sessions (expanded). */
  sessionsPath?: string;
  /** Injectable for tests. Defaults to a lazily-loaded node-pty. */
  spawnPty?: PtySpawnFn;
  buildLaunchOpts?: LaunchOptsBuilder;
  now?: () => string;
  generateId?: () => string;
}

interface PtyHandle {
  pty: IPty;
  buffer: string;
  emitter: EventEmitter;
}

export class SessionManager {
  private readonly adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  private readonly ingestUrl: string;
  private readonly ingestToken: string;
  private readonly collectorUrl: string | undefined;
  private readonly sessionsPath: string;
  private readonly spawnPty: PtySpawnFn | undefined;
  private readonly buildLaunchOpts: LaunchOptsBuilder;
  private readonly now: () => string;
  private readonly generateId: () => string;

  private readonly sessions = new Map<string, HarnessSession>();
  private readonly ptys = new Map<string, PtyHandle>();
  private readonly statusEmitter = new EventEmitter();
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  private initialized = false;

  constructor(options: SessionManagerOptions) {
    this.adapters = options.adapters;
    this.ingestUrl = options.ingestUrl;
    this.ingestToken = options.ingestToken;
    this.collectorUrl = options.collectorUrl;
    this.sessionsPath = expandHome(options.sessionsPath ?? HARNESS_PATHS.sessions);
    this.spawnPty = options.spawnPty;
    this.buildLaunchOpts = options.buildLaunchOpts ?? defaultBuildLaunchOpts;
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? randomUUID;
    // Many WS clients (terminal + events) can subscribe over a long-running process.
    this.statusEmitter.setMaxListeners(0);
  }

  /**
   * Loads the persisted registry. Any session left "starting"/"running" from
   * a previous process is marked "exited" — ptys don't survive a restart.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let persisted: HarnessSession[] = [];
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      persisted = JSON.parse(raw) as HarnessSession[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let dirty = false;
    for (const session of persisted) {
      if (session.status !== "exited") {
        session.status = "exited";
        session.exitCode = session.exitCode ?? null;
        dirty = true;
      }
      this.sessions.set(session.id, session);
    }
    if (dirty) await this.persist();
  }

  list(): HarnessSession[] {
    return Array.from(this.sessions.values());
  }

  get(id: string): HarnessSession | undefined {
    return this.sessions.get(id);
  }

  private getAdapter(harness: HarnessKind): HarnessAdapter {
    const adapter = this.adapters[harness];
    if (!adapter) throw new Error(`No adapter registered for harness "${harness}"`);
    return adapter;
  }

  async create(req: CreateSessionRequest): Promise<HarnessSession> {
    const id = this.generateId();
    const adapter = this.getAdapter(req.harness);
    const opts: LaunchOpts = {
      harnessSessionId: id,
      cwd: req.cwd,
      ...(await this.buildLaunchOpts(id, req)),
    };
    const spec = adapter.launch(opts);
    const session: HarnessSession = {
      id,
      agentSessionId: null,
      harness: req.harness,
      cwd: req.cwd,
      title: basename(req.cwd) || req.cwd,
      status: "starting",
      createdAt: this.now(),
      lastActiveAt: this.now(),
      exitCode: null,
    };
    this.sessions.set(id, session);
    await this.persist();
    await this.spawn(session, spec);
    return session;
  }

  /**
   * Registers a purely historical (never-launched-by-this-harness) session so
   * it can subsequently be resumed via `resume()`. Used by the server layer
   * when a user picks a past session out of transcript-scanned history.
   */
  registerHistorical(input: {
    agentSessionId: string;
    harness: HarnessKind;
    cwd: string;
    title: string;
    lastActiveAt: string;
  }): HarnessSession {
    const id = this.generateId();
    const session: HarnessSession = {
      id,
      agentSessionId: input.agentSessionId,
      harness: input.harness,
      cwd: input.cwd,
      title: input.title,
      status: "exited",
      createdAt: input.lastActiveAt,
      lastActiveAt: input.lastActiveAt,
      exitCode: null,
    };
    this.sessions.set(id, session);
    void this.persist();
    return session;
  }

  async resume(id: string): Promise<HarnessSession> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session "${id}"`);
    if (!session.agentSessionId) {
      throw new Error(`Session "${id}" has no agentSessionId to resume from`);
    }
    if (this.ptys.has(id)) {
      throw new Error(`Session "${id}" already has a live pty`);
    }
    const adapter = this.getAdapter(session.harness);
    const opts: LaunchOpts = {
      harnessSessionId: id,
      cwd: session.cwd,
      ...(await this.buildLaunchOpts(id, session)),
    };
    const spec = adapter.resume(session.agentSessionId, opts);
    session.status = "starting";
    session.exitCode = null;
    session.lastActiveAt = this.now();
    await this.persist();
    this.emitStatus(session);
    await this.spawn(session, spec);
    return session;
  }

  kill(id: string): boolean {
    const handle = this.ptys.get(id);
    if (!handle) return false;
    handle.pty.kill();
    return true;
  }

  write(id: string, data: string): boolean {
    const handle = this.ptys.get(id);
    if (!handle) return false;
    handle.pty.write(data);
    const session = this.sessions.get(id);
    if (session) {
      session.lastActiveAt = this.now();
      void this.persist();
    }
    return true;
  }

  /**
   * Inject a discrete prompt (macros, the Visualize button, `/api/sessions/:id/input`)
   * with proper submit semantics — distinct from `write()`, which is a raw
   * passthrough for live keystrokes from the terminal WS and must never add
   * this delay/splitting behavior. See `SUBMIT_DELAY_MS` for why non-empty
   * submitted text can't just be written as `${text}\r` in one call.
   */
  async submitInput(id: string, text: string, submit = true): Promise<boolean> {
    const handle = this.ptys.get(id);
    if (!handle) return false;

    if (!submit) {
      handle.pty.write(text);
    } else if (text.length === 0) {
      handle.pty.write("\r");
    } else {
      handle.pty.write(text);
      await sleep(SUBMIT_DELAY_MS);
      // The pty may have been killed/replaced while we were waiting.
      if (this.ptys.get(id) !== handle) return false;
      handle.pty.write("\r");
    }

    const session = this.sessions.get(id);
    if (session) {
      session.lastActiveAt = this.now();
      void this.persist();
    }
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const handle = this.ptys.get(id);
    if (!handle) return false;
    handle.pty.resize(cols, rows);
    return true;
  }

  /**
   * Subscribe to a session's output. Replays the retained scrollback buffer
   * synchronously before returning so a reconnecting WS client sees recent
   * output immediately. Returns undefined if the session has no live pty.
   */
  attach(id: string, listener: SessionDataListener): (() => void) | undefined {
    const handle = this.ptys.get(id);
    if (!handle) return undefined;
    if (handle.buffer) listener(handle.buffer);
    handle.emitter.on("data", listener);
    return () => handle.emitter.off("data", listener);
  }

  onStatusChange(listener: SessionStatusListener): () => void {
    this.statusEmitter.on("status", listener);
    return () => {
      this.statusEmitter.off("status", listener);
    };
  }

  setAgentSessionId(id: string, agentSessionId: string): void {
    const session = this.sessions.get(id);
    if (!session || session.agentSessionId === agentSessionId) return;
    session.agentSessionId = agentSessionId;
    void this.persist();
    this.emitStatus(session);
  }

  /** Waits for all in-flight registry writes to settle. Useful before process
   * shutdown (and in tests that assert against the on-disk registry). */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  setTitle(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (!session || !title || session.title === title) return;
    session.title = title;
    void this.persist();
    this.emitStatus(session);
  }

  private async spawn(session: HarnessSession, spec: SpawnSpec): Promise<void> {
    const spawnFn = this.spawnPty ?? (await loadDefaultSpawn());
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(spec.env)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    env[ENV.ingestUrl] = `${this.ingestUrl.replace(/\/$/, "")}/ingest`;
    env[ENV.ingestToken] = this.ingestToken;
    env[ENV.sessionId] = session.id;
    if (this.collectorUrl) env[ENV.collectorUrl] = this.collectorUrl;

    let pty: IPty;
    try {
      pty = spawnFn(spec.command, spec.args, {
        name: "xterm-256color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: spec.cwd,
        env,
      });
    } catch (err) {
      session.status = "exited";
      session.exitCode = null;
      await this.persist();
      this.emitStatus(session);
      throw err;
    }

    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const handle: PtyHandle = { pty, buffer: "", emitter };
    this.ptys.set(session.id, handle);

    session.status = "running";
    session.lastActiveAt = this.now();
    await this.persist();
    this.emitStatus(session);

    pty.onData((chunk) => {
      handle.buffer = (handle.buffer + chunk).slice(-SCROLLBACK_BYTES);
      handle.emitter.emit("data", chunk);
    });

    pty.onExit(({ exitCode }) => {
      this.ptys.delete(session.id);
      session.status = "exited";
      session.exitCode = exitCode;
      session.lastActiveAt = this.now();
      void this.persist();
      this.emitStatus(session);
    });
  }

  private emitStatus(session: HarnessSession): void {
    this.statusEmitter.emit("status", { ...session });
  }

  /** Serializes writes so overlapping persist() calls can't interleave and
   * corrupt the registry file; a failed write doesn't poison later ones. */
  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      const list = this.list();
      await mkdir(dirname(this.sessionsPath), { recursive: true });
      const tmpPath = `${this.sessionsPath}.tmp-${process.pid}-${this.writeSeq++}`;
      await writeFile(tmpPath, JSON.stringify(list, null, 2) + "\n", "utf8");
      await rename(tmpPath, this.sessionsPath);
    };
    const next = this.writeQueue.catch(() => {}).then(run);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}
