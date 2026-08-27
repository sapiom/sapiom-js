import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { WorkspaceKey } from "../shared/system-graph.js";
import { isAgentProjectScanIgnoredDir } from "./agent-project-discovery.js";
import { normalizeWatchPath } from "./canvas-watcher.js";
import type { WorkspaceScope } from "./system-graph.js";
import { snapshotWorkspaceWorkflowsAsync } from "./workspace-watcher.js";

const SOURCE_DEBOUNCE_MS = 150;
const INVENTORY_DEBOUNCE_MS = 250;
const INVENTORY_RETRY_BASE_MS = 500;
const MAX_INVENTORY_RETRIES = 3;
const POLL_INTERVAL_MS = 2_000;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const UNREADABLE_SOURCE_FINGERPRINT = "<unreadable>";

function ignoredRelativePath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .filter(Boolean)
    .some((segment) => isAgentProjectScanIgnoredDir(segment));
}

function sourceRelativePath(relativePath: string): boolean {
  return (
    !ignoredRelativePath(relativePath) &&
    SOURCE_EXTENSIONS.has(path.extname(relativePath))
  );
}

function confinedSourcePath(root: string, relativePath: string): string | null {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return absolute;
}

/**
 * Async source fingerprint for the registered agent roots in one workspace.
 *
 * The graph watcher deliberately does not reuse Canvas's synchronous,
 * 400-file project snapshot here: a workspace can contain many agent projects,
 * and polling it on the server event loop would both stutter Studio and miss
 * edits after that project-sized ceiling. Async directory reads yield between
 * entries, while scoping the walk to registry roots keeps the unbounded file
 * count honest without traversing unrelated workspace trees.
 */
export async function snapshotWorkflowSourceRootsAsync(
  sourceRoots: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const roots = [
    ...new Set(sourceRoots.map((root) => path.resolve(root))),
  ].sort();
  const snapshots = new Map<string, string>();

  const walk = async (dir: string, parts: string[]): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      parts.push(`${dir}\0${UNREADABLE_SOURCE_FINGERPRINT}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isAgentProjectScanIgnoredDir(entry.name)) continue;
        await walk(full, parts);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        continue;
      }
      try {
        const stat = await fsp.stat(full);
        parts.push(`${full}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push(`${full}:gone`);
      }
    }
  };

  for (const root of roots) {
    const parts = [`root\0${root}`];
    await walk(root, parts);
    snapshots.set(root, parts.sort().join("|"));
  }
  return snapshots;
}

function isNestedSourceRoot(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function changedSourceRoots(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(
    (root) => previous.get(root) !== current.get(root),
  );
  // Nested registered projects appear in their parent's recursive snapshot.
  // Attribute the edit only to the deepest changed caller(s).
  return changed
    .filter(
      (root) =>
        !changed.some(
          (candidate) =>
            candidate !== root && isNestedSourceRoot(root, candidate),
        ),
    )
    .sort();
}

export interface SystemGraphWatcherCallbacks {
  /** Current registry roots inside this scope; read lazily on every poll. */
  listSourceRoots: (scope: WorkspaceScope) => readonly string[];
  onSourceChange: (
    scope: WorkspaceScope,
    /** Null when the platform can only report a workspace-level change. */
    sourcePaths: readonly string[] | null,
  ) => void | Promise<void>;
  onInventoryChange: (scope: WorkspaceScope) => void | Promise<void>;
}

export interface SystemGraphWatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): SystemGraphWatchHandle;
}

export type SystemGraphWatchFactory = (
  root: string,
  listener: (event: "rename" | "change", filename: string | null) => void,
) => SystemGraphWatchHandle;

export interface SystemGraphWatcherOptions {
  sourceDebounceMs?: number;
  inventoryDebounceMs?: number;
  inventoryRetryBaseMs?: number;
  maxInventoryRetries?: number;
  pollIntervalMs?: number;
  /** Deterministic test seam for the supported polling fallback. */
  forcePolling?: boolean;
  /** Deterministic test seam for native event routing and watcher errors. */
  watchFactory?: SystemGraphWatchFactory;
}

class WorkspaceSystemGraphWatcher {
  private watcher: SystemGraphWatchHandle | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sourceTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private sourcePaths = new Set<string>();
  private ambiguousSourceChange = false;
  private lastSourceSnapshots: ReadonlyMap<string, string> | null = null;
  private lastInventorySnapshot: string;
  private failedInventorySnapshot: string | null = null;
  private inventoryGeneration = 0;
  private inventoryCheckInFlight = false;
  private inventoryCheckPending = false;
  private pollInFlight = false;
  private callbackQueue: Promise<void> = Promise.resolve();

  private constructor(
    readonly scope: WorkspaceScope,
    private readonly callbacks: SystemGraphWatcherCallbacks,
    private readonly options: SystemGraphWatcherOptions,
    initialInventorySnapshot: string,
  ) {
    this.lastInventorySnapshot = initialInventorySnapshot;
    this.arm();
  }

  static async create(
    scope: WorkspaceScope,
    callbacks: SystemGraphWatcherCallbacks,
    options: SystemGraphWatcherOptions,
  ): Promise<WorkspaceSystemGraphWatcher> {
    // Establish the native/polling watcher from an async baseline. The graph
    // route awaits this factory, so no synchronous workspace walk runs on the
    // server loop before the watcher starts.
    const initialInventorySnapshot = await snapshotWorkspaceWorkflowsAsync(
      scope.root,
    );
    return new WorkspaceSystemGraphWatcher(
      scope,
      callbacks,
      options,
      initialInventorySnapshot,
    );
  }

  private enqueue(
    callback: () => void | Promise<void>,
    onFailure?: () => void,
  ): void {
    this.callbackQueue = this.callbackQueue.then(async () => {
      if (this.closed) return;
      try {
        await callback();
      } catch {
        // Watch callbacks are refresh hints. A failed scan/build must not tear
        // down the watcher or affect the rest of Studio.
        try {
          onFailure?.();
        } catch {
          // Failure recovery is best-effort too.
        }
      }
    });
  }

  private scheduleSourceChange(sourcePath: string | null): void {
    if (this.closed) return;
    if (sourcePath === null) this.ambiguousSourceChange = true;
    else this.sourcePaths.add(sourcePath);
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    this.sourceTimer = setTimeout(() => {
      this.sourceTimer = null;
      const paths = this.ambiguousSourceChange
        ? null
        : [...this.sourcePaths].sort();
      this.sourcePaths.clear();
      this.ambiguousSourceChange = false;
      this.enqueue(() => this.callbacks.onSourceChange(this.scope, paths));
    }, this.options.sourceDebounceMs ?? SOURCE_DEBOUNCE_MS);
  }

  private dispatchInventoryChange(
    snapshot: string,
    retryNumber = 0,
    retryGeneration?: number,
  ): void {
    const generation = retryGeneration ?? this.inventoryGeneration + 1;
    if (
      retryGeneration !== undefined &&
      retryGeneration !== this.inventoryGeneration
    ) {
      return;
    }
    if (retryGeneration === undefined) {
      this.inventoryGeneration = generation;
      if (this.inventoryRetryTimer) clearTimeout(this.inventoryRetryTimer);
      this.inventoryRetryTimer = null;
    }
    this.lastInventorySnapshot = snapshot;
    this.failedInventorySnapshot = null;
    this.enqueue(
      () => {
        if (generation !== this.inventoryGeneration) return;
        return this.callbacks.onInventoryChange(this.scope);
      },
      () => {
        if (
          this.closed ||
          generation !== this.inventoryGeneration ||
          this.lastInventorySnapshot !== snapshot
        ) {
          return;
        }
        if (
          retryNumber >=
          (this.options.maxInventoryRetries ?? MAX_INVENTORY_RETRIES)
        ) {
          // Consume the observed fingerprint after bounded recovery. This
          // leaves the server snapshot stale without turning polling into a
          // permanent registry-scan/event-bus loop. A later real source or
          // inventory change clears this sentinel and starts a fresh series.
          this.failedInventorySnapshot = snapshot;
          return;
        }
        this.scheduleInventoryRetry(snapshot, retryNumber + 1, generation);
      },
    );
  }

  private scheduleInventoryRetry(
    snapshot: string,
    retryNumber: number,
    generation: number,
  ): void {
    if (this.closed || generation !== this.inventoryGeneration) return;
    if (this.inventoryRetryTimer) clearTimeout(this.inventoryRetryTimer);
    const delay =
      (this.options.inventoryRetryBaseMs ?? INVENTORY_RETRY_BASE_MS) *
      2 ** (retryNumber - 1);
    this.inventoryRetryTimer = setTimeout(() => {
      this.inventoryRetryTimer = null;
      if (this.closed || generation !== this.inventoryGeneration) return;
      void snapshotWorkspaceWorkflowsAsync(this.scope.root)
        .then((currentSnapshot) => {
          if (this.closed || generation !== this.inventoryGeneration) return;
          if (currentSnapshot !== snapshot) {
            this.dispatchInventoryChange(currentSnapshot);
            return;
          }
          this.dispatchInventoryChange(snapshot, retryNumber, generation);
        })
        .catch(() => {
          if (this.closed || generation !== this.inventoryGeneration) return;
          this.dispatchInventoryChange(snapshot, retryNumber, generation);
        });
    }, delay);
  }

  private scheduleInventoryCheck(
    delay = this.options.inventoryDebounceMs ?? INVENTORY_DEBOUNCE_MS,
  ): void {
    if (this.closed) return;
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = null;
      this.checkInventoryAsync();
    }, delay);
  }

  private checkInventoryAsync(): void {
    if (this.closed) return;
    if (this.inventoryCheckInFlight) {
      // One more async pass after the current walk is enough to cover any
      // number of native events that arrive while it yields between dirs.
      this.inventoryCheckPending = true;
      return;
    }
    this.inventoryCheckInFlight = true;
    this.inventoryCheckPending = false;
    void snapshotWorkspaceWorkflowsAsync(this.scope.root)
      .then((snapshot) => {
        if (this.closed) return;
        if (
          snapshot === this.lastInventorySnapshot &&
          snapshot !== this.failedInventorySnapshot
        ) {
          return;
        }
        this.dispatchInventoryChange(snapshot);
      })
      .catch(() => {
        // A later native event retries an unreadable workspace. Watch hints
        // must never surface as an unhandled rejection or tear down Studio.
      })
      .finally(() => {
        this.inventoryCheckInFlight = false;
        if (this.closed || !this.inventoryCheckPending) return;
        this.inventoryCheckPending = false;
        this.checkInventoryAsync();
      });
  }

  private arm(): void {
    if (this.closed) return;
    if (this.options.forcePolling) {
      this.fallBackToPolling();
      return;
    }
    try {
      const listener = (
        _event: "rename" | "change",
        rawFilename: string | null,
      ): void => {
        if (rawFilename === null) {
          this.scheduleSourceChange(null);
          this.scheduleInventoryCheck();
          return;
        }
        const relativePath = normalizeWatchPath(rawFilename);
        if (ignoredRelativePath(relativePath)) return;
        if (sourceRelativePath(relativePath)) {
          this.scheduleSourceChange(
            confinedSourcePath(this.scope.root, relativePath),
          );
        }
        // Event kind is unreliable across editors/platforms. The marker
        // fingerprint decides whether inventory really changed.
        this.scheduleInventoryCheck();
      };
      this.watcher = this.options.watchFactory
        ? this.options.watchFactory(this.scope.root, listener)
        : fs.watch(
            this.scope.root,
            { recursive: true },
            (_event, rawFilename) => {
              listener(_event, rawFilename);
            },
          );
      this.watcher.on("error", () => this.fallBackToPolling());
    } catch {
      this.fallBackToPolling();
    }
  }

  private fallBackToPolling(): void {
    if (this.closed || this.pollTimer) return;
    let refreshAfterInitialSnapshot = this.watcher !== null;
    this.watcher?.close();
    this.watcher = null;
    const poll = (): void => {
      if (this.closed || this.pollInFlight) return;
      this.pollInFlight = true;
      let sourceRoots: readonly string[] = [];
      try {
        sourceRoots = this.callbacks.listSourceRoots(this.scope);
      } catch {
        // Registry reads are hints too. Inventory polling still proceeds.
      }
      void Promise.all([
        snapshotWorkflowSourceRootsAsync(sourceRoots),
        snapshotWorkspaceWorkflowsAsync(this.scope.root),
      ])
        .then(([sourceSnapshots, inventorySnapshot]) => {
          if (this.closed) return;
          const changedRoots = this.lastSourceSnapshots
            ? changedSourceRoots(this.lastSourceSnapshots, sourceSnapshots)
            : [];
          const ambiguousInitialChange =
            this.lastSourceSnapshots === null && refreshAfterInitialSnapshot;
          const sourceChanged =
            ambiguousInitialChange || changedRoots.length > 0;
          this.lastSourceSnapshots = sourceSnapshots;
          refreshAfterInitialSnapshot = false;
          if (ambiguousInitialChange) this.scheduleSourceChange(null);
          else {
            for (const sourceRoot of changedRoots) {
              this.scheduleSourceChange(sourceRoot);
            }
          }

          if (inventorySnapshot !== this.lastInventorySnapshot) {
            this.dispatchInventoryChange(inventorySnapshot);
          } else if (
            sourceChanged &&
            inventorySnapshot === this.failedInventorySnapshot
          ) {
            // Polling has no raw filesystem event. A source-fingerprint change
            // is its proof that a real edit occurred after bounded give-up.
            this.dispatchInventoryChange(inventorySnapshot);
          }
        })
        .catch(() => {
          // The next poll retries an unreadable workspace.
        })
        .finally(() => {
          this.pollInFlight = false;
        });
    };
    poll();
    this.pollTimer = setInterval(
      poll,
      this.options.pollIntervalMs ?? POLL_INTERVAL_MS,
    );
  }

  close(): void {
    this.closed = true;
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer);
    if (this.inventoryRetryTimer) clearTimeout(this.inventoryRetryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    this.watcher = null;
  }
}

/** One watcher per requested workspace, independent of harness sessions. */
export class SystemGraphWatcherManager {
  private readonly watchers = new Map<
    WorkspaceKey,
    WorkspaceSystemGraphWatcher
  >();
  private readonly pendingStarts = new Map<
    WorkspaceKey,
    { root: string; token: object; promise: Promise<void> }
  >();

  constructor(
    private readonly callbacks: SystemGraphWatcherCallbacks,
    private readonly options: SystemGraphWatcherOptions = {},
  ) {}

  start(scope: WorkspaceScope): Promise<void> {
    const existing = this.watchers.get(scope.workspaceKey);
    if (existing?.scope.root === scope.root) return Promise.resolve();
    const pending = this.pendingStarts.get(scope.workspaceKey);
    if (pending?.root === scope.root) return pending.promise;
    this.stop(scope.workspaceKey);
    const token = {};
    const promise = WorkspaceSystemGraphWatcher.create(
      scope,
      this.callbacks,
      this.options,
    )
      .then((watcher) => {
        const current = this.pendingStarts.get(scope.workspaceKey);
        if (current?.token !== token) {
          watcher.close();
          return;
        }
        this.watchers.set(scope.workspaceKey, watcher);
      })
      .finally(() => {
        if (this.pendingStarts.get(scope.workspaceKey)?.token === token) {
          this.pendingStarts.delete(scope.workspaceKey);
        }
      });
    this.pendingStarts.set(scope.workspaceKey, {
      root: scope.root,
      token,
      promise,
    });
    return promise;
  }

  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    const tracked = new Set([
      ...this.watchers.keys(),
      ...this.pendingStarts.keys(),
    ]);
    for (const workspaceKey of tracked) {
      if (!workspaceKeys.has(workspaceKey)) this.stop(workspaceKey);
    }
  }

  stop(workspaceKey: WorkspaceKey): void {
    this.pendingStarts.delete(workspaceKey);
    this.watchers.get(workspaceKey)?.close();
    this.watchers.delete(workspaceKey);
  }

  stopAll(): void {
    const tracked = new Set([
      ...this.watchers.keys(),
      ...this.pendingStarts.keys(),
    ]);
    for (const workspaceKey of tracked) {
      this.stop(workspaceKey);
    }
  }

  get size(): number {
    return this.watchers.size;
  }
}
