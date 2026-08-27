/**
 * Workspace watcher: notices when workflows are added to / removed from a
 * session's workspace directory DURING a session, so the rail can be re-scanned
 * and re-broadcast instead of staying frozen at whatever the boot/session-create
 * scan found. Users scaffold new workflows (and delete old ones) mid-session and
 * expect the rail to keep up.
 *
 * Modeled on core/canvas-watcher.ts (same recursive-fs.watch-with-polling-
 * fallback shape, same per-session lifecycle), but tuned to STRUCTURAL change
 * rather than content change. It fires only when the workflow-marker state
 * under the workspace actually changes (a workflow appearing, disappearing,
 * being renamed, or crossing a temporary unreadable boundary) — never for
 * ordinary file edits:
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
 * The fallback walk is async (fs/promises) to avoid blocking the event loop
 * on a wide cwd — the poll interval is longer than the watch debounce,
 * so a filesystem event via the watcher is still the fast path.
 *
 * Both walks run core/agent-project-discovery.ts's shared bounded traversal, so
 * "which directories a scan of this root covers" has one definition here and in
 * the workflow registry. The fingerprint's budget is deliberately the tighter of
 * the two — see AGENT_PROJECT_WATCH_MAX_NODES.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGENT_PROJECT_WATCH_MAX_NODES,
  AgentProjectScanBudget,
  type AgentProjectWalkAction,
  inspectAgentProjectMarker,
  inspectAgentProjectMarkerSync,
  isAgentProjectScanIgnoredDir,
  walkAgentProjectTree,
  walkAgentProjectTreeAsync,
} from "./agent-project-discovery.js";

const DEBOUNCE_MS = 250;
/** Longer than the watch debounce — the watcher path is the fast signal;
 *  the poll is just a backstop for platforms without recursive fs.watch. */
const POLL_INTERVAL_MS = 2_000;
const UNREADABLE_FINGERPRINT = "<unreadable>";
/** Sentinel for "the node budget stopped this walk at depth N" — see
 *  addTruncatedFingerprint. */
const TRUNCATED_FINGERPRINT = "<truncated>";

function addUnreadableFingerprint(fingerprints: string[], dir: string): void {
  fingerprints.push(`${dir}\0${UNREADABLE_FINGERPRINT}`);
}

/** A fresh watch budget — tighter than a registry scan's, because this walk is
 *  synchronous and re-runs on the debounce after every save. */
function watchBudget(): AgentProjectScanBudget {
  return new AgentProjectScanBudget({ maxNodes: AGENT_PROJECT_WATCH_MAX_NODES });
}

/**
 * One sentinel, keyed by root and the depth the node budget cut at, when a walk
 * did not cover the whole tree.
 *
 * It is one entry rather than one per unvisited directory for two reasons: the
 * unvisited frontier can be tens of thousands of directories on a real root,
 * and the cut depth is the only thing about it that is *stable*. The walk is
 * breadth-first over sorted entries, so the cut lands in the same place on
 * every pass over an unchanged tree, and the fingerprint stays put instead of
 * flapping and rescanning the workspace forever.
 */
function addTruncatedFingerprint(
  fingerprints: string[],
  root: string,
  budget: AgentProjectScanBudget,
): void {
  if (!budget.truncated) return;
  fingerprints.push(`${root}\0${TRUNCATED_FINGERPRINT}@${budget.truncatedAtDepth}`);
}

/**
 * Classifies one directory for the fingerprint, shared by the sync and async
 * walks so they cannot disagree. Returns what the walk should do next.
 */
function fingerprintDirectory(
  markerDirs: string[],
  dir: string,
  markerResult: import("./agent-project-discovery.js").AgentProjectMarkerInspection,
): AgentProjectWalkAction {
  if (markerResult.status === "valid") {
    markerDirs.push(`${dir}\0${JSON.stringify(markerResult.marker)}`);
    return "stop";
  }
  // Preserve "temporarily unreadable" as a distinct state. If it collapsed
  // to the same fingerprint as an absent/invalid project, a quick
  // unreadable -> invalid transition could be swallowed by the debounce and
  // leave a stale workflow in the registry until some later filesystem event.
  if (markerResult.status === "unreadable") {
    addUnreadableFingerprint(markerDirs, dir);
    return "stop";
  }
  return "descend";
}

function firstSegmentIgnored(relPath: string): boolean {
  for (const segment of relPath.split(path.sep)) {
    if (segment && isAgentProjectScanIgnoredDir(segment)) return true;
  }
  return false;
}

/**
 * Fingerprint of the set of workflow-marker directories under `root` (sorted,
 * bounded by depth AND by directories visited, ignored subtrees skipped), plus
 * opaque sentinels for subtrees that are temporarily unreadable or that the
 * node budget kept the walk out of. Changes when a workflow is added, removed,
 * renamed, or crosses one of those boundaries — not when unrelated readable
 * files are edited. Exported for direct testing.
 *
 * The synchronous form is retained for callers that need an immediate
 * baseline at construction time (before async I/O is possible). The
 * polling fallback uses the async form to avoid blocking the event loop on
 * a wide directory tree.
 *
 * `budget` is injectable so a benchmark can read the directories visited off
 * the same object the walk spends, and so a test can force truncation. Pass the
 * SAME limits to both forms: the two produce identical fingerprints on one tree
 * only when their bounds match, and SessionWorkspaceWatcher compares a sync
 * baseline against an async poll result.
 */
export function snapshotWorkspaceWorkflows(
  root: string,
  budget: AgentProjectScanBudget = watchBudget(),
): string {
  const markerDirs: string[] = [];
  walkAgentProjectTree(
    root,
    {
      onDirectory: (dir) =>
        fingerprintDirectory(markerDirs, dir, inspectAgentProjectMarkerSync(dir)),
      onUnreadable: (dir) => addUnreadableFingerprint(markerDirs, dir),
    },
    budget,
  );
  addTruncatedFingerprint(markerDirs, path.resolve(root), budget);
  return markerDirs.sort().join("|");
}

/**
 * Async variant used by the polling fallback — yields between directories so
 * a wide workspace can't stutter the event loop on platforms without recursive
 * fs.watch. Produces the same fingerprint as the sync version. Exported for
 * direct testing.
 */
export async function snapshotWorkspaceWorkflowsAsync(
  root: string,
  budget: AgentProjectScanBudget = watchBudget(),
): Promise<string> {
  const markerDirs: string[] = [];
  await walkAgentProjectTreeAsync(
    root,
    {
      onDirectory: async (dir) =>
        fingerprintDirectory(markerDirs, dir, await inspectAgentProjectMarker(dir)),
      onUnreadable: (dir) => addUnreadableFingerprint(markerDirs, dir),
    },
    budget,
  );
  addTruncatedFingerprint(markerDirs, path.resolve(root), budget);
  return markerDirs.sort().join("|");
}

/** One session's workspace watcher. */
class SessionWorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSnapshot = "";
  /** True while checkNowAsync() is running — prevents overlapping poll walks. */
  private pollInFlight = false;

  constructor(
    private readonly cwd: string,
    private readonly harnessSessionId: string,
    private readonly onChange: (harnessSessionId: string) => void,
  ) {
    this.lastSnapshot = snapshotWorkspaceWorkflows(this.cwd);
    this.arm();
  }

  /** Debounced check: recompute the fingerprint and fire only on a real change.
   *  The watcher path uses the sync snapshot (fast, on a single event-loop
   *  tick); the polling path uses the async variant (yields between dirs). */
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

  /** Async variant of the fingerprint check — used by the polling fallback
   *  so the walk doesn't block the event loop on a wide directory tree. */
  private async checkNowAsync(): Promise<void> {
    if (this.closed) return;
    const snapshot = await snapshotWorkspaceWorkflowsAsync(this.cwd);
    if (this.closed) return; // session may have closed during the await
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
    this.pollTimer = setInterval(() => {
      // In-flight guard: skip this tick if a previous walk is still running.
      // A slow/wide workspace walk could otherwise overlap with itself and
      // double-fire onChange on a structural change detected by both walks.
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      this.checkNowAsync()
        .catch(() => {
          // Snapshot errors (permission denied, etc.) are benign — the next
          // tick will retry, same as the sync path silently swallowing them.
        })
        .finally(() => {
          this.pollInFlight = false;
        });
    }, POLL_INTERVAL_MS);
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
