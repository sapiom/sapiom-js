import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SharedWorkspaceWatchBroker,
  type SharedWorkspaceWatchSubscriber,
  type WorkspaceWatchFactory,
  type WorkspaceWatchHandle,
} from "./workspace-watch-broker.js";

let root: string;
let listener: Parameters<WorkspaceWatchFactory>[1];
let close: ReturnType<typeof vi.fn>;
let watchFactory: ReturnType<typeof vi.fn<WorkspaceWatchFactory>>;
let aliasPath: string | null;

function subscriber(
  overrides: Partial<SharedWorkspaceWatchSubscriber> = {},
): SharedWorkspaceWatchSubscriber {
  return {
    root,
    listSourceRoots: () => [],
    listSourceObservations: () => [],
    onSourceChange: vi.fn(),
    onInventoryChange: vi.fn(),
    ...overrides,
  };
}

describe("SharedWorkspaceWatchBroker", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-watch-broker-"));
    aliasPath = null;
    close = vi.fn();
    watchFactory = vi.fn<WorkspaceWatchFactory>((_root, nextListener) => {
      listener = nextListener;
      const handle: WorkspaceWatchHandle = {
        close,
        on: () => handle,
      };
      return handle;
    });
  });

  afterEach(async () => {
    if (aliasPath) await fs.rm(aliasPath, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ignores only the configured metadata subtree before invalidating discovery", async () => {
    aliasPath = `${root}-alias`;
    await fs.symlink(root, aliasPath, "dir");
    const callbacks = subscriber({ onPotentialChange: vi.fn() });
    const snapshotWorkspace = vi.fn(async () => "inventory");
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      ignoredEventRoots: [path.join(aliasPath, "agent-map")],
      sourceDebounceMs: 5,
      inventoryDebounceMs: 5,
      snapshotWorkspace,
      snapshotSources: async () => new Map(),
    });
    const key = {};
    try {
      await broker.subscribe(key, callbacks);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        listener("rename", "agent-map/projects/project-1/workspace.json.lock");
        listener("rename", "agent-map/projects/project-1/initialization.json");
        listener("change", "agent-map/internal/index.ts");
      }
      expect(callbacks.onPotentialChange).not.toHaveBeenCalled();
      expect(snapshotWorkspace).toHaveBeenCalledOnce();

      listener("change", "projects/agent-map/index.ts");
      await vi.waitFor(() =>
        expect(callbacks.onSourceChange).toHaveBeenCalledWith([
          path.join(root, "projects/agent-map/index.ts"),
        ]),
      );
      listener("rename", "agent-map-user-project");
      await vi.waitFor(() =>
        expect(callbacks.onInventoryChange).toHaveBeenCalledOnce(),
      );
      expect(callbacks.onPotentialChange).toHaveBeenCalledTimes(2);
    } finally {
      broker.unsubscribe(key);
    }
  });

  it("keeps polling quiet for map metadata churn while discovering real projects", async () => {
    const metadata = path.join(root, "agent-map/projects/project-1");
    await fs.mkdir(metadata, { recursive: true });
    const callbacks = subscriber({ onPotentialChange: vi.fn() });
    const { snapshotWorkspaceWorkflowsAsync } =
      await import("./workspace-watcher.js");
    const snapshotWorkspace = vi.fn(snapshotWorkspaceWorkflowsAsync);
    const broker = new SharedWorkspaceWatchBroker({
      forcePolling: true,
      ignoredEventRoots: [path.join(root, "agent-map")],
      pollIntervalMs: 5,
      snapshotWorkspace,
    });
    const key = {};
    try {
      await broker.subscribe(key, callbacks);
      await vi.waitFor(() =>
        expect(callbacks.onSourceChange).toHaveBeenCalledOnce(),
      );
      vi.mocked(callbacks.onPotentialChange!).mockClear();
      const polls = snapshotWorkspace.mock.calls.length;
      await fs.writeFile(path.join(metadata, "workspace.json.lock"), "lock");
      await fs.writeFile(path.join(metadata, "initialization.json"), "{}");
      await vi.waitFor(() =>
        expect(snapshotWorkspace.mock.calls.length).toBeGreaterThan(polls + 1),
      );
      await fs.unlink(path.join(metadata, "workspace.json.lock"));
      const afterWrite = snapshotWorkspace.mock.calls.length;
      await vi.waitFor(() =>
        expect(snapshotWorkspace.mock.calls.length).toBeGreaterThan(
          afterWrite + 1,
        ),
      );
      expect(callbacks.onPotentialChange).not.toHaveBeenCalled();
      expect(callbacks.onInventoryChange).not.toHaveBeenCalled();

      const agent = path.join(root, "projects/agent-map");
      await fs.mkdir(agent, { recursive: true });
      await fs.writeFile(
        path.join(agent, "sapiom.json"),
        JSON.stringify({ definitionId: null }),
      );
      await fs.writeFile(
        path.join(agent, "package.json"),
        '{"name":"agent-map"}',
      );
      await vi.waitFor(() =>
        expect(callbacks.onInventoryChange).toHaveBeenCalled(),
      );
    } finally {
      broker.unsubscribe(key);
    }
  });

  it("falls back to fingerprints for unnamed events when watching host metadata", async () => {
    const metadata = path.join(root, "agent-map/projects/project-1");
    const agent = path.join(root, "projects/research");
    await fs.mkdir(metadata, { recursive: true });
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(
      path.join(agent, "sapiom.json"),
      '{"definitionId":null}',
    );
    await fs.writeFile(path.join(agent, "package.json"), '{"name":"research"}');
    await fs.writeFile(
      path.join(agent, "index.ts"),
      "export const before = 1;",
    );
    const callbacks = subscriber({
      listSourceRoots: () => [agent],
      onPotentialChange: vi.fn(),
    });
    const { snapshotWorkspaceWorkflowsAsync } =
      await import("./workspace-watcher.js");
    const snapshotWorkspace = vi.fn(snapshotWorkspaceWorkflowsAsync);
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      ignoredEventRoots: [path.join(root, "agent-map")],
      pollIntervalMs: 5,
      sourceDebounceMs: 5,
      snapshotWorkspace,
    });
    const key = {};
    try {
      await broker.subscribe(key, callbacks);
      await fs.writeFile(path.join(metadata, "workspace.json.lock"), "lock");
      listener("rename", null);
      expect(close).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(snapshotWorkspace.mock.calls.length).toBeGreaterThan(2),
      );
      expect(callbacks.onPotentialChange).not.toHaveBeenCalled();
      expect(callbacks.onSourceChange).not.toHaveBeenCalled();
      expect(callbacks.onInventoryChange).not.toHaveBeenCalled();

      await fs.writeFile(
        path.join(agent, "index.ts"),
        "export const after = 22;",
      );
      await vi.waitFor(() =>
        expect(callbacks.onSourceChange).toHaveBeenCalledWith([agent]),
      );
      expect(callbacks.onPotentialChange).toHaveBeenCalledWith([agent]);
    } finally {
      broker.unsubscribe(key);
    }
  });

  it("isolates potential and source callback failures between subscribers", async () => {
    const failingPotential = vi.fn(() => {
      throw new Error("potential failed");
    });
    const failingSource = vi.fn(async () => {
      throw new Error("source failed");
    });
    const healthyPotential = vi.fn();
    const healthySource = vi.fn();
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      sourceDebounceMs: 5,
      maxSourceRetries: 0,
      snapshotWorkspace: async () => "inventory",
      snapshotSources: async () => new Map(),
    });
    const failingKey = {};
    const healthyKey = {};

    await broker.subscribe(
      failingKey,
      subscriber({
        onPotentialChange: failingPotential,
        onSourceChange: failingSource,
      }),
    );
    await broker.subscribe(
      healthyKey,
      subscriber({
        onPotentialChange: healthyPotential,
        onSourceChange: healthySource,
      }),
    );

    listener("change", "agent/index.ts");
    expect(failingPotential).toHaveBeenCalledOnce();
    expect(healthyPotential).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(healthySource).toHaveBeenCalledOnce(), {
      timeout: 1_000,
      interval: 10,
    });
    expect(failingSource).toHaveBeenCalledOnce();

    broker.unsubscribe(failingKey);
    broker.unsubscribe(healthyKey);
  });

  it("isolates inventory callback failures between subscribers", async () => {
    let inventory = "before";
    const failingInventory = vi.fn(async () => {
      throw new Error("inventory failed");
    });
    const healthyInventory = vi.fn();
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      inventoryDebounceMs: 5,
      maxInventoryRetries: 0,
      snapshotWorkspace: async () => inventory,
      snapshotSources: async () => new Map(),
    });
    const failingKey = {};
    const healthyKey = {};

    await broker.subscribe(
      failingKey,
      subscriber({ onInventoryChange: failingInventory }),
    );
    await broker.subscribe(
      healthyKey,
      subscriber({ onInventoryChange: healthyInventory }),
    );

    inventory = "after";
    listener("rename", "new-agent");
    await vi.waitFor(() => expect(healthyInventory).toHaveBeenCalledOnce(), {
      timeout: 1_000,
      interval: 10,
    });
    expect(failingInventory).toHaveBeenCalledOnce();

    broker.unsubscribe(failingKey);
    broker.unsubscribe(healthyKey);
  });

  it("shares one canonical lease and releases it exactly once after the final subscriber", async () => {
    aliasPath = `${root}-alias`;
    await fs.symlink(root, aliasPath, "dir");
    const snapshotWorkspace = vi.fn(async () => "inventory");
    const snapshotSources = vi.fn(async () => new Map());
    const releaseOrder: string[] = [];
    close.mockImplementation(() => releaseOrder.push("close"));
    const onLastLeaseReleased = vi.fn(() => {
      releaseOrder.push("invalidate");
      throw new Error("invalidation failure is contained");
    });
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      snapshotWorkspace,
      snapshotSources,
      onLastLeaseReleased,
    });
    const firstKey = {};
    const secondKey = {};

    await broker.subscribe(firstKey, subscriber());
    await broker.subscribe(secondKey, subscriber({ root: aliasPath }));

    expect(watchFactory).toHaveBeenCalledTimes(1);
    expect(snapshotWorkspace).toHaveBeenCalledTimes(1);
    expect(snapshotSources).toHaveBeenCalledTimes(1);
    expect(broker.size).toBe(1);

    broker.unsubscribe(firstKey);
    expect(close).not.toHaveBeenCalled();
    expect(onLastLeaseReleased).not.toHaveBeenCalled();

    expect(() => broker.unsubscribe(secondKey)).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
    expect(onLastLeaseReleased).toHaveBeenCalledOnce();
    expect(releaseOrder).toEqual(["close", "invalidate"]);
    expect(broker.size).toBe(0);

    broker.unsubscribe(secondKey);
    expect(close).toHaveBeenCalledOnce();
    expect(onLastLeaseReleased).toHaveBeenCalledOnce();
  });

  it("includes a subscriber that joins while the shared baseline is pending", async () => {
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const snapshotWorkspace = vi.fn(async () => "inventory");
    const snapshotSources = vi.fn(
      async (roots: readonly string[]) =>
        new Map(roots.map((sourceRoot) => [sourceRoot, sourceRoot])),
    );
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      beforeInitialSnapshot: () => baselineGate,
      snapshotWorkspace,
      snapshotSources,
    });
    const firstKey = {};
    const secondKey = {};
    const firstStart = broker.subscribe(
      firstKey,
      subscriber({ listSourceRoots: () => [path.join(root, "first")] }),
    );
    const secondStart = broker.subscribe(
      secondKey,
      subscriber({ listSourceRoots: () => [path.join(root, "second")] }),
    );

    releaseBaseline();
    await Promise.all([firstStart, secondStart]);

    expect(snapshotWorkspace).toHaveBeenCalledOnce();
    expect(snapshotSources).toHaveBeenCalledOnce();
    expect(snapshotSources.mock.calls[0]?.[0]).toEqual([
      path.join(root, "first"),
      path.join(root, "second"),
    ]);

    broker.unsubscribe(firstKey);
    broker.unsubscribe(secondKey);
  });

  it("rebases graph-only observation coverage without manufacturing a discovery edit", async () => {
    const agentRoot = path.join(root, "agent");
    const discoveryPath = path.join(agentRoot, "discovery.ts");
    const invocationPath = path.join(agentRoot, "invocation.ts");
    const discoveryObservation = {
      workspaceRoot: root,
      candidateRoot: agentRoot,
      paths: [discoveryPath],
    };
    const invocationObservation = {
      workspaceRoot: agentRoot,
      candidateRoot: agentRoot,
      paths: [invocationPath],
    };
    let discoveryVersion = "discovery-v1";
    let invocationVersion = "invocation-v1";
    let includeInvocation = true;
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const snapshotSources = vi.fn(
      async (
        roots: readonly string[],
        observations: readonly {
          candidateRoot: string;
          paths: readonly string[];
        }[],
      ) => {
        const retainedRoots = new Set([
          ...roots,
          ...observations.map((observation) => observation.candidateRoot),
        ]);
        const observedPaths = new Set(
          observations.flatMap((observation) => observation.paths),
        );
        const fingerprint = JSON.stringify(
          [...observedPaths]
            .sort()
            .map((observedPath) => [
              observedPath,
              observedPath === discoveryPath
                ? discoveryVersion
                : invocationVersion,
            ]),
        );
        return new Map(
          [...retainedRoots]
            .sort()
            .map((sourceRoot) => [sourceRoot, fingerprint]),
        );
      },
    );
    const discoveryPotential = vi.fn();
    const discoveryChange = vi.fn();
    const graphPotential = vi.fn();
    const graphChange = vi.fn();
    const onLastLeaseReleased = vi.fn();
    const broker = new SharedWorkspaceWatchBroker({
      forcePolling: true,
      beforeInitialSnapshot: () => baselineGate,
      pollIntervalMs: 5,
      sourceDebounceMs: 1,
      snapshotWorkspace: async () => "inventory",
      snapshotSources,
      onLastLeaseReleased,
    });
    const discoveryKey = {};
    const graphKey = {};

    const discoveryStart = broker.subscribe(
      discoveryKey,
      subscriber({
        listSourceRoots: () => [agentRoot],
        listSourceObservations: () => [discoveryObservation],
        onPotentialChange: discoveryPotential,
        onSourceChange: discoveryChange,
      }),
    );
    const graphStart = broker.subscribe(
      graphKey,
      subscriber({
        listSourceRoots: () => [agentRoot],
        listSourceObservations: () => [
          discoveryObservation,
          ...(includeInvocation ? [invocationObservation] : []),
        ],
        onPotentialChange: graphPotential,
        onSourceChange: graphChange,
      }),
    );
    releaseBaseline();
    await Promise.all([discoveryStart, graphStart]);
    await vi.waitFor(() => {
      expect(discoveryChange).toHaveBeenCalledOnce();
      expect(graphChange).toHaveBeenCalledOnce();
    });
    discoveryPotential.mockClear();
    discoveryChange.mockClear();
    graphPotential.mockClear();
    graphChange.mockClear();

    const waitForPollAfter = async (callCount: number): Promise<void> => {
      await vi.waitFor(() => {
        expect(snapshotSources.mock.calls.length).toBeGreaterThan(callCount);
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    };

    let callsBeforeCoverageChange = snapshotSources.mock.calls.length;
    includeInvocation = false;
    await waitForPollAfter(callsBeforeCoverageChange);
    expect(discoveryPotential).not.toHaveBeenCalled();
    expect(discoveryChange).not.toHaveBeenCalled();

    callsBeforeCoverageChange = snapshotSources.mock.calls.length;
    includeInvocation = true;
    await waitForPollAfter(callsBeforeCoverageChange);
    expect(discoveryPotential).not.toHaveBeenCalled();
    expect(discoveryChange).not.toHaveBeenCalled();

    invocationVersion = "invocation-v2";
    await vi.waitFor(() => {
      expect(graphPotential).toHaveBeenCalledWith([agentRoot]);
      expect(graphChange).toHaveBeenCalledWith([agentRoot]);
    });
    discoveryPotential.mockClear();
    discoveryChange.mockClear();
    graphPotential.mockClear();
    graphChange.mockClear();

    callsBeforeCoverageChange = snapshotSources.mock.calls.length;
    broker.unsubscribe(graphKey);
    expect(broker.size).toBe(1);
    expect(onLastLeaseReleased).not.toHaveBeenCalled();
    await waitForPollAfter(callsBeforeCoverageChange);
    expect(discoveryPotential).not.toHaveBeenCalled();
    expect(discoveryChange).not.toHaveBeenCalled();

    invocationVersion = "invocation-v3";
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(discoveryPotential).not.toHaveBeenCalled();
    expect(discoveryChange).not.toHaveBeenCalled();

    discoveryVersion = "discovery-v2";
    await vi.waitFor(() => {
      expect(discoveryPotential).toHaveBeenCalledWith([agentRoot]);
      expect(discoveryChange).toHaveBeenCalledWith([agentRoot]);
    });

    broker.unsubscribe(discoveryKey);
    expect(onLastLeaseReleased).toHaveBeenCalledOnce();
  });

  it("does not swallow a source edit between current and baseline coverage walks", async () => {
    const agentRoot = path.join(root, "agent");
    const discoveryPath = path.join(agentRoot, "discovery.ts");
    const invocationPath = path.join(agentRoot, "invocation.ts");
    const discoveryObservation = {
      workspaceRoot: root,
      candidateRoot: agentRoot,
      paths: [discoveryPath],
    };
    const invocationObservation = {
      workspaceRoot: agentRoot,
      candidateRoot: agentRoot,
      paths: [invocationPath],
    };
    let includeInvocation = false;
    let discoveryVersion = "discovery-v1";
    let mutateAfterCurrentSample = false;
    let coverageRebaseActive = false;
    const coverageWalks: string[] = [];
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const snapshotSources = vi.fn(
      async (
        roots: readonly string[],
        observations: readonly { paths: readonly string[] }[],
      ) => {
        const paths = observations
          .flatMap((observation) => observation.paths)
          .sort();
        if (coverageRebaseActive) {
          coverageWalks.push(
            paths.includes(invocationPath) ? "current" : "baseline",
          );
        }
        const snapshot = new Map([
          [
            agentRoot,
            JSON.stringify(
              paths.map((observedPath) => [
                observedPath,
                observedPath === discoveryPath
                  ? discoveryVersion
                  : "invocation-v1",
              ]),
            ),
          ],
        ]);
        if (mutateAfterCurrentSample && paths.includes(invocationPath)) {
          mutateAfterCurrentSample = false;
          discoveryVersion = "discovery-v2";
        }
        expect(roots).toContain(agentRoot);
        return snapshot;
      },
    );
    const discoveryPotential = vi.fn();
    const discoveryChange = vi.fn();
    const graphChange = vi.fn();
    const broker = new SharedWorkspaceWatchBroker({
      forcePolling: true,
      beforeInitialSnapshot: () => baselineGate,
      pollIntervalMs: 5,
      sourceDebounceMs: 1,
      snapshotWorkspace: async () => "inventory",
      snapshotSources,
    });
    const discoveryKey = {};
    const graphKey = {};
    const discoveryStart = broker.subscribe(
      discoveryKey,
      subscriber({
        listSourceRoots: () => [agentRoot],
        listSourceObservations: () => [discoveryObservation],
        onPotentialChange: discoveryPotential,
        onSourceChange: discoveryChange,
      }),
    );
    const graphStart = broker.subscribe(
      graphKey,
      subscriber({
        listSourceRoots: () => [agentRoot],
        listSourceObservations: () => [
          discoveryObservation,
          ...(includeInvocation ? [invocationObservation] : []),
        ],
        onSourceChange: graphChange,
      }),
    );
    releaseBaseline();
    await Promise.all([discoveryStart, graphStart]);
    await vi.waitFor(() => {
      expect(discoveryChange).toHaveBeenCalledOnce();
      expect(graphChange).toHaveBeenCalledOnce();
    });
    discoveryPotential.mockClear();
    discoveryChange.mockClear();
    graphChange.mockClear();

    let resolvePotential!: () => void;
    const potentialObserved = new Promise<void>((resolve) => {
      resolvePotential = resolve;
    });
    discoveryPotential.mockImplementation(resolvePotential);
    const callsBeforeRebase = snapshotSources.mock.calls.length;
    coverageRebaseActive = true;
    mutateAfterCurrentSample = true;
    includeInvocation = true;

    await potentialObserved;
    expect(snapshotSources.mock.calls.length - callsBeforeRebase).toBe(2);
    expect(coverageWalks).toEqual(["current", "baseline"]);
    await vi.waitFor(() => {
      expect(discoveryPotential).toHaveBeenCalledWith([agentRoot]);
      expect(discoveryChange).toHaveBeenCalledWith([agentRoot]);
      expect(graphChange).toHaveBeenCalledWith([agentRoot]);
    });

    broker.unsubscribe(graphKey);
    broker.unsubscribe(discoveryKey);
  });

  it("retires the final lease during an in-flight coverage rebase", async () => {
    const agentRoot = path.join(root, "agent");
    const discoveryPath = path.join(agentRoot, "discovery.ts");
    const invocationPath = path.join(agentRoot, "invocation.ts");
    let includeInvocation = false;
    let holdExpandedSample = false;
    let expandedSampleStarted!: () => void;
    const expandedSample = new Promise<void>((resolve) => {
      expandedSampleStarted = resolve;
    });
    let releaseExpandedSample!: () => void;
    const expandedSampleGate = new Promise<void>((resolve) => {
      releaseExpandedSample = resolve;
    });
    const snapshotSources = vi.fn(
      async (
        _roots: readonly string[],
        observations: readonly { paths: readonly string[] }[],
      ) => {
        const observedPaths = observations
          .flatMap((observation) => observation.paths)
          .sort();
        if (holdExpandedSample && observedPaths.includes(invocationPath)) {
          holdExpandedSample = false;
          expandedSampleStarted();
          await expandedSampleGate;
        }
        return new Map([[agentRoot, JSON.stringify(observedPaths)]]);
      },
    );
    const onPotentialChange = vi.fn();
    const onSourceChange = vi.fn();
    const onLastLeaseReleased = vi.fn();
    const broker = new SharedWorkspaceWatchBroker({
      forcePolling: true,
      pollIntervalMs: 5,
      sourceDebounceMs: 1,
      snapshotWorkspace: async () => "inventory",
      snapshotSources,
      onLastLeaseReleased,
    });
    const key = {};

    await broker.subscribe(
      key,
      subscriber({
        listSourceRoots: () => [agentRoot],
        listSourceObservations: () => [
          {
            workspaceRoot: root,
            candidateRoot: agentRoot,
            paths: [discoveryPath],
          },
          ...(includeInvocation
            ? [
                {
                  workspaceRoot: agentRoot,
                  candidateRoot: agentRoot,
                  paths: [invocationPath],
                },
              ]
            : []),
        ],
        onPotentialChange,
        onSourceChange,
      }),
    );
    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalledOnce());
    onPotentialChange.mockClear();
    onSourceChange.mockClear();

    holdExpandedSample = true;
    includeInvocation = true;
    await expandedSample;

    broker.unsubscribe(key);
    expect(broker.size).toBe(0);
    expect(onLastLeaseReleased).toHaveBeenCalledOnce();
    releaseExpandedSample();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onPotentialChange).not.toHaveBeenCalled();
    expect(onSourceChange).not.toHaveBeenCalled();
    expect(onLastLeaseReleased).toHaveBeenCalledOnce();
  });

  it("cleans a failed lease so a later subscription can retry", async () => {
    let attempts = 0;
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    watchFactory.mockImplementation((_watchRoot, nextListener) => {
      listener = nextListener;
      const closeAttempt = vi.fn();
      closes.push(closeAttempt);
      const handle: WorkspaceWatchHandle = {
        close: closeAttempt,
        on: () => handle,
      };
      return handle;
    });
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      beforeInitialSnapshot: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first baseline failed");
      },
      snapshotWorkspace: async () => "inventory",
      snapshotSources: async () => new Map(),
    });

    await expect(broker.subscribe({}, subscriber())).rejects.toThrow(
      "first baseline failed",
    );
    expect(broker.size).toBe(0);
    expect(closes[0]).toHaveBeenCalledOnce();

    const retryKey = {};
    await broker.subscribe(retryKey, subscriber());
    expect(watchFactory).toHaveBeenCalledTimes(2);
    expect(broker.size).toBe(1);
    broker.unsubscribe(retryKey);
  });
});
