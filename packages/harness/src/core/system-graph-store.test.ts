import { describe, expect, it, vi } from "vitest";

import type {
  SystemGraph,
  SystemGraphSnapshot,
} from "../shared/system-graph.js";
import type {
  SystemGraphBuildResult,
  SystemGraphBuilder,
  WorkspaceScope,
} from "./system-graph.js";
import { SystemGraphStore } from "./system-graph-store.js";

const scope: WorkspaceScope = {
  workspaceKey: "workspace-one",
  root: "/private/one",
};

function graphFor(label: string): SystemGraph {
  return {
    kind: "system",
    scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
    nodes: [{ id: `agent:${label}`, agentKey: label, label }],
    edges: [],
    warnings: [],
  };
}

function buildResult(label: string, cacheable = true): SystemGraphBuildResult {
  return {
    cacheable,
    graph: graphFor(label),
    navigation: [{ agentKey: label, workflowPath: `/private/${label}` }],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SystemGraphStore", () => {
  it("coalesces cold reads and retains an unchanged ready snapshot", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const builder: SystemGraphBuilder = {
      build: vi.fn(() => pending.promise),
    };
    const store = new SystemGraphStore(builder);

    const first = store.get(scope);
    expect(store.get(scope)).toBe(first);
    pending.resolve(buildResult("first"));

    const ready = await first;
    expect(ready).toMatchObject({ state: "ready", graph: graphFor("first") });
    expect(store.peekNavigation(scope.workspaceKey)).toEqual({
      workspaceKey: scope.workspaceKey,
      revision: ready.revision,
      targets: [{ agentKey: "first", workflowPath: "/private/first" }],
    });
    await expect(store.get(scope)).resolves.toBe(ready);
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it("keeps the last-good graph visible while a refresh runs", async () => {
    const refresh = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("first"))
      .mockReturnValueOnce(refresh.promise);
    const changes: SystemGraphSnapshot[] = [];
    const store = new SystemGraphStore(
      { build },
      { onChange: (snapshot) => changes.push(snapshot) },
    );
    await store.get(scope);

    const stale = store.requestRefresh(scope);
    expect(stale).toMatchObject({ state: "stale", graph: graphFor("first") });
    await expect(store.get(scope)).resolves.toBe(stale);
    expect(store.peekNavigation(scope.workspaceKey)).toMatchObject({
      revision: stale.revision,
      targets: [{ agentKey: "first", workflowPath: "/private/first" }],
    });

    refresh.resolve(buildResult("second"));
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "ready",
        graph: graphFor("second"),
      });
    });
    expect(changes.map((change) => change.state)).toContain("stale");
  });

  it("does not let a builder mutate last-good navigation after commit", async () => {
    const refresh = deferred<SystemGraphBuildResult>();
    const navigation = [{ agentKey: "first", workflowPath: "/private/first" }];
    const build = vi
      .fn()
      .mockResolvedValueOnce({
        cacheable: true,
        graph: graphFor("first"),
        navigation,
      })
      .mockReturnValueOnce(refresh.promise);
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    navigation[0]!.workflowPath = "/private/mutated";
    store.requestRefresh(scope);

    expect(store.peekNavigation(scope.workspaceKey)?.targets).toEqual([
      { agentKey: "first", workflowPath: "/private/first" },
    ]);
  });

  it("discards an older refresh and commits the newest edit", async () => {
    const oldRefresh = deferred<SystemGraphBuildResult>();
    const newestRefresh = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockReturnValueOnce(newestRefresh.promise);
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    store.requestRefresh(scope);
    store.requestRefresh(scope);
    oldRefresh.resolve(buildResult("obsolete"));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(3));
    expect(store.peek(scope.workspaceKey)?.graph).toEqual(graphFor("initial"));

    newestRefresh.resolve(buildResult("newest"));
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "ready",
        graph: graphFor("newest"),
      });
    });
  });

  it("preserves last-good data after a hard refresh failure", async () => {
    const failed = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce(buildResult("recovered"));
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    const refreshing = store.requestRefresh(scope);
    failed.reject(new Error("scan failed"));

    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "stale",
        graph: graphFor("initial"),
      });
      expect(store.peek(scope.workspaceKey)!.revision).toBeGreaterThan(
        refreshing.revision,
      );
    });
    expect(store.peekNavigation(scope.workspaceKey)).toMatchObject({
      revision: store.peek(scope.workspaceKey)?.revision,
      targets: [{ agentKey: "initial", workflowPath: "/private/initial" }],
    });

    await store.get(scope);
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "ready",
        graph: graphFor("recovered"),
      });
    });
  });

  it("publishes the current partial graph instead of retaining failed edges", async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockResolvedValueOnce(buildResult("partial", false));
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    store.requestRefresh(scope);

    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)).toMatchObject({
        state: "degraded",
        graph: graphFor("partial"),
      });
    });
  });

  it("keeps last-good data stale after a failed inventory refresh", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockReturnValueOnce(pending.promise);
    const store = new SystemGraphStore({ build });
    await store.get(scope);

    store.requestRefresh(scope);
    const stale = store.reportRefreshFailure(scope);
    expect(stale).toMatchObject({
      state: "stale",
      graph: graphFor("initial"),
    });
    expect(store.peekNavigation(scope.workspaceKey)).toMatchObject({
      revision: stale.revision,
      targets: [{ agentKey: "initial", workflowPath: "/private/initial" }],
    });

    pending.resolve(buildResult("obsolete"));
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(store.peek(scope.workspaceKey)).toBe(stale);
  });

  it("does not publish a new revision for repeated inventory failures", async () => {
    const onChange = vi.fn();
    const store = new SystemGraphStore(
      { build: vi.fn().mockResolvedValue(buildResult("initial")) },
      { onChange },
    );
    await store.get(scope);
    onChange.mockClear();

    const firstFailure = store.reportRefreshFailure(scope);
    const repeatedFailure = store.reportRefreshFailure(scope);

    expect(repeatedFailure).toBe(firstFailure);
    expect(firstFailure.state).toBe("stale");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("arms background enrichment even when its build is superseded", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const startEnrichment = vi.fn();
    const store = new SystemGraphStore({ build: vi.fn(() => pending.promise) });

    const cold = store.get(scope);
    store.reportRefreshFailure(scope);
    pending.resolve({
      ...buildResult("initial", false),
      afterCommit: startEnrichment,
    });
    await cold;

    expect(startEnrichment).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit refresh after automatic recovery was exhausted", async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("initial"))
      .mockResolvedValueOnce(buildResult("recovered"));
    const store = new SystemGraphStore({ build });
    await store.get(scope);
    store.reportRefreshFailure(scope);

    await expect(store.refresh(scope)).resolves.toMatchObject({
      state: "ready",
      graph: graphFor("recovered"),
    });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("returns an honest cold degraded snapshot when no graph can be built", async () => {
    const store = new SystemGraphStore({
      build: vi.fn().mockRejectedValue(new Error("unavailable")),
    });

    await expect(store.get(scope)).resolves.toMatchObject({
      state: "degraded",
      graph: null,
    });
  });

  it("starts enrichment only after its provisional graph and resolver commit", async () => {
    const afterCommit = vi.fn(() => {
      const snapshot = store.peek(scope.workspaceKey);
      const navigation = store.peekNavigation(scope.workspaceKey);
      expect(snapshot).toMatchObject({ state: "degraded" });
      expect(navigation?.revision).toBe(snapshot?.revision);
      expect(navigation?.targets).toEqual([
        { agentKey: "pending", workflowPath: "/private/pending" },
      ]);
    });
    const store = new SystemGraphStore({
      build: vi.fn(async () => ({
        ...buildResult("pending", false),
        afterCommit,
      })),
    });

    const snapshot = await store.get(scope);

    expect(snapshot.state).toBe("degraded");
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it("allows one later-open retry for a partial projection", async () => {
    const retry = deferred<SystemGraphBuildResult>();
    const build = vi
      .fn()
      .mockResolvedValueOnce(buildResult("partial", false))
      .mockReturnValueOnce(retry.promise);
    const store = new SystemGraphStore({ build });

    const degraded = await store.get(scope);
    expect(degraded.state).toBe("degraded");
    const retrying = store.get(scope);
    expect(store.peek(scope.workspaceKey)).toMatchObject({
      state: "degraded",
      graph: graphFor("partial"),
    });
    await store.get(scope);
    expect(build).toHaveBeenCalledTimes(2);

    retry.resolve(buildResult("recovered"));
    await expect(retrying).resolves.toMatchObject({
      state: "degraded",
      graph: graphFor("partial"),
    });
    await vi.waitFor(() => {
      expect(store.peek(scope.workspaceKey)?.state).toBe("ready");
    });
  });

  it("atomically publishes changed navigation from a same-graph degraded recovery", async () => {
    const graph = graphFor("partial");
    const build = vi
      .fn()
      .mockResolvedValueOnce({
        cacheable: false,
        graph,
        navigation: [{ agentKey: "partial", workflowPath: "/private/before" }],
      })
      .mockResolvedValueOnce({
        cacheable: false,
        graph,
        navigation: [{ agentKey: "partial", workflowPath: "/private/after" }],
      });
    const onChange = vi.fn();
    const store = new SystemGraphStore({ build }, { onChange });
    const initial = await store.get(scope);
    onChange.mockClear();

    await store.get(scope);
    await vi.waitFor(() =>
      expect(store.peekNavigation(scope.workspaceKey)?.targets).toEqual([
        { agentKey: "partial", workflowPath: "/private/after" },
      ]),
    );

    expect(store.peek(scope.workspaceKey)?.revision).toBeGreaterThan(
      initial.revision,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not publish or retain an in-flight build after scope retirement", async () => {
    const pending = deferred<SystemGraphBuildResult>();
    const onChange = vi.fn();
    const store = new SystemGraphStore(
      { build: vi.fn(() => pending.promise) },
      { onChange },
    );
    const initial = store.get(scope);
    store.retire(scope.workspaceKey);
    pending.resolve(buildResult("retired"));
    await initial;

    expect(store.peek(scope.workspaceKey)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("retires only projections outside the retained workspace set", async () => {
    const secondScope = {
      workspaceKey: "workspace-two",
      root: "/private/two",
    };
    const store = new SystemGraphStore({
      build: vi.fn().mockResolvedValue(buildResult("ready")),
    });
    await Promise.all([store.get(scope), store.get(secondScope)]);

    store.retain(new Set([scope.workspaceKey]));

    expect(store.peek(scope.workspaceKey)).not.toBeNull();
    expect(store.peek(secondScope.workspaceKey)).toBeNull();
  });

  it("keeps revisions monotonic when a retired workspace returns", async () => {
    const store = new SystemGraphStore({
      build: vi.fn().mockResolvedValue(buildResult("ready")),
    });
    const first = await store.get(scope);
    store.retire(scope.workspaceKey);

    const returned = await store.get(scope);

    expect(returned.revision).toBeGreaterThan(first.revision);
  });
});
