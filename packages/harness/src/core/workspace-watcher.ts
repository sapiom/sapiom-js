/**
 * Workspace watcher: notices when workflows are added to / removed from a
 * session's workspace directory DURING a session, so the rail can be re-scanned
 * and re-broadcast instead of staying frozen at whatever the boot/session-create
 * scan found. Users scaffold new workflows (and delete old ones) mid-session and
 * expect the rail to keep up.
 *
 * Modeled on core/canvas-watcher.ts (same recursive-fs.watch-with-polling-
 * fallback shape, same per-session lifecycle), but tuned to STRUCTURAL change
 * rather than content change. It fires only when the SET of workflow-marker
 * directories under the workspace actually changes (a workflow appearing,
 * disappearing, or being renamed) — never for ordinary file edits:
 *
 *   - A raw watch event only *arms* a check; the debounced check recomputes
 *     the workflow-marker fingerprint and fires `onChange` iff it differs from
 *     the last one. This is deliberately NOT keyed off the `fs.watch` event
 *     type: recursive `fs.watch` on macOS reports `rename` for plain content
 *     writes too, so an event-type filter would spam rescans on every save.
 *     The fingerprint diff is the reliable, cross-platform signal.
 *   - High-churn / irrelevant subtrees (`node_modules`, `.git`, `.sapiom`,
 *     build output) are skipped when arming AND when fingerprinting: a
 *     workflow marker never lives there, and `.sapiom/canvas/renders` in
 *     particular is rewritten on every render.
 *
 * The polling fallback (Linux, or a watcher runtime error) diffs the same
 * fingerprint on an interval, so both paths share one notion of "changed".
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 1_000;

/** Kept in sync with core/workflow-registry.ts's scan: the marker file that
 *  makes a directory a workflow, and how deep the scan looks for it. */
const WORKFLOW_MARKER = "sapiom.json";
const MAX_SCAN_DEPTH = 3;

/** Directories a workflow marker never lives in — skipped both when
 *  fingerprinting and when deciding whether a watch event is relevant.
 *  `.sapiom` covers the canvas renders that are rewritten on every render. */
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", ".sapiom", "dist", "build", ".next"]);

function firstSegmentIgnored(relPath: string): boolean {
  for (const segment of relPath.split(path.sep)) {
    if (segment && IGNORED_DIR_NAMES.has(segment)) return true;
  }
  return false;
}

/**
 * Fingerprint of the set of workflow-marker directories under `root` (sorted,
 * bounded depth, ignored subtrees skipped). Changes exactly when a workflow is
 * added, removed, or renamed — not when unrelated files are edited. Exported
 * for the polling fallback and for direct testing.
 */
export function snapshotWorkspaceWorkflows(root: string): string {
  const markerDirs: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A directory carrying the marker is itself a workflow — record it and
    // don't descend (matches the registry's scan semantics).
    if (entries.some((entry) => entry.isFile() && entry.name === WORKFLOW_MARKER)) {
      markerDirs.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return markerDirs.sort().join("|");
}

/** One session's workspace watcher. */
class SessionWorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSnapshot = "";

  constructor(
    private readonly cwd: string,
    private readonly harnessSessionId: string,
    private readonly onChange: (harnessSessionId: string) => void,
  ) {
    this.lastSnapshot = snapshotWorkspaceWorkflows(this.cwd);
    this.arm();
  }

  /** Debounced check: recompute the fingerprint and fire only on a real change. */
  private scheduleCheck(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.checkNow(), DEBOUNCE_MS);
  }

  private checkNow(): void {
    if (this.closed) return;
    const snapshot = snapshotWorkspaceWorkflows(this.cwd);
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.onChange(this.harnessSessionId);
  }

  private isRelevantPath(filename: string | null): boolean {
    // A `null` filename means the platform couldn't say what changed — check
    // to be safe rather than miss a new/removed workflow.
    if (!filename) return true;
    return !firstSegmentIgnored(filename);
  }

  private arm(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(this.cwd, { recursive: true }, (_event, filename) => {
        if (this.isRelevantPath(filename)) this.scheduleCheck();
      });
      this.watcher.on("error", () => this.fallBackToPolling());
    } catch {
      // `recursive` isn't supported on this platform (notably Linux).
      this.fallBackToPolling();
    }
  }

  private fallBackToPolling(): void {
    if (this.closed || this.pollTimer) return;
    this.watcher?.close();
    this.watcher = null;
    this.pollTimer = setInterval(() => this.checkNow(), POLL_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}

export interface WorkspaceWatcherManagerDeps {
  /** Debounced per-session notification that the workspace's workflow set may
   *  have changed — the integrator re-scans that session's cwd and broadcasts
   *  `workflows.changed` if the list actually changed. */
  onChange(harnessSessionId: string): void;
}

/** Registry of one SessionWorkspaceWatcher per active harness session. */
export class WorkspaceWatcherManager {
  private readonly watchers = new Map<string, SessionWorkspaceWatcher>();

  constructor(private readonly deps: WorkspaceWatcherManagerDeps) {}

  /** Idempotent: replaces any existing watcher for this session. */
  start(harnessSessionId: string, cwd: string): void {
    this.stop(harnessSessionId);
    this.watchers.set(
      harnessSessionId,
      new SessionWorkspaceWatcher(cwd, harnessSessionId, (id) => this.deps.onChange(id)),
    );
  }

  stop(harnessSessionId: string): void {
    this.watchers.get(harnessSessionId)?.close();
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
