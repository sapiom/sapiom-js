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
import {
  AdapterNotFoundError,
  SessionAlreadyLiveError,
  SessionNotReadyError,
  SessionNotResumeableError,
  UnknownSessionError,
} from "./errors.js";

export {
  AdapterNotFoundError,
  SessionAlreadyLiveError,
  SessionNotReadyError,
  SessionNotResumeableError,
  UnknownSessionError,
} from "./errors.js";

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
 * Exported so scripts/e2e-live.ts's preflight check shares this exact fix
 * instead of duplicating it.
 */
export async function ensureSpawnHelperExecutable(): Promise<void> {
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
/** See `kill()`: how long to wait for a graceful exit before escalating to SIGKILL. */
const KILL_ESCALATION_MS = 2_000;
/** See `kill()`: how long after escalating to give node-pty one last chance
 *  to report the exit itself before synthesizing it from an OS-level check. */
const KILL_ESCALATION_CONFIRM_MS = 500;
/**
 * See `isReadyEnough()`: for a harness with `detectBlockingPrompt`, how long
 * to give the pty to render its first real frame before trusting a clean
 * scrollback (no known blocking prompt) as a genuine "no prompt showing"
 * rather than just "hasn't drawn anything yet".
 */
const READY_SETTLE_MS = 700;
/** See `isReadyEnough()`: how much of the tail of retained scrollback to
 *  scan for a blocking prompt — recent output only, not the full history a
 *  full-screen TUI never truly clears. Generous relative to one redraw
 *  frame (confirmed against a real capture: a single Codex trust-prompt
 *  frame is well under 2KB) without re-scanning unbounded history. */
const BLOCKING_PROMPT_SCAN_BYTES = 4_096;
/**
 * See `submitInput()`: how long to wait for a not-yet-ready session to
 * become ready before giving up and throwing `SessionNotReadyError`. Covers
 * the ordinary "macro fired a beat before onboarding finished" case without
 * making a genuinely stuck session (real trust prompt sitting unanswered)
 * hang the caller for long before surfacing something actionable.
 */
const READY_GRACE_MS = 8_000;
/** Poll interval while waiting out READY_GRACE_MS. */
const READY_POLL_MS = 150;
/** See `recordActivity()`: minimum gap between two `onActivity` broadcasts
 *  for the same session — pty.onData fires per chunk (often many times a
 *  second for a busy TUI), but the SPA's busy indicator only needs "this
 *  session produced output recently", not every individual chunk. */
const ACTIVITY_BROADCAST_THROTTLE_MS = 2_000;
/**
 * See `sweepDeadSessions()`: how long a non-exited session record may sit
 * with no pty handle at all before the sweep declares it dead. There is one
 * legitimate window where that state exists — inside `create()`/`resume()`,
 * between persisting the record and attaching the freshly-spawned pty (a few
 * awaited config-file writes plus the spawn itself, normally well under a
 * second) — so this just needs to comfortably exceed that window, not be
 * fast: the sweep is a backstop, not the primary reconciliation.
 */
const NO_PTY_SWEEP_GRACE_MS = 30_000;

/**
 * OS-level "does this process exist" check — the same probe `kill()`'s
 * missed-exit fallback has always used, factored out so the liveness sweep
 * shares it. EPERM means the process exists but isn't ours to signal, i.e.
 * alive; anything else (ESRCH) means it's gone.
 */
const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SessionStatusListener = (session: HarnessSession) => void;
export type SessionDataListener = (chunk: string) => void;
/** See `onActivity()`. */
export type SessionActivityListener = (harnessSessionId: string) => void;

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
  /**
   * Writes HARNESS_CONTEXT_FILE for a session — the caller (server/index.ts's
   * `writeSessionContext`) owns resolving the session's `boundWorkflowPath`
   * against the live workflow registry and serializing the full workspace
   * state; this layer just decides *when* to call it. Called unconditionally
   * from `create()`, before the pty is spawned, so every session gets the
   * file regardless of entry point (REST, `autoCreateSession`) — no entry
   * point can skip it by calling `create()` directly. Also used by
   * `resume()` as a backfill when the file is entirely missing (see
   * `workspaceContextExists`). Defaults to a no-op so tests that pass a fake
   * `cwd` (e.g. `/tmp/proj`) never touch the real filesystem unless they opt
   * in.
   */
  writeWorkspaceContext?: (session: HarnessSession) => Promise<void>;
  /**
   * Reports whether HARNESS_CONTEXT_FILE already exists for a cwd. Used only
   * by `resume()`, to decide whether a backfill write is needed — resume
   * must never clobber a file that could already reflect a real binding.
   * Defaults to `true` (assume it exists, never backfill) to match the
   * no-op default of `writeWorkspaceContext`.
   */
  workspaceContextExists?: (cwd: string) => Promise<boolean>;
  /**
   * Drops the canvas kit template into `<cwd>/.sapiom/canvas/index.html`
   * when nothing is there yet (backfill-only — the real implementation,
   * `ensureCanvasTemplate` from core/canvas-template.ts, does its own
   * existence check internally, so unlike `writeWorkspaceContext` this
   * needs no separate `*Exists` companion). Called from both `create()` and
   * `resume()` so the canvas pane is never a blank iframe, regardless of
   * entry point. Defaults to a no-op so tests that pass a fake `cwd` never
   * touch the real filesystem unless they opt in.
   */
  ensureCanvasTemplate?: (cwd: string) => Promise<void>;
  /**
   * Injectable for tests (fake ptys carry fake pids that must never be
   * probed against real OS processes). Defaults to `defaultIsPidAlive`.
   */
  isPidAlive?: (pid: number) => boolean;
}

interface PtyHandle {
  pty: IPty;
  buffer: string;
  emitter: EventEmitter;
  /** Epoch ms this pty was spawned — see `isReadyEnough`'s settle window. */
  spawnedAt: number;
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
  private readonly writeWorkspaceContext: (session: HarnessSession) => Promise<void>;
  private readonly workspaceContextExists: (cwd: string) => Promise<boolean>;
  private readonly ensureCanvasTemplate: (cwd: string) => Promise<void>;
  private readonly isPidAlive: (pid: number) => boolean;

  private readonly sessions = new Map<string, HarnessSession>();
  private readonly ptys = new Map<string, PtyHandle>();
  private readonly statusEmitter = new EventEmitter();
  private readonly activityEmitter = new EventEmitter();
  /** Epoch ms of the last `onActivity` broadcast per session — see `recordActivity()`. */
  private readonly lastActivityBroadcast = new Map<string, number>();
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
    this.writeWorkspaceContext = options.writeWorkspaceContext ?? (async () => {});
    this.workspaceContextExists = options.workspaceContextExists ?? (async () => true);
    this.ensureCanvasTemplate = options.ensureCanvasTemplate ?? (async () => {});
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    // Many WS clients (terminal + events) can subscribe over a long-running process.
    this.statusEmitter.setMaxListeners(0);
    this.activityEmitter.setMaxListeners(0);
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
    if (!adapter) throw new AdapterNotFoundError(harness);
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
      boundWorkflowPath: null,
      ready: false,
    };
    this.sessions.set(id, session);
    await this.persist();
    try {
      // Before spawning, not fire-and-forget: the agent's very first read of
      // HARNESS_CONTEXT_FILE must never race session creation with an ENOENT,
      // regardless of which entry point called create() (REST, autoCreateSession).
      await this.writeWorkspaceContext(session);
      // Same reasoning: the canvas pane opens immediately once the session is
      // "running" — it must never show a bare empty iframe because nothing's
      // been written to .sapiom/canvas/index.html yet.
      await this.ensureCanvasTemplate(session.cwd);
      await this.spawn(session, spec);
    } catch (err) {
      // The record was already persisted as "starting" above; a failure
      // anywhere before the pty is live must reconcile it to "exited" or it
      // lingers forever as a ghost tab (non-exited status, no pty behind it).
      await this.transitionExited(session, null);
      throw err;
    }
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
      boundWorkflowPath: null,
      ready: false,
    };
    this.sessions.set(id, session);
    void this.persist();
    return session;
  }

  async resume(id: string): Promise<HarnessSession> {
    const session = this.sessions.get(id);
    if (!session) throw new UnknownSessionError(id);
    if (!session.agentSessionId) {
      throw new SessionNotResumeableError(id);
    }
    if (this.ptys.has(id)) {
      throw new SessionAlreadyLiveError(id);
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
    try {
      // Backfill only — never overwrite a file that could already reflect a
      // real binding. The caller resolves session.boundWorkflowPath against
      // the live registry, so unlike the old cwd-only signature this actually
      // reconstructs the real binding on backfill, not just `null`.
      if (!(await this.workspaceContextExists(session.cwd))) {
        await this.writeWorkspaceContext(session);
      }
      // Also backfill-only (ensureCanvasTemplate does its own existence check)
      // — a session from before the canvas kit existed, or one whose canvas
      // file was somehow deleted, still gets a live pane on resume.
      await this.ensureCanvasTemplate(session.cwd);
      await this.spawn(session, spec);
    } catch (err) {
      // Same reconciliation as create(): the record just went back to
      // "starting" and was persisted — a failure before the new pty is live
      // must not leave it stranded there with nothing behind it.
      await this.transitionExited(session, null);
      throw err;
    }
    return session;
  }

  kill(id: string): boolean {
    const handle = this.ptys.get(id);
    if (!handle) {
      // A non-exited record with no pty behind it has nothing left to kill —
      // it's a ghost (its pty died without the exit ever being recorded).
      // Reconcile it here so closing the tab actually closes it, instead of
      // returning false and leaving an unclosable non-exited record.
      const session = this.sessions.get(id);
      if (session && session.status !== "exited") {
        void this.transitionExited(session, null);
        return true;
      }
      return false;
    }
    handle.pty.kill();
    // Root-caused via instrumented real-process runs: node-pty's `onExit`
    // can simply never fire for a pty killed within milliseconds of being
    // spawned — confirmed by `process.kill(pid, 0)` throwing ESRCH (no such
    // process) well after the graceful signal, i.e. the OS process really
    // is already gone; node-pty's own exit-reporting just missed it. So a
    // stronger signal alone doesn't help (there's nothing left to signal) —
    // the fallback below re-checks after a grace period, and if the pty is
    // still "running" in our registry but the OS confirms the process no
    // longer exists, synthesizes the exit ourselves rather than waiting on
    // an event that isn't coming. If the process genuinely is still alive
    // (the ordinary case: kill() just hasn't taken effect yet), send SIGKILL
    // as a real escalation before the same check.
    const escalate = setTimeout(() => {
      if (this.ptys.get(id) !== handle) return;
      const pid = handle.pty.pid;
      if (this.isPidAlive(pid)) handle.pty.kill("SIGKILL");
      setTimeout(() => {
        if (this.ptys.get(id) === handle && !this.isPidAlive(pid)) this.markExited(id, handle, null);
      }, KILL_ESCALATION_CONFIRM_MS).unref?.();
    }, KILL_ESCALATION_MS);
    escalate.unref?.();
    return true;
  }

  /** Kills every currently-live pty. Call this on server shutdown — without
   *  it, spawned agent processes (claude/codex) outlive the harness server
   *  itself, e.g. after Ctrl+C, since closing the HTTP/WS server doesn't
   *  touch unrelated child processes on its own. */
  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }

  /**
   * Defensive liveness backstop, run periodically by the server: any
   * non-exited session whose pty process is provably gone gets its exit
   * synthesized. The specific transitions are already reconciled at their
   * source (create/resume pre-pty failures, kill()'s missed-exit fallback),
   * but node-pty has been observed to simply never fire `onExit` for a
   * process that died moments after spawning (see `kill()`) — and a process
   * that dies *on its own* that way has no kill()-style fallback watching
   * it. This sweep is the catch-all for that and any transition not yet
   * root-caused: a stale record shows as a ghost tab (non-exited status, no
   * live pty) until something reconciles it.
   */
  sweepDeadSessions(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.status === "exited") continue;
      const handle = this.ptys.get(session.id);
      if (handle) {
        // Guard against non-numeric pids (test fakes) — never probe the OS
        // with a garbage value, and never declare a session dead on one.
        if (typeof handle.pty.pid === "number" && !this.isPidAlive(handle.pty.pid)) {
          this.markExited(session.id, handle, null);
        }
        continue;
      }
      // No pty handle at all. Within create()/resume() there's a legitimate
      // pre-spawn window where the persisted record briefly looks like this,
      // so only sweep records older than the grace period (an unparseable
      // lastActiveAt is garbage and sweeps immediately).
      const ageMs = Date.now() - Date.parse(session.lastActiveAt);
      if (!(ageMs < NO_PTY_SWEEP_GRACE_MS)) void this.transitionExited(session, null);
    }
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
   *
   * Gated on readiness (see `HarnessSession.ready` / `isReadyEnough`): a
   * "running" pty can still be sitting on a blocking prompt that swallows
   * whatever's written to it. Briefly waits out `READY_GRACE_MS` for the
   * ordinary "fired a beat too early" case; throws `SessionNotReadyError`
   * — never silently proceeds — if the session still isn't ready after
   * that, so the caller (rest.ts, macros.ts) can surface a clear reason
   * instead of the input just vanishing.
   */
  async submitInput(id: string, text: string, submit = true): Promise<boolean> {
    const handle = this.ptys.get(id);
    if (!handle) return false;

    const session = this.sessions.get(id);
    if (!session) return false;
    if (!this.isReadyEnough(session, handle)) {
      const becameReady = await this.waitUntilReady(id, READY_GRACE_MS);
      if (!becameReady) throw new SessionNotReadyError(id);
      // waitUntilReady only confirms readiness, not that the same pty is
      // still the live one — re-fetch in case it was killed/replaced (e.g.
      // a resume) while we were waiting, same as the mid-write race below.
      if (this.ptys.get(id) !== handle) return false;
    }

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

    session.lastActiveAt = this.now();
    void this.persist();
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

  /**
   * Subscribe to a session producing terminal output — throttled (see
   * `ACTIVITY_BROADCAST_THROTTLE_MS`), not one event per pty.onData chunk.
   * Fires for every session regardless of whether anything has its
   * /ws/terminal socket open, unlike `attach()`.
   */
  onActivity(listener: SessionActivityListener): () => void {
    this.activityEmitter.on("activity", listener);
    return () => {
      this.activityEmitter.off("activity", listener);
    };
  }

  /**
   * Leading-edge throttle: broadcasts immediately on the first byte after a
   * quiet period, then drops everything else for this session until
   * `ACTIVITY_BROADCAST_THROTTLE_MS` has elapsed — a busy TUI's onData fires
   * far more often than that, and callers (the SPA's per-tab pulse) only
   * care that the session is active right now, not each individual chunk.
   */
  private recordActivity(id: string): void {
    const now = Date.now();
    const last = this.lastActivityBroadcast.get(id) ?? 0;
    if (now - last < ACTIVITY_BROADCAST_THROTTLE_MS) return;
    this.lastActivityBroadcast.set(id, now);
    this.activityEmitter.emit("activity", id);
  }

  setAgentSessionId(id: string, agentSessionId: string): void {
    const session = this.sessions.get(id);
    if (!session || session.agentSessionId === agentSessionId) return;
    session.agentSessionId = agentSessionId;
    void this.persist();
    this.emitStatus(session);
  }

  /**
   * Marks a session's TUI as genuinely interactive — see `HarnessSession.ready`.
   * Called from the ingest pipeline when a SessionStart(-equivalent) event
   * is processed for this session (real hook for Claude Code, tailer-
   * translated for Codex). Idempotent; a session that's exited or already
   * ready is a silent no-op.
   */
  setReady(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.ready) return;
    session.ready = true;
    void this.persist();
    this.emitStatus(session);
  }

  /**
   * Whether `id` should be treated as ready to receive programmatic input
   * right now — `session.ready` (the real signal), OR, for a harness that
   * declares `detectBlockingPrompt` (currently: Codex, whose rollout file —
   * and therefore its SessionStart-equivalent — isn't written until the
   * *first* turn is submitted, so the real signal can never arrive before
   * the very first injection that needs it): the pty has had a moment to
   * render its first real frame (`READY_SETTLE_MS`) and that frame doesn't
   * show a known blocking prompt. A harness without `detectBlockingPrompt`
   * (Claude Code) gets no such fallback — its SessionStart hook is reliable
   * standalone, and a scrollback guess would just reopen the exact race
   * this mechanism exists to close.
   */
  private isReadyEnough(session: HarnessSession, handle: PtyHandle): boolean {
    if (session.ready) return true;
    const adapter = this.adapters[session.harness];
    if (!adapter?.detectBlockingPrompt) return false;
    if (Date.now() - handle.spawnedAt < READY_SETTLE_MS) return false;
    // Only the tail: `handle.buffer` is the full retained scrollback
    // (up to SCROLLBACK_BYTES) and full-screen TUIs never truly "clear" it
    // — a dismissed prompt's text sits in there forever. A full-screen
    // redraw re-touches its whole visible frame on every update though
    // (confirmed against a real capture), so recent output alone reflects
    // what's actually on screen right now; checking the whole history would
    // make a session that dismissed its trust prompt minutes ago look
    // permanently stuck.
    return !adapter.detectBlockingPrompt(handle.buffer.slice(-BLOCKING_PROMPT_SCAN_BYTES));
  }

  /**
   * Polls `isReadyEnough` until it's true, the session's pty goes away
   * (killed/exited — it's never going to become ready now), or `timeoutMs`
   * elapses. Used by `submitInput()` only — `write()` (raw terminal
   * keystrokes) must never wait on this, since a human answering the very
   * prompt this is waiting out is exactly how a session becomes ready.
   */
  private async waitUntilReady(id: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handle = this.ptys.get(id);
      const session = this.sessions.get(id);
      if (!handle || !session) return false;
      if (this.isReadyEnough(session, handle)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())));
    }
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

  /** Binds (or, with `null`, unbinds) the session's current workflow
   *  selection. The caller (rest.ts) owns validating `workflowPath` against
   *  the workflow registry and mirroring the binding into
   *  HARNESS_CONTEXT_FILE — this only updates the in-memory/persisted
   *  registry entry and broadcasts the change like any other status update. */
  setBoundWorkflowPath(id: string, workflowPath: string | null): void {
    const session = this.sessions.get(id);
    if (!session || session.boundWorkflowPath === workflowPath) return;
    session.boundWorkflowPath = workflowPath;
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

    // A throw here — spawnFn itself, or loadDefaultSpawn() above (a broken
    // node-pty prebuild surfaces there, not at import time) — propagates to
    // create()/resume(), which own reconciling the session record to
    // "exited" for every pre-pty failure, not just this one.
    const pty: IPty = spawnFn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: spec.cwd,
      env,
    });

    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    const handle: PtyHandle = { pty, buffer: "", emitter, spawnedAt: Date.now() };
    this.ptys.set(session.id, handle);

    session.status = "running";
    // A resumed session may carry `ready: true` from its previous life —
    // this is a fresh pty that hasn't proven itself interactive yet either
    // way (trust dialogs can reappear, e.g. under different sandbox flags).
    session.ready = false;
    session.lastActiveAt = this.now();
    await this.persist();
    this.emitStatus(session);

    pty.onData((chunk) => {
      handle.buffer = (handle.buffer + chunk).slice(-SCROLLBACK_BYTES);
      handle.emitter.emit("data", chunk);
      this.recordActivity(session.id);
    });

    pty.onExit(({ exitCode }) => this.markExited(session.id, handle, exitCode));
  }

  /**
   * Transitions a session to "exited". Shared by node-pty's own `onExit`
   * callback and `kill()`'s missed-event fallback (see `kill()`) — both are
   * racing to be the one that reports a given pty's death, so this is
   * idempotent: a stale/duplicate call (`this.ptys.get(id) !== handle`,
   * i.e. this handle was already replaced or already reported exited) is a
   * silent no-op rather than double-transitioning or clobbering a newer
   * session/handle that's since taken its place (e.g. a resume).
   */
  private markExited(id: string, handle: PtyHandle, exitCode: number | null): void {
    if (this.ptys.get(id) !== handle) return;
    this.ptys.delete(id);
    this.lastActivityBroadcast.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    void this.transitionExited(session, exitCode);
  }

  /**
   * The single place a session record flips to "exited" — shared by
   * `markExited()` (live-pty deaths), `create()`/`resume()`'s pre-pty
   * failure reconciliation, `kill()`'s stale-record path, and
   * `sweepDeadSessions()`. Returns the persist promise so callers that need
   * the registry durably updated before rethrowing (create/resume) can
   * await it; event-driven callers fire-and-forget it like any other write.
   */
  private transitionExited(session: HarnessSession, exitCode: number | null): Promise<void> {
    session.status = "exited";
    session.exitCode = exitCode;
    session.lastActiveAt = this.now();
    const persisted = this.persist();
    this.emitStatus(session);
    return persisted;
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
