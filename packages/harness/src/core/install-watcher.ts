/**
 * Install watcher: bridges the gap between a freshly scaffolded agent project
 * and its `npm install` finishing. A brand-new project renders a calm
 * "preparing" placeholder because its dependencies aren't installed yet
 * (core/canvas-render.ts's `depsMissing` path). Neither the canvas watcher nor
 * the workspace watcher can re-fire the render when install completes — both
 * deliberately ignore `node_modules` (it's high-churn, and a workflow marker
 * never lives there). So without this, the placeholder would sit forever and
 * the user would have to hit Retry. This watcher notices the SDK landing and
 * lets the server re-render automatically.
 *
 * It POLLS a precise marker (core/agent-deps.ts — the SDK package esbuild must
 * resolve) rather than `fs.watch`ing `node_modules`: polling one path avoids
 * the churn both other watchers avoid, is deterministic, and — keyed on the
 * exact package the bundle needs — never fires on a half-populated
 * `node_modules`. One-shot: it fires `onInstalled` once and closes. If install
 * never completes within a bounded window (offline, npm missing on PATH in a
 * stripped host), it fires `onTimeout` so the server can restore the honest
 * error panel — the placeholder is for the normal install window, not a dead
 * end.
 */
import { agentDepsInstalledSync } from "./agent-deps.js";

const DEFAULT_POLL_INTERVAL_MS = 750;
/** How long to wait for install before giving up and restoring the honest
 *  error. Generous — a cold `npm install` on a slow network can run a while. */
const DEFAULT_TIMEOUT_MS = 180_000;

export interface InstallWatcherOptions {
  /** Poll cadence in ms (test hook). */
  pollIntervalMs?: number;
  /** Max wait before `onTimeout` fires (test hook). */
  timeoutMs?: number;
}

/** One session's install watcher — polls until the project's deps are
 *  installed, then fires exactly once and stops itself. */
class SessionInstallWatcher {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly projectDir: string,
    private readonly harnessSessionId: string,
    private readonly onInstalled: (harnessSessionId: string) => void,
    private readonly onTimeout: (harnessSessionId: string) => void,
    options: InstallWatcherOptions = {},
  ) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Deps may already be present the moment we arm (install finished between
    // the render deciding `depsMissing` and the server arming us) — check on
    // the next tick so the manager has finished registering this watcher
    // before any callback can fire and re-enter it.
    this.pollTimer = setInterval(() => this.check(), pollIntervalMs);
    this.pollTimer.unref?.();
    setTimeout(() => this.check(), 0).unref?.();

    this.timeoutTimer = setTimeout(() => {
      if (this.closed) return;
      this.close();
      this.onTimeout(this.harnessSessionId);
    }, timeoutMs);
    this.timeoutTimer.unref?.();
  }

  private check(): void {
    if (this.closed) return;
    if (!agentDepsInstalledSync(this.projectDir)) return;
    this.close();
    this.onInstalled(this.harnessSessionId);
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.pollTimer = null;
    this.timeoutTimer = null;
  }
}

export interface InstallWatcherManagerDeps {
  /** Dependencies are now installed for this session's project — re-render. */
  onInstalled(harnessSessionId: string): void;
  /** Install didn't complete within the window — restore the honest error. */
  onTimeout(harnessSessionId: string): void;
}

/** Registry of one SessionInstallWatcher per session currently waiting on an
 *  install. Arm from a `depsMissing` render; it self-removes on fire. */
export class InstallWatcherManager {
  private readonly watchers = new Map<
    string,
    { projectDir: string; watcher: SessionInstallWatcher }
  >();

  constructor(
    private readonly deps: InstallWatcherManagerDeps,
    private readonly options: InstallWatcherOptions = {},
  ) {}

  /**
   * Begin (or continue) watching `projectDir` for this session's install.
   * Idempotent for the same project: a repeated `depsMissing` render must NOT
   * reset the timeout. Re-arms only when the watched project actually changed
   * (a rebind to a different workflow).
   */
  start(harnessSessionId: string, projectDir: string): void {
    const existing = this.watchers.get(harnessSessionId);
    if (existing) {
      if (existing.projectDir === projectDir) return;
      existing.watcher.close();
    }
    const watcher = new SessionInstallWatcher(
      projectDir,
      harnessSessionId,
      (id) => this.fire(id, this.deps.onInstalled),
      (id) => this.fire(id, this.deps.onTimeout),
      this.options,
    );
    this.watchers.set(harnessSessionId, { projectDir, watcher });
  }

  /** Removes and closes this session's watcher, then invokes `cb`. Removal
   *  happens first so the callback's own re-render can safely re-arm. */
  private fire(
    harnessSessionId: string,
    cb: (harnessSessionId: string) => void,
  ): void {
    const entry = this.watchers.get(harnessSessionId);
    if (entry) {
      entry.watcher.close();
      this.watchers.delete(harnessSessionId);
    }
    cb(harnessSessionId);
  }

  stop(harnessSessionId: string): void {
    this.watchers.get(harnessSessionId)?.watcher.close();
    this.watchers.delete(harnessSessionId);
  }

  stopAll(): void {
    for (const harnessSessionId of [...this.watchers.keys()]) this.stop(harnessSessionId);
  }

  /** Test/debug helper — how many sessions currently have an active watcher. */
  get size(): number {
    return this.watchers.size;
  }
}
