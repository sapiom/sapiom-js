import type { WorkspaceKey } from "../shared/system-graph.js";
import { canonicalGraphPath } from "./canonical-graph-path.js";
import type { WorkspaceScope } from "./system-graph.js";
import type { WorkflowSourceObservation } from "./workspace-watcher.js";
import {
  type SharedWorkspaceWatchBrokerLike,
  WorkspaceRootWatcher,
  type WorkspaceWatchOptions,
} from "./workspace-watch-broker.js";

export interface SystemGraphWatcherCallbacks {
  /** Current registry roots inside this scope; read lazily on every poll. */
  listSourceRoots: (scope: WorkspaceScope) => readonly string[];
  listSourceObservations?: (
    scope: WorkspaceScope,
  ) => readonly WorkflowSourceObservation[];
  onSourceChange: (
    scope: WorkspaceScope,
    /** Null when the platform can only report a workspace-level change. */
    sourcePaths: readonly string[] | null,
  ) => void | Promise<void>;
  onInventoryChange: (scope: WorkspaceScope) => void | Promise<void>;
  /** Synchronous raw-event fail-close hook, before debounce or async I/O. */
  onPotentialChange?: (
    scope: WorkspaceScope,
    sourcePaths: readonly string[] | null,
  ) => void;
}

export interface SystemGraphWatcherOptions extends WorkspaceWatchOptions {
  /** Optional process-wide root broker shared with session watchers. */
  sharedBroker?: SharedWorkspaceWatchBrokerLike;
}

/** One watcher per requested workspace, independent of harness sessions. */
export class SystemGraphWatcherManager {
  private readonly watchers = new Map<WorkspaceKey, WorkspaceRootWatcher>();
  private readonly pendingStarts = new Map<
    WorkspaceKey,
    {
      root: string;
      token: object;
      watcher: WorkspaceRootWatcher;
      promise: Promise<void>;
    }
  >();
  private readonly sharedSubscriptions = new Map<
    WorkspaceKey,
    { root: string; key: object }
  >();

  constructor(
    private readonly callbacks: SystemGraphWatcherCallbacks,
    private readonly options: SystemGraphWatcherOptions = {},
  ) {}

  start(scope: WorkspaceScope): Promise<void> {
    const sharedBroker = this.options.sharedBroker;
    if (sharedBroker) {
      const canonicalRoot = canonicalGraphPath(scope.root);
      const existingShared = this.sharedSubscriptions.get(scope.workspaceKey);
      if (existingShared?.root === canonicalRoot) return Promise.resolve();
      this.stop(scope.workspaceKey);
      const key = {};
      this.sharedSubscriptions.set(scope.workspaceKey, {
        root: canonicalRoot,
        key,
      });
      return sharedBroker
        .subscribe(key, {
          root: scope.root,
          listSourceRoots: () => this.callbacks.listSourceRoots(scope),
          listSourceObservations: () =>
            this.callbacks.listSourceObservations?.(scope) ?? [],
          onPotentialChange: (paths) =>
            this.callbacks.onPotentialChange?.(scope, paths),
          onSourceChange: (paths) =>
            this.callbacks.onSourceChange(scope, paths),
          onInventoryChange: () => this.callbacks.onInventoryChange(scope),
        })
        .catch((error: unknown) => {
          if (this.sharedSubscriptions.get(scope.workspaceKey)?.key === key) {
            this.sharedSubscriptions.delete(scope.workspaceKey);
          }
          throw error;
        });
    }
    const existing = this.watchers.get(scope.workspaceKey);
    if (existing?.root === scope.root) return Promise.resolve();
    const pending = this.pendingStarts.get(scope.workspaceKey);
    if (pending?.root === scope.root) return pending.promise;
    this.stop(scope.workspaceKey);
    const token = {};
    const started = WorkspaceRootWatcher.begin(
      scope.root,
      {
        listSourceRoots: () => this.callbacks.listSourceRoots(scope),
        listSourceObservations: () =>
          this.callbacks.listSourceObservations?.(scope) ?? [],
        onPotentialChange: (paths) =>
          this.callbacks.onPotentialChange?.(scope, paths),
        onSourceChange: (paths) => this.callbacks.onSourceChange(scope, paths),
        onInventoryChange: () => this.callbacks.onInventoryChange(scope),
      },
      this.options,
    );
    const promise = started.ready
      .then(
        () => {
          const current = this.pendingStarts.get(scope.workspaceKey);
          if (current?.token !== token) {
            started.watcher.close();
            return;
          }
          this.watchers.set(scope.workspaceKey, started.watcher);
        },
        (error: unknown) => {
          started.watcher.close();
          throw error;
        },
      )
      .finally(() => {
        if (this.pendingStarts.get(scope.workspaceKey)?.token === token) {
          this.pendingStarts.delete(scope.workspaceKey);
        }
      });
    this.pendingStarts.set(scope.workspaceKey, {
      root: scope.root,
      token,
      watcher: started.watcher,
      promise,
    });
    return promise;
  }

  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    const tracked = new Set([
      ...this.watchers.keys(),
      ...this.pendingStarts.keys(),
      ...this.sharedSubscriptions.keys(),
    ]);
    for (const workspaceKey of tracked) {
      if (!workspaceKeys.has(workspaceKey)) this.stop(workspaceKey);
    }
  }

  stop(workspaceKey: WorkspaceKey): void {
    const shared = this.sharedSubscriptions.get(workspaceKey);
    if (shared) this.options.sharedBroker?.unsubscribe(shared.key);
    this.sharedSubscriptions.delete(workspaceKey);
    this.pendingStarts.get(workspaceKey)?.watcher.close();
    this.pendingStarts.delete(workspaceKey);
    this.watchers.get(workspaceKey)?.close();
    this.watchers.delete(workspaceKey);
  }

  stopAll(): void {
    const tracked = new Set([
      ...this.watchers.keys(),
      ...this.pendingStarts.keys(),
      ...this.sharedSubscriptions.keys(),
    ]);
    for (const workspaceKey of tracked) this.stop(workspaceKey);
  }

  get size(): number {
    return this.watchers.size + this.sharedSubscriptions.size;
  }
}
