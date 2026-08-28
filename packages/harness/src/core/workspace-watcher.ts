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
 * the workflow registry. The async production fingerprint covers that same
 * 10k-directory envelope and is shared once per canonical root.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SharedWorkspaceWatchBrokerLike } from "./system-graph-watcher.js";
import {
  AGENT_PROJECT_SCAN_MAX_NODES,
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
const SOURCE_FINGERPRINT_MAX_FILES = 10_000;
const SOURCE_FINGERPRINT_TRUNCATED = "<source-files-truncated>";
export const WORKFLOW_SOURCE_OBSERVATION_MAX_PROBES = 10_000;
const SOURCE_OBSERVATION_TRUNCATED = "<source-observations-truncated>";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function addUnreadableFingerprint(fingerprints: string[], dir: string): void {
  fingerprints.push(`${dir}\0${UNREADABLE_FINGERPRINT}`);
}

/** A fresh watch budget — tighter than a registry scan's, because this walk is
 *  synchronous and re-runs on the debounce after every save. */
function watchBudget(): AgentProjectScanBudget {
  return new AgentProjectScanBudget({ maxNodes: AGENT_PROJECT_SCAN_MAX_NODES });
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
  fingerprints.push(
    `${root}\0${TRUNCATED_FINGERPRINT}@${budget.truncatedAtDepth}`,
  );
}

function encodeFingerprint(parts: string[]): string {
  return parts
    .sort()
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("");
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
  const segments = relPath.split(path.sep).filter(Boolean);
  const ignoredIndex = segments.findIndex((segment) =>
    isAgentProjectScanIgnoredDir(segment),
  );
  // The boundary entry itself is structural: `git init` beneath a discovered
  // candidate must retire it from the containing scan. Only churn below an
  // already-established ignored directory is irrelevant.
  return ignoredIndex >= 0 && ignoredIndex < segments.length - 1;
}

function sourceEntries(entries: fs.Dirent[]): fs.Dirent[] {
  return entries
    .filter((entry) => entry.name === "index.ts")
    .sort((left, right) => left.name.localeCompare(right.name));
}

function addSourceFileFingerprint(
  fingerprints: string[],
  filePath: string,
  stat: import("node:fs").Stats,
): void {
  fingerprints.push(
    `${filePath}\0source:${
      stat.isFile() && !stat.isSymbolicLink()
        ? `file:${stat.size}:${stat.mtimeMs}`
        : stat.isDirectory() && !stat.isSymbolicLink()
          ? `directory:${stat.size}:${stat.mtimeMs}`
          : "not-regular"
    }`,
  );
}

/**
 * Fingerprint of the set of workflow-marker directories under `root` (sorted,
 * bounded by depth AND by directories visited, ignored subtrees skipped), plus
 * opaque sentinels for subtrees that are temporarily unreadable or that the
 * node budget kept the walk out of. Changes when a workflow is added, removed,
 * renamed, or crosses one of those boundaries — not when unrelated readable
 * files are edited. Exported for direct testing.
 *
 * The synchronous form remains for the session watcher, whose constructor
 * requires an immediate baseline. Project-graph watchers use the async form
 * for startup, native-event checks, and polling so a wide Project never walks
 * synchronously on the server loop.
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
  let sourceFiles = 0;
  let sourceFilesTruncated = false;
  walkAgentProjectTree(
    root,
    {
      onDirectory: (dir) =>
        fingerprintDirectory(
          markerDirs,
          dir,
          inspectAgentProjectMarkerSync(dir),
        ),
      onAdmittedDirectory: (dir, _depth, entries) => {
        for (const entry of sourceEntries(entries)) {
          if (sourceFiles >= SOURCE_FINGERPRINT_MAX_FILES) {
            sourceFilesTruncated = true;
            break;
          }
          sourceFiles += 1;
          const filePath = path.join(dir, entry.name);
          try {
            addSourceFileFingerprint(
              markerDirs,
              filePath,
              fs.lstatSync(filePath),
            );
          } catch {
            markerDirs.push(`${filePath}\0${UNREADABLE_FINGERPRINT}`);
          }
        }
        return "descend";
      },
      onUnreadable: (dir) => addUnreadableFingerprint(markerDirs, dir),
    },
    budget,
  );
  if (sourceFilesTruncated) {
    markerDirs.push(`${path.resolve(root)}\0${SOURCE_FINGERPRINT_TRUNCATED}`);
  }
  addTruncatedFingerprint(markerDirs, path.resolve(root), budget);
  return encodeFingerprint(markerDirs);
}

/**
 * Async variant for graph watcher baselines/event checks and polling
 * fallbacks — yields between directories so a wide workspace cannot stutter
 * the event loop. Produces the same fingerprint as the sync version. Exported
 * for direct testing.
 */
export async function snapshotWorkspaceWorkflowsAsync(
  root: string,
  budget: AgentProjectScanBudget = watchBudget(),
): Promise<string> {
  const markerDirs: string[] = [];
  let sourceFiles = 0;
  let sourceFilesTruncated = false;
  await walkAgentProjectTreeAsync(
    root,
    {
      onDirectory: async (dir) =>
        fingerprintDirectory(
          markerDirs,
          dir,
          await inspectAgentProjectMarker(dir),
        ),
      onAdmittedDirectory: async (
        dir,
        _depth,
        entries,
      ): Promise<AgentProjectWalkAction> => {
        for (const entry of sourceEntries(entries)) {
          if (sourceFiles >= SOURCE_FINGERPRINT_MAX_FILES) {
            sourceFilesTruncated = true;
            break;
          }
          sourceFiles += 1;
          const filePath = path.join(dir, entry.name);
          try {
            addSourceFileFingerprint(
              markerDirs,
              filePath,
              await fs.promises.lstat(filePath),
            );
          } catch {
            markerDirs.push(`${filePath}\0${UNREADABLE_FINGERPRINT}`);
          }
        }
        return "descend";
      },
      onUnreadable: (dir) => addUnreadableFingerprint(markerDirs, dir),
    },
    budget,
  );
  if (sourceFilesTruncated) {
    markerDirs.push(`${path.resolve(root)}\0${SOURCE_FINGERPRINT_TRUNCATED}`);
  }
  addTruncatedFingerprint(markerDirs, path.resolve(root), budget);
  return encodeFingerprint(markerDirs);
}

export interface WorkflowSourceObservation {
  candidateRoot: string;
  workspaceRoot: string;
  paths: readonly string[];
}

export interface WorkflowSourceSnapshotOptions {
  /** Test seam; production uses one fixed per-workspace observation budget. */
  maxObservationProbes?: number;
  onObservationProbe?: (path: string) => void;
  /** Counts bounded path candidates considered before confinement/deduping. */
  onObservationCandidate?: (path: string) => void;
}

/**
 * Select observation envelopes admitted by a containing watcher scope.
 * A parent watcher needs direct-child observations for rows retained behind a
 * repository/ignore/stop boundary, while a narrow child must never inherit a
 * broader parent's sibling probes.
 */
export function sourceObservationsWithinScope(
  scopeRoot: string,
  observations: readonly WorkflowSourceObservation[],
): WorkflowSourceObservation[] {
  const absoluteScope = path.resolve(scopeRoot);
  return observations.filter((entry) => {
    const workspaceRoot = path.resolve(entry.workspaceRoot);
    const candidateRoot = path.resolve(entry.candidateRoot);
    return (
      confinedObservedPath(absoluteScope, workspaceRoot) &&
      confinedObservedPath(workspaceRoot, candidateRoot)
    );
  });
}

function confinedObservedPath(
  workspaceRoot: string,
  observed: string,
): boolean {
  const relative = path.relative(workspaceRoot, observed);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function admittedObservedStat(
  workspaceRoot: string,
  observed: string,
): Promise<
  | { status: "stat"; stat: import("node:fs").Stats }
  | { status: "absent" | "unreadable" | "inadmissible" }
> {
  const canonicalWorkspace = path.resolve(workspaceRoot);
  const lexicalObserved = path.resolve(observed);
  if (!confinedObservedPath(canonicalWorkspace, lexicalObserved)) {
    return { status: "inadmissible" };
  }
  const relativeDirectory = path.relative(
    canonicalWorkspace,
    path.dirname(lexicalObserved),
  );
  let directory = canonicalWorkspace;
  for (const segment of [
    "",
    ...relativeDirectory.split(path.sep).filter(Boolean),
  ]) {
    if (segment) directory = path.join(directory, segment);
    let directoryStat: import("node:fs").Stats;
    try {
      directoryStat = await fs.promises.lstat(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        status:
          code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable",
      };
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { status: "inadmissible" };
    }
    if (directory !== canonicalWorkspace) {
      try {
        await fs.promises.lstat(path.join(directory, ".git"));
        return { status: "inadmissible" };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          return { status: "unreadable" };
        }
      }
    }
  }
  try {
    return { status: "stat", stat: await fs.promises.lstat(lexicalObserved) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable",
    };
  }
}

/**
 * Bounded metadata snapshots for registered marker roots plus exactly the
 * module candidates the accepted syntax analyzer observed (including absent
 * resolution targets). This deliberately does not invent a second recursive
 * TypeScript traversal policy.
 */
export async function snapshotWorkflowSourceRootsAsync(
  sourceRoots: readonly string[],
  sourceObservations: readonly WorkflowSourceObservation[] = [],
  options: WorkflowSourceSnapshotOptions = {},
): Promise<ReadonlyMap<string, string>> {
  const roots = [
    ...new Set([
      ...sourceRoots.map((root) => path.resolve(root)),
      ...sourceObservations.map((entry) => path.resolve(entry.candidateRoot)),
    ]),
  ].sort();
  const snapshots = new Map<string, string>();
  const observationsByRoot = new Map<
    string,
    Array<{ workspaceRoot: string; paths: readonly string[] }>
  >();
  for (const entry of sourceObservations) {
    const candidateRoot = path.resolve(entry.candidateRoot);
    const workspaceRoot = path.resolve(entry.workspaceRoot);
    const entries = observationsByRoot.get(candidateRoot) ?? [];
    entries.push({ workspaceRoot, paths: entry.paths });
    observationsByRoot.set(candidateRoot, entries);
  }

  type ObservedProbe = { workspaceRoot: string; observed: string };
  interface ObservationCursor {
    entries: Array<{ workspaceRoot: string; paths: readonly string[] }>;
    entryIndex: number;
    pathIndex: number;
    seen: Set<string>;
    declaredCount: number;
    exhausted: boolean;
  }
  const cursors = new Map<string, ObservationCursor>();
  for (const [root, entries] of observationsByRoot) {
    const sortedEntries = [...entries].sort((left, right) =>
      left.workspaceRoot.localeCompare(right.workspaceRoot),
    );
    cursors.set(root, {
      entries: sortedEntries,
      entryIndex: 0,
      pathIndex: 0,
      seen: new Set(),
      declaredCount: sortedEntries.reduce(
        (count, entry) => count + entry.paths.length,
        0,
      ),
      exhausted: false,
    });
  }

  // Divide the fixed global allowance across candidate roots before taking a
  // second path from any root. This prevents one large early-sorted project
  // from permanently blinding later projects while keeping unchanged samples
  // byte-stable across polling passes.
  const selectedByRoot = new Map<string, ObservedProbe[]>();
  const observationRoots = roots.filter((root) => cursors.has(root));
  let remaining = Math.max(
    0,
    options.maxObservationProbes ?? WORKFLOW_SOURCE_OBSERVATION_MAX_PROBES,
  );
  let candidatesRemaining = remaining * 4;
  const nextProbe = (root: string): ObservedProbe | null => {
    const cursor = cursors.get(root);
    if (!cursor || cursor.exhausted) return null;
    while (candidatesRemaining > 0) {
      const entry = cursor.entries[cursor.entryIndex];
      if (!entry) {
        cursor.exhausted = true;
        return null;
      }
      const raw = entry.paths[cursor.pathIndex];
      if (raw === undefined) {
        cursor.entryIndex += 1;
        cursor.pathIndex = 0;
        continue;
      }
      cursor.pathIndex += 1;
      candidatesRemaining -= 1;
      options.onObservationCandidate?.(raw);
      if (!path.isAbsolute(raw)) continue;
      const observed = path.resolve(raw);
      if (!confinedObservedPath(entry.workspaceRoot, observed)) continue;
      const key = `${entry.workspaceRoot}\0${observed}`;
      if (cursor.seen.has(key)) continue;
      cursor.seen.add(key);
      return { workspaceRoot: entry.workspaceRoot, observed };
    }
    return null;
  };
  while (remaining > 0 && candidatesRemaining > 0) {
    let selected = false;
    for (const root of observationRoots) {
      if (remaining === 0) break;
      const probe = nextProbe(root);
      if (!probe) continue;
      const accepted = selectedByRoot.get(root) ?? [];
      accepted.push(probe);
      selectedByRoot.set(root, accepted);
      remaining -= 1;
      selected = true;
    }
    if (!selected) break;
  }

  for (const root of roots) {
    const parts = [`root\0${root}`];
    const marker = await inspectAgentProjectMarker(root);
    parts.push(
      `marker\0${
        marker.status === "valid"
          ? JSON.stringify(marker.marker)
          : marker.status
      }`,
    );
    // Sample the direct entrypoint family for every retained root before any
    // optional analyzer observations. Late sorted roots therefore remain
    // visible even at the global analyzer lookup bound.
    for (const entrypoint of [path.join(root, "index.ts")]) {
      try {
        addSourceFileFingerprint(
          parts,
          entrypoint,
          await fs.promises.lstat(entrypoint),
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        parts.push(
          `${entrypoint}\0${
            code === "ENOENT" || code === "ENOTDIR"
              ? "<absent>"
              : UNREADABLE_FINGERPRINT
          }`,
        );
      }
    }
    let currentEnvelope: string | null = null;
    for (const { workspaceRoot, observed } of selectedByRoot.get(root) ?? []) {
      if (currentEnvelope !== workspaceRoot) {
        parts.push(`envelope\0${workspaceRoot}`);
        currentEnvelope = workspaceRoot;
      }
      options.onObservationProbe?.(observed);
      const observationState = await admittedObservedStat(
        workspaceRoot,
        observed,
      );
      if (observationState.status === "stat") {
        addSourceFileFingerprint(parts, observed, observationState.stat);
      } else {
        parts.push(`${observed}\0<${observationState.status}>`);
      }
    }
    const declaredCount = cursors.get(root)?.declaredCount ?? 0;
    const selectedProbes = selectedByRoot.get(root) ?? [];
    if (selectedProbes.length < declaredCount) {
      parts.push(
        `${root}\0${SOURCE_OBSERVATION_TRUNCATED}:${selectedProbes.length}/${declaredCount}`,
      );
    }
    snapshots.set(root, encodeFingerprint(parts));
  }
  return snapshots;
}

/** One session's workspace watcher. */
class SessionWorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSnapshot: string | null = null;
  private lastWorkspaceSnapshot: string | null = null;
  private lastSourceSnapshots: ReadonlyMap<string, string> | null = null;
  private baselineReady = false;
  private potentialChangeDuringBaseline = false;
  private reconciliationPending = false;
  private checkInFlight = false;
  private checkPending = false;
  private retryCount = 0;

  constructor(
    private readonly cwd: string,
    private readonly harnessSessionId: string,
    private readonly onChange: (
      harnessSessionId: string,
      sourceRoots: readonly string[] | null,
    ) => void | Promise<void>,
    private readonly onPotentialChange?: (harnessSessionId: string) => void,
    private readonly listSourceRoots?: (
      harnessSessionId: string,
      cwd: string,
    ) => readonly string[],
    private readonly listSourceObservations?: (
      harnessSessionId: string,
      cwd: string,
    ) => readonly WorkflowSourceObservation[],
  ) {
    // Arm first. A source edit that lands while the async baseline is walking
    // is recorded and forces reconciliation after the baseline settles.
    this.arm();
    this.checkNowAsync();
  }

  private scheduleCheck(delay = DEBOUNCE_MS): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.checkNowAsync();
    }, delay);
  }

  private checkNowAsync(): void {
    if (this.closed) return;
    if (this.checkInFlight) {
      this.checkPending = true;
      return;
    }
    this.checkInFlight = true;
    this.checkPending = false;
    let sourceRoots: readonly string[] = [];
    let sourceObservations: readonly WorkflowSourceObservation[] = [];
    try {
      sourceRoots =
        this.listSourceRoots?.(this.harnessSessionId, this.cwd) ?? [];
      sourceObservations =
        this.listSourceObservations?.(this.harnessSessionId, this.cwd) ?? [];
    } catch {
      // The workspace fingerprint still provides bounded structural coverage.
    }
    void Promise.all([
      snapshotWorkspaceWorkflowsAsync(this.cwd),
      snapshotWorkflowSourceRootsAsync(sourceRoots, sourceObservations),
    ])
      .then(async ([workspaceSnapshot, sourceSnapshots]) => {
        if (this.closed) return;
        const snapshot = encodeFingerprint([
          `workspace\0${workspaceSnapshot}`,
          ...[...sourceSnapshots].map(
            ([sourceRoot, sourceSnapshot]) =>
              `source-root\0${sourceRoot}\0${sourceSnapshot}`,
          ),
        ]);
        if (!this.baselineReady) {
          this.baselineReady = true;
          this.lastSnapshot = snapshot;
          this.lastWorkspaceSnapshot = workspaceSnapshot;
          this.lastSourceSnapshots = sourceSnapshots;
          if (this.potentialChangeDuringBaseline) {
            this.potentialChangeDuringBaseline = false;
            this.reconciliationPending = false;
            const retainedRoots = [...sourceSnapshots.keys()].sort();
            await this.onChange(
              this.harnessSessionId,
              retainedRoots.length > 0 ? retainedRoots : null,
            );
          }
          this.retryCount = 0;
          return;
        }
        const mustReconcile = this.reconciliationPending;
        this.reconciliationPending = false;
        if (snapshot === this.lastSnapshot && !mustReconcile) return;
        const workspaceChanged =
          workspaceSnapshot !== this.lastWorkspaceSnapshot;
        const changedSourceRoots = this.lastSourceSnapshots
          ? [
              ...new Set([
                ...this.lastSourceSnapshots.keys(),
                ...sourceSnapshots.keys(),
              ]),
            ]
              .filter(
                (sourceRoot) =>
                  this.lastSourceSnapshots!.get(sourceRoot) !==
                  sourceSnapshots.get(sourceRoot),
              )
              .sort()
          : [];
        // Polling has no native raw event, so fail closed at the first
        // observed fingerprint delta before scheduling reconciliation.
        this.onPotentialChange?.(this.harnessSessionId);
        await this.onChange(
          this.harnessSessionId,
          workspaceChanged || changedSourceRoots.length === 0
            ? null
            : changedSourceRoots,
        );
        if (this.closed) return;
        this.lastSnapshot = snapshot;
        this.lastWorkspaceSnapshot = workspaceSnapshot;
        this.lastSourceSnapshots = sourceSnapshots;
        this.retryCount = 0;
      })
      .catch(() => {
        if (this.closed) return;
        this.reconciliationPending = true;
        this.retryCount += 1;
        this.scheduleCheck(Math.min(2_000, 250 * 2 ** (this.retryCount - 1)));
      })
      .finally(() => {
        this.checkInFlight = false;
        if (this.closed || !this.checkPending) return;
        this.checkPending = false;
        this.checkNowAsync();
      });
  }

  private isRelevantPath(filename: string | null): boolean {
    // A `null` filename means the platform couldn't say what changed — check
    // to be safe rather than miss a new/removed workflow.
    if (!filename) return true;
    return !firstSegmentIgnored(filename);
  }

  private requiresImmediateInvalidation(
    event: "rename" | "change",
    filename: string | null,
  ): boolean {
    if (!filename) return true;
    if (event === "rename") return true;
    const normalized = filename.replace(/\\/g, "/");
    const basename = path.posix.basename(normalized);
    return (
      basename === "sapiom.json" ||
      basename === "package.json" ||
      SOURCE_EXTENSIONS.has(path.posix.extname(basename)) ||
      path.posix.extname(basename) === ""
    );
  }

  private arm(): void {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(
        this.cwd,
        { recursive: true },
        (event, filename) => {
          if (!this.isRelevantPath(filename)) return;
          if (this.requiresImmediateInvalidation(event, filename)) {
            this.onPotentialChange?.(this.harnessSessionId);
            this.reconciliationPending = true;
            if (!this.baselineReady) this.potentialChangeDuringBaseline = true;
          }
          this.scheduleCheck();
        },
      );
      this.watcher.on("error", () => this.fallBackToPolling());
    } catch {
      // `recursive` isn't supported on this platform (notably Linux).
      this.fallBackToPolling();
    }
  }

  private fallBackToPolling(): void {
    if (this.closed || this.pollTimer) return;
    if (!this.baselineReady) {
      // With no native watcher there is no raw event to distinguish an edit
      // absorbed into the first async sample. Reconcile once after that sample
      // and let subsequent polls be strict fingerprint deltas.
      this.potentialChangeDuringBaseline = true;
    }
    this.watcher?.close();
    this.watcher = null;
    this.scheduleCheck(0);
    this.pollTimer = setInterval(() => this.checkNowAsync(), POLL_INTERVAL_MS);
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
  onChange(
    harnessSessionId: string,
    sourceRoots: readonly string[] | null,
  ): void | Promise<void>;
  /** Immediate raw-event fail-close hook; never waits for debounce/fingerprint. */
  onPotentialChange?(harnessSessionId: string): void;
  /** Registered roots are sampled even when a discovered parent stops BFS. */
  listSourceRoots?(harnessSessionId: string, cwd: string): readonly string[];
  listSourceObservations?(
    harnessSessionId: string,
    cwd: string,
  ): readonly WorkflowSourceObservation[];
  /** Test/debug lifecycle signal; fires only for a newly armed root lease. */
  onWatcherStarted?(harnessSessionId: string, cwd: string): void;
  /** Process-wide lease shared with graph watchers in production. */
  sharedWatchBroker?: SharedWorkspaceWatchBrokerLike;
}

/** Registry of one SessionWorkspaceWatcher per active harness session. */
export class WorkspaceWatcherManager {
  private readonly watchers = new Map<
    string,
    { cwd: string; watcher: SessionWorkspaceWatcher }
  >();
  private readonly sharedSubscriptions = new Map<
    string,
    { cwd: string; key: object }
  >();

  constructor(private readonly deps: WorkspaceWatcherManagerDeps) {}

  /** Idempotent for repeated running/binding frames at the same session root. */
  start(harnessSessionId: string, cwd: string): void {
    const canonicalCwd = path.resolve(cwd);
    const existingShared = this.sharedSubscriptions.get(harnessSessionId);
    if (existingShared?.cwd === canonicalCwd) return;
    const existing = this.watchers.get(harnessSessionId);
    if (existing?.cwd === canonicalCwd) return;
    this.stop(harnessSessionId);
    const retainedRootList = (): readonly string[] =>
      this.deps.listSourceRoots?.(harnessSessionId, canonicalCwd) ?? [];
    const retainedRoots = (): readonly string[] | null => {
      const roots = retainedRootList();
      return roots.length > 0 ? roots : null;
    };
    const candidateRootsForPaths = (
      sourcePaths: readonly string[] | null,
    ): readonly string[] | null => {
      if (sourcePaths === null) return retainedRoots();
      const candidates = retainedRootList()
        .map((root) => path.resolve(root))
        .sort((left, right) => right.length - left.length);
      const mapped = new Set<string>();
      for (const sourcePath of sourcePaths) {
        const absoluteSourcePath = path.resolve(sourcePath);
        const candidate = candidates.find((root) => {
          const relative = path.relative(root, absoluteSourcePath);
          return (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        });
        if (candidate) mapped.add(candidate);
      }
      // New, unregistered index.ts candidates are reconciled by the parent cwd
      // that the server always appends. Existing roots hidden behind a repo or
      // ignored boundary must instead be scanned directly; never pass the file
      // path itself to the registry as though it were a project root.
      return [...mapped].sort();
    };
    if (this.deps.sharedWatchBroker) {
      const key = {};
      this.sharedSubscriptions.set(harnessSessionId, {
        cwd: canonicalCwd,
        key,
      });
      void this.deps.sharedWatchBroker
        .subscribe(key, {
          scope: {
            workspaceKey: `session:${harnessSessionId}`,
            root: canonicalCwd,
          },
          listSourceRoots: () =>
            this.deps.listSourceRoots?.(harnessSessionId, canonicalCwd) ?? [],
          listSourceObservations: () =>
            this.deps.listSourceObservations?.(
              harnessSessionId,
              canonicalCwd,
            ) ?? [],
          onPotentialChange: () =>
            this.deps.onPotentialChange?.(harnessSessionId),
          onSourceChange: (sourcePaths) =>
            this.deps.onChange(
              harnessSessionId,
              candidateRootsForPaths(sourcePaths),
            ),
          onInventoryChange: () => this.deps.onChange(harnessSessionId, null),
        })
        .catch(() => {
          const current = this.sharedSubscriptions.get(harnessSessionId);
          if (current?.key === key) {
            this.sharedSubscriptions.delete(harnessSessionId);
          }
        });
      this.deps.onWatcherStarted?.(harnessSessionId, canonicalCwd);
      return;
    }
    const watcher = new SessionWorkspaceWatcher(
      canonicalCwd,
      harnessSessionId,
      (id, sourceRoots) =>
        this.deps.onChange(id, sourceRoots ?? retainedRoots()),
      (id) => this.deps.onPotentialChange?.(id),
      (id, root) => this.deps.listSourceRoots?.(id, root) ?? [],
      (id, root) => this.deps.listSourceObservations?.(id, root) ?? [],
    );
    this.watchers.set(harnessSessionId, { cwd: canonicalCwd, watcher });
    this.deps.onWatcherStarted?.(harnessSessionId, canonicalCwd);
  }

  stop(harnessSessionId: string): void {
    const shared = this.sharedSubscriptions.get(harnessSessionId);
    if (shared) this.deps.sharedWatchBroker?.unsubscribe(shared.key);
    this.sharedSubscriptions.delete(harnessSessionId);
    this.watchers.get(harnessSessionId)?.watcher.close();
    this.watchers.delete(harnessSessionId);
  }

  stopAll(): void {
    const tracked = new Set([
      ...this.watchers.keys(),
      ...this.sharedSubscriptions.keys(),
    ]);
    for (const harnessSessionId of tracked) this.stop(harnessSessionId);
  }

  /** Test/debug helper — how many sessions currently have an active watcher. */
  get size(): number {
    return this.watchers.size + this.sharedSubscriptions.size;
  }
}
