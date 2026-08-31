import type {
  SystemGraph,
  SystemGraphLifecycleState,
  SystemGraphNavigationResponse,
  SystemGraphNavigationTarget,
  SystemGraphSnapshot,
  WorkspaceKey,
} from "../shared/system-graph.js";
import type { SystemGraphBuilder, WorkspaceScope } from "./system-graph.js";

export interface SystemGraphStoreOptions {
  /** Called only for an accepted lifecycle transition. */
  onChange?: (snapshot: SystemGraphSnapshot) => void;
}

interface SystemGraphEntry {
  scope: WorkspaceScope;
  snapshot: SystemGraphSnapshot;
  navigation: SystemGraphNavigationResponse;
  activeBuild: Promise<SystemGraphSnapshot> | null;
  generation: number;
  refreshPending: boolean;
  automaticRetryUsed: boolean;
  retired: boolean;
}

function visibleProjection(entry: SystemGraphEntry): {
  graph: SystemGraph | null;
  navigation: readonly SystemGraphNavigationTarget[];
} {
  return {
    graph: entry.snapshot.graph,
    navigation: entry.navigation.targets,
  };
}

function sameNavigation(
  left: readonly SystemGraphNavigationTarget[],
  right: readonly SystemGraphNavigationTarget[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.agentKey === right[index]?.agentKey &&
        target.workflowPath === right[index]?.workflowPath,
    )
  );
}

/**
 * Process-lifetime, workspace-scoped projection store.
 *
 * Cold reads coalesce behind one build. Later refreshes keep the last usable
 * graph visible as stale, serialize rebuilds, and reject an older generation's
 * result when another edit arrives while it is in flight.
 */
export class SystemGraphStore {
  private readonly entries = new Map<WorkspaceKey, SystemGraphEntry>();
  private readonly revisionFloors = new Map<WorkspaceKey, number>();

  constructor(
    private readonly builder: SystemGraphBuilder,
    private readonly options: SystemGraphStoreOptions = {},
  ) {}

  get(scope: WorkspaceScope): Promise<SystemGraphSnapshot> {
    const entry = this.ensureEntry(scope);
    if (entry.activeBuild) {
      return entry.snapshot.graph === null
        ? entry.activeBuild
        : Promise.resolve(entry.snapshot);
    }
    if (entry.snapshot.state === "building" && entry.snapshot.graph === null) {
      return this.startBuild(entry);
    }

    // Non-ready projections are deliberately not healthy cache hits. One
    // later open awaits a recovery build, while a permanent failure cannot
    // charge every collapse/expand forever.
    if (
      (entry.snapshot.state === "degraded" ||
        entry.snapshot.state === "stale") &&
      !entry.automaticRetryUsed
    ) {
      entry.automaticRetryUsed = true;
      this.queueRefresh(entry, entry.snapshot.state === "degraded");
    }
    return Promise.resolve(entry.snapshot);
  }

  /**
   * Cold-initialize resolver data without treating an existing degraded/stale
   * projection as a later graph open. Navigation reads must be lifecycle
   * side-effect-free for the exact revision the browser already displays.
   */
  ensureInitialized(scope: WorkspaceScope): Promise<SystemGraphSnapshot> {
    const entry = this.entries.get(scope.workspaceKey);
    if (!entry) return this.get(scope);
    if (entry.activeBuild && entry.snapshot.graph === null) {
      return entry.activeBuild;
    }
    return Promise.resolve(entry.snapshot);
  }

  /** Marks a workspace dirty and starts (or queues) a background refresh. */
  requestRefresh(scope: WorkspaceScope): SystemGraphSnapshot {
    const entry = this.ensureEntry(scope);
    entry.automaticRetryUsed = false;
    this.queueRefresh(entry);
    return entry.snapshot;
  }

  /** Explicit user recovery: start a fresh projection and await its result. */
  refresh(scope: WorkspaceScope): Promise<SystemGraphSnapshot> {
    const entry = this.ensureEntry(scope);
    entry.automaticRetryUsed = false;
    return this.queueRefresh(entry) ?? Promise.resolve(entry.snapshot);
  }

  peek(workspaceKey: WorkspaceKey): SystemGraphSnapshot | null {
    return this.entries.get(workspaceKey)?.snapshot ?? null;
  }

  /** Resolver data stamped with the exact graph revision it accompanies. */
  peekNavigation(
    workspaceKey: WorkspaceKey,
  ): SystemGraphNavigationResponse | null {
    return this.entries.get(workspaceKey)?.navigation ?? null;
  }

  /** Records a refresh prerequisite failure while preserving visible data. */
  reportRefreshFailure(scope: WorkspaceScope): SystemGraphSnapshot {
    const entry = this.ensureEntry(scope);
    entry.generation += 1;
    entry.refreshPending = false;
    // Registry recovery must happen before projection. Do not let a later
    // graph read rebuild from the stale inventory and relabel it ready; the
    // watcher retries the failed inventory callback instead.
    entry.automaticRetryUsed = true;
    const visible = visibleProjection(entry);
    return visible.graph === null
      ? this.transition(entry, "degraded", null)
      : this.transition(
          entry,
          "stale",
          visible.graph,
          false,
          visible.navigation,
        );
  }

  /** Retires projections for workspace scopes Studio no longer exposes. */
  retain(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    for (const workspaceKey of [...this.entries.keys()]) {
      if (!workspaceKeys.has(workspaceKey)) this.retire(workspaceKey);
    }
  }

  /** Stops retaining a scope that Studio no longer exposes. */
  retire(workspaceKey: WorkspaceKey): void {
    const entry = this.entries.get(workspaceKey);
    if (!entry) return;
    entry.retired = true;
    entry.generation += 1;
    this.revisionFloors.set(workspaceKey, entry.snapshot.revision);
    this.entries.delete(workspaceKey);
    this.retainBuilderWorkspaces();
  }

  /** Backward-compatible alias for callers that explicitly drop a snapshot. */
  invalidate(workspaceKey: WorkspaceKey): void {
    this.retire(workspaceKey);
  }

  clear(): void {
    for (const workspaceKey of [...this.entries.keys()]) {
      this.retire(workspaceKey);
    }
    this.revisionFloors.clear();
  }

  private ensureEntry(scope: WorkspaceScope): SystemGraphEntry {
    const existing = this.entries.get(scope.workspaceKey);
    if (existing) {
      existing.scope = scope;
      return existing;
    }
    const entry: SystemGraphEntry = {
      scope,
      snapshot: {
        workspaceKey: scope.workspaceKey,
        revision: this.revisionFloors.get(scope.workspaceKey) ?? 0,
        state: "building",
        graph: null,
      },
      navigation: {
        workspaceKey: scope.workspaceKey,
        revision: this.revisionFloors.get(scope.workspaceKey) ?? 0,
        targets: [],
      },
      activeBuild: null,
      generation: 0,
      refreshPending: false,
      automaticRetryUsed: false,
      retired: false,
    };
    this.entries.set(scope.workspaceKey, entry);
    return entry;
  }

  private queueRefresh(
    entry: SystemGraphEntry,
    preserveLifecycle = false,
  ): Promise<SystemGraphSnapshot> | null {
    if (entry.retired) return null;
    entry.generation += 1;
    entry.refreshPending = true;
    const visible = visibleProjection(entry);
    if (!preserveLifecycle) {
      this.transition(
        entry,
        visible.graph === null ? "building" : "stale",
        visible.graph,
        false,
        visible.navigation,
      );
    }
    if (entry.activeBuild) return entry.activeBuild;
    entry.refreshPending = false;
    return this.startBuild(entry);
  }

  private startBuild(entry: SystemGraphEntry): Promise<SystemGraphSnapshot> {
    if (entry.activeBuild) return entry.activeBuild;
    const generation = entry.generation;
    entry.refreshPending = false;
    const visible = visibleProjection(entry);
    if (entry.snapshot.state !== "degraded") {
      this.transition(
        entry,
        visible.graph === null ? "building" : "stale",
        visible.graph,
        false,
        visible.navigation,
      );
    }

    let build: Promise<Awaited<ReturnType<SystemGraphBuilder["build"]>>>;
    try {
      build = Promise.resolve(this.builder.build(entry.scope));
    } catch (error) {
      build = Promise.reject(error);
    }

    const active = build.then(
      (result) => this.finishBuild(entry, generation, result),
      () => this.finishFailure(entry, generation),
    );
    entry.activeBuild = active;
    return active;
  }

  private finishBuild(
    entry: SystemGraphEntry,
    generation: number,
    result: Awaited<ReturnType<SystemGraphBuilder["build"]>>,
  ): SystemGraphSnapshot | Promise<SystemGraphSnapshot> {
    // The superseded build can carry the only callback that starts identity
    // enrichment. Arm it after the commit decision on both paths: before that
    // decision a synchronous refresh could supersede the result being
    // committed; omitting it from the losing path can leave identities pending
    // forever with no follow-up queued.
    if (!this.canCommit(entry, generation)) {
      const superseded = this.continueAfterSupersededBuild(entry);
      this.afterCommit(result.afterCommit);
      return superseded;
    }
    entry.activeBuild = null;
    const navigation = (result.navigation ?? []).map((target) => ({
      ...target,
    }));
    if (result.cacheable) {
      entry.automaticRetryUsed = false;
      const snapshot = this.transition(
        entry,
        "ready",
        result.graph,
        false,
        navigation,
      );
      this.afterCommit(result.afterCommit);
      return snapshot;
    }
    const snapshot = this.transition(
      entry,
      "degraded",
      result.graph,
      false,
      navigation,
    );
    this.afterCommit(result.afterCommit);
    return snapshot;
  }

  private finishFailure(
    entry: SystemGraphEntry,
    generation: number,
  ): SystemGraphSnapshot | Promise<SystemGraphSnapshot> {
    if (!this.canCommit(entry, generation)) {
      return this.continueAfterSupersededBuild(entry);
    }
    entry.activeBuild = null;
    const visible = visibleProjection(entry);
    return visible.graph === null
      ? this.transition(entry, "degraded", null)
      : this.transition(
          entry,
          "stale",
          visible.graph,
          true,
          visible.navigation,
        );
  }

  private canCommit(entry: SystemGraphEntry, generation: number): boolean {
    return (
      !entry.retired &&
      this.entries.get(entry.scope.workspaceKey) === entry &&
      entry.generation === generation
    );
  }

  private continueAfterSupersededBuild(
    entry: SystemGraphEntry,
  ): SystemGraphSnapshot | Promise<SystemGraphSnapshot> {
    entry.activeBuild = null;
    if (entry.retired || this.entries.get(entry.scope.workspaceKey) !== entry) {
      this.retainBuilderWorkspaces();
      return entry.snapshot;
    }
    if (entry.refreshPending) {
      entry.refreshPending = false;
      return this.startBuild(entry);
    }
    return entry.snapshot;
  }

  private retainBuilderWorkspaces(): void {
    try {
      this.builder.retainWorkspaces?.(new Set(this.entries.keys()));
    } catch {
      // Cache pruning cannot make graph reads or scope retirement fail.
    }
  }

  private transition(
    entry: SystemGraphEntry,
    state: SystemGraphLifecycleState,
    graph: SystemGraph | null,
    forceRevision = false,
    navigation: readonly SystemGraphNavigationTarget[] = graph === null
      ? []
      : entry.navigation.targets,
  ): SystemGraphSnapshot {
    if (
      !forceRevision &&
      entry.snapshot.state === state &&
      entry.snapshot.graph === graph &&
      sameNavigation(entry.navigation.targets, navigation)
    ) {
      return entry.snapshot;
    }
    entry.snapshot = {
      workspaceKey: entry.scope.workspaceKey,
      revision: entry.snapshot.revision + 1,
      state,
      graph,
    };
    entry.navigation = {
      workspaceKey: entry.scope.workspaceKey,
      revision: entry.snapshot.revision,
      targets: navigation.map((target) => ({ ...target })),
    };
    this.revisionFloors.set(entry.scope.workspaceKey, entry.snapshot.revision);
    try {
      this.options.onChange?.(entry.snapshot);
    } catch {
      // Observers (the event bus) cannot make graph refreshes fail.
    }
    return entry.snapshot;
  }

  private afterCommit(callback: (() => void) | undefined): void {
    if (!callback) return;
    try {
      callback();
    } catch {
      // Background enrichment is a refresh hint, not part of the committed read.
    }
  }
}
