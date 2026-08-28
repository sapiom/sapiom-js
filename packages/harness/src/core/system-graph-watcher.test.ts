import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceScope } from "./system-graph.js";
import {
  SharedWorkspaceWatchBroker,
  SystemGraphWatcherManager,
  type SystemGraphWatchFactory,
  type SystemGraphWatchHandle,
} from "./system-graph-watcher.js";
import {
  snapshotWorkflowSourceRootsAsync,
  snapshotWorkspaceWorkflowsAsync,
  WorkspaceWatcherManager,
} from "./workspace-watcher.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let scope: WorkspaceScope;
let manager: SystemGraphWatcherManager;
let onSourceChange: ReturnType<typeof vi.fn>;
let onInventoryChange: ReturnType<typeof vi.fn>;
let sourceRoots: Set<string>;
let sourceObservations: Map<string, Set<string>>;

async function scaffoldAgent(name: string): Promise<string> {
  const agentRoot = path.join(root, name);
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "sapiom.json"),
    JSON.stringify({ name }),
  );
  await fs.writeFile(path.join(agentRoot, "index.ts"), "export {};\n");
  sourceRoots.add(agentRoot);
  sourceObservations.set(
    agentRoot,
    new Set([path.join(agentRoot, "index.ts")]),
  );
  return agentRoot;
}

describe("SystemGraphWatcherManager", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "system-graph-watch-"));
    scope = { workspaceKey: "workspace-test", root };
    onSourceChange = vi.fn();
    onInventoryChange = vi.fn();
    sourceRoots = new Set();
    sourceObservations = new Map();
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
        listSourceObservations: () =>
          [...sourceObservations].map(([candidateRoot, paths]) => ({
            candidateRoot,
            workspaceRoot: root,
            paths: [...paths],
          })),
        onSourceChange,
        onInventoryChange,
      },
      {
        forcePolling: true,
        sourceDebounceMs: 10,
        inventoryDebounceMs: 10,
        inventoryRetryBaseMs: 20,
        maxInventoryRetries: 2,
        pollIntervalMs: 25,
      },
    );
  });

  afterEach(async () => {
    manager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refreshes source relationships without reporting inventory churn", async () => {
    const agentRoot = await scaffoldAgent("research");
    await scaffoldAgent("growth");
    await manager.start(scope);
    await sleep(100);
    onSourceChange.mockClear();
    onInventoryChange.mockClear();

    await fs.writeFile(
      path.join(agentRoot, "index.ts"),
      'ctx.sapiom.agents.run({ definition: "growth" });\n',
    );
    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 20,
    });

    expect(onSourceChange).toHaveBeenCalled();
    expect(onSourceChange.mock.calls.at(-1)?.[0]).toEqual(scope);
    expect(onSourceChange.mock.calls.at(-1)?.[1]).toEqual([agentRoot]);
    expect(onInventoryChange).not.toHaveBeenCalled();
  });

  it("routes native paths, ignores generated churn, and recovers via polling", async () => {
    let watchListener!: Parameters<SystemGraphWatchFactory>[1];
    let errorListener!: (error: Error) => void;
    const close = vi.fn();
    const watchFactory: SystemGraphWatchFactory = (_watchRoot, listener) => {
      watchListener = listener;
      const handle: SystemGraphWatchHandle = {
        close,
        on: (_event, onError) => {
          errorListener = onError;
          return handle;
        },
      };
      return handle;
    };
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
        listSourceObservations: () =>
          [...sourceObservations].map(([candidateRoot, paths]) => ({
            candidateRoot,
            workspaceRoot: root,
            paths: [...paths],
          })),
        onSourceChange,
        onInventoryChange,
      },
      {
        watchFactory,
        sourceDebounceMs: 10,
        inventoryDebounceMs: 10,
        pollIntervalMs: 25,
      },
    );
    const agentRoot = await scaffoldAgent("research");
    await manager.start(scope);
    await sleep(100);
    onSourceChange.mockClear();

    watchListener("change", "research/index.ts");
    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 20,
    });
    expect(onSourceChange.mock.calls.at(-1)?.[1]).toEqual([
      path.join(agentRoot, "index.ts"),
    ]);

    onSourceChange.mockClear();
    watchListener("change", "node_modules/pkg/index.ts");
    await sleep(50);
    expect(onSourceChange).not.toHaveBeenCalled();

    onInventoryChange.mockClear();
    watchListener("rename", "research/.git");
    await vi.waitFor(() => expect(onInventoryChange).toHaveBeenCalledOnce(), {
      timeout: 2_000,
      interval: 20,
    });
    onInventoryChange.mockClear();
    watchListener("rename", "research/.git/objects/pack-1");
    await sleep(50);
    expect(onInventoryChange).not.toHaveBeenCalled();

    errorListener(new Error("recursive watch unavailable"));
    expect(close).toHaveBeenCalledTimes(1);
    await sleep(100);
    onSourceChange.mockClear();
    await fs.writeFile(
      path.join(agentRoot, "index.ts"),
      "export const recovered = true;\n",
    );
    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 20,
    });
    expect(onSourceChange.mock.calls.at(-1)?.[1]).toEqual([agentRoot]);
  });

  it("reports agent inventory additions and removals", async () => {
    await manager.start(scope);
    await sleep(100);
    const agentRoot = await scaffoldAgent("growth");
    await vi.waitFor(
      () => expect(onInventoryChange).toHaveBeenCalledWith(scope),
      { timeout: 2_000, interval: 20 },
    );

    onInventoryChange.mockClear();
    sourceRoots.delete(agentRoot);
    await fs.rm(agentRoot, { recursive: true, force: true });
    await vi.waitFor(
      () => expect(onInventoryChange).toHaveBeenCalledWith(scope),
      { timeout: 2_000, interval: 20 },
    );
  });

  it("retries a failed inventory refresh without another filesystem edit", async () => {
    onInventoryChange
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValue(undefined);
    await manager.start(scope);
    await scaffoldAgent("growth");

    await vi.waitFor(() => expect(onInventoryChange).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
      interval: 20,
    });
  });

  it("bounds inventory retries until a later filesystem change", async () => {
    onInventoryChange.mockRejectedValue(new Error("registry unavailable"));
    await manager.start(scope);
    await scaffoldAgent("growth");

    await vi.waitFor(() => expect(onInventoryChange).toHaveBeenCalledTimes(3), {
      timeout: 2_000,
      interval: 20,
    });
    await sleep(200);
    expect(onInventoryChange).toHaveBeenCalledTimes(3);

    await scaffoldAgent("reporting");
    await vi.waitFor(
      () => expect(onInventoryChange.mock.calls.length).toBeGreaterThan(3),
      { timeout: 2_000, interval: 20 },
    );
  });

  it("bounds source retries until a later raw event rearms recovery", async () => {
    let watchListener!: Parameters<SystemGraphWatchFactory>[1];
    const watchFactory: SystemGraphWatchFactory = (_watchRoot, listener) => {
      watchListener = listener;
      const handle: SystemGraphWatchHandle = {
        close: vi.fn(),
        on: () => handle,
      };
      return handle;
    };
    const agentRoot = await scaffoldAgent("retry-source");
    onSourceChange.mockRejectedValue(new Error("registry unavailable"));
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
        listSourceObservations: () => [],
        onSourceChange,
        onInventoryChange,
      },
      {
        watchFactory,
        sourceDebounceMs: 1,
        inventoryRetryBaseMs: 10,
        maxSourceRetries: 2,
      },
    );
    await manager.start(scope);

    vi.useFakeTimers();
    try {
      watchListener(
        "change",
        path.relative(root, path.join(agentRoot, "index.ts")),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(onSourceChange).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(onSourceChange).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20);
      expect(onSourceChange).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onSourceChange).toHaveBeenCalledTimes(3);

      watchListener(
        "change",
        path.relative(root, path.join(agentRoot, "index.ts")),
      );
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);
      expect(onSourceChange).toHaveBeenCalledTimes(6);
    } finally {
      manager.stopAll();
      vi.useRealTimers();
    }
  });

  it("polls every registered source file past Canvas's project-sized cap", async () => {
    const agentRoot = await scaffoldAgent("large");
    await Promise.all(
      Array.from({ length: 425 }, (_, index) =>
        fs.writeFile(
          path.join(agentRoot, `step-${index.toString().padStart(3, "0")}.ts`),
          `export const step${index} = ${index};\n`,
        ),
      ),
    );
    sourceObservations.get(agentRoot)?.add(path.join(agentRoot, "step-424.ts"));
    await manager.start(scope);
    await sleep(200);
    onSourceChange.mockClear();

    await fs.writeFile(
      path.join(agentRoot, "step-424.ts"),
      "export const step424 = 424_424;\n",
    );

    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 20,
    });
  });

  it("ignores non-source/generated churn but notices an unregistered source candidate", async () => {
    await manager.start(scope);
    await sleep(100);
    onSourceChange.mockClear();
    onInventoryChange.mockClear();
    await fs.writeFile(path.join(root, "README.md"), "notes\n");
    await fs.mkdir(path.join(root, "node_modules", "pkg"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "node_modules", "pkg", "index.ts"),
      "export {};\n",
    );
    await fs.mkdir(path.join(root, "unregistered"), { recursive: true });
    await fs.writeFile(
      path.join(root, "unregistered", "index.ts"),
      "export const ignored = true;\n",
    );
    await sleep(300);

    expect(onSourceChange).not.toHaveBeenCalled();
    expect(onInventoryChange).toHaveBeenCalledWith(scope);
  });

  it("does not re-baseline an existing workspace on repeated opens", async () => {
    await Promise.all([manager.start(scope), manager.start(scope)]);
    expect(manager.size).toBe(1);
  });

  it("retires watchers for scopes no longer exposed by Studio", async () => {
    await manager.start(scope);
    manager.retain(new Set());
    expect(manager.size).toBe(0);
  });

  it("closes and suppresses a pending watcher immediately when its scope retires", async () => {
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    let watchListener!: Parameters<SystemGraphWatchFactory>[1];
    const close = vi.fn();
    const onPotentialChange = vi.fn();
    const watchFactory: SystemGraphWatchFactory = (_watchRoot, listener) => {
      watchListener = listener;
      const handle: SystemGraphWatchHandle = {
        close,
        on: () => handle,
      };
      return handle;
    };
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [],
        onSourceChange,
        onInventoryChange,
        onPotentialChange,
      },
      {
        watchFactory,
        beforeInitialSnapshot: () => baselineGate,
        sourceDebounceMs: 5,
        inventoryDebounceMs: 5,
      },
    );

    const starting = manager.start(scope);
    manager.retain(new Set());

    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
    watchListener("rename", "agent/index.ts");
    await sleep(20);
    expect(onPotentialChange).not.toHaveBeenCalled();
    expect(onSourceChange).not.toHaveBeenCalled();
    expect(onInventoryChange).not.toHaveBeenCalled();

    releaseBaseline();
    await starting;
    expect(manager.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes an armed watcher when its initial baseline rejects", async () => {
    let watchListener!: Parameters<SystemGraphWatchFactory>[1];
    const close = vi.fn();
    const onPotentialChange = vi.fn();
    const watchFactory: SystemGraphWatchFactory = (_watchRoot, listener) => {
      watchListener = listener;
      const handle: SystemGraphWatchHandle = {
        close,
        on: () => handle,
      };
      return handle;
    };
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [],
        onSourceChange,
        onInventoryChange,
        onPotentialChange,
      },
      {
        watchFactory,
        beforeInitialSnapshot: () =>
          Promise.reject(new Error("baseline unavailable")),
        sourceDebounceMs: 5,
        inventoryDebounceMs: 5,
      },
    );

    await expect(manager.start(scope)).rejects.toThrow("baseline unavailable");
    expect(close).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
    watchListener("rename", "agent/index.ts");
    await sleep(20);
    expect(onPotentialChange).not.toHaveBeenCalled();
    expect(onSourceChange).not.toHaveBeenCalled();
    expect(onInventoryChange).not.toHaveBeenCalled();
  });

  it("reconciles every retained root when an ambiguous event races the initial baseline", async () => {
    const agentRoot = await scaffoldAgent("nested-checkout");
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    let watchListener!: Parameters<SystemGraphWatchFactory>[1];
    const watchFactory: SystemGraphWatchFactory = (_watchRoot, listener) => {
      watchListener = listener;
      const handle: SystemGraphWatchHandle = {
        close: vi.fn(),
        on: () => handle,
      };
      return handle;
    };
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
        listSourceObservations: () => [],
        onSourceChange,
        onInventoryChange,
      },
      {
        watchFactory,
        beforeInitialSnapshot: () => baselineGate,
        sourceDebounceMs: 5,
        inventoryDebounceMs: 5,
      },
    );

    const starting = manager.start(scope);
    watchListener("rename", null);

    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 10,
    });
    expect(onSourceChange.mock.calls.at(-1)?.[1]).toEqual([agentRoot]);

    releaseBaseline();
    await starting;
  });

  it("owns one polling baseline and reconciles an edit absorbed into it", async () => {
    const agentRoot = await scaffoldAgent("polling-baseline");
    let releaseBaseline!: () => void;
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const snapshotWorkspace = vi.fn(snapshotWorkspaceWorkflowsAsync);
    const snapshotSources = vi.fn(snapshotWorkflowSourceRootsAsync);
    const onPotentialChange = vi.fn();
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
        listSourceObservations: () => [],
        onSourceChange,
        onInventoryChange,
        onPotentialChange,
      },
      {
        forcePolling: true,
        beforeInitialSnapshot: () => baselineGate,
        snapshotWorkspace,
        snapshotSources,
        sourceDebounceMs: 5,
        pollIntervalMs: 60_000,
      },
    );

    const starting = manager.start(scope);
    await Promise.resolve();
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(snapshotSources).not.toHaveBeenCalled();

    await fs.writeFile(
      path.join(agentRoot, "index.ts"),
      "export const changedDuringBaseline = true;\n",
    );
    releaseBaseline();
    await starting;

    await vi.waitFor(() => expect(onSourceChange).toHaveBeenCalledOnce(), {
      timeout: 2_000,
      interval: 10,
    });
    expect(snapshotWorkspace).toHaveBeenCalledTimes(1);
    expect(snapshotSources).toHaveBeenCalledTimes(1);
    expect(onPotentialChange).toHaveBeenCalledOnce();
    expect(onPotentialChange).toHaveBeenCalledWith(scope, null);
    expect(onSourceChange).toHaveBeenCalledWith(scope, [agentRoot]);
  });

  it("shares one canonical-root watcher across two sessions and a graph caller", async () => {
    const agentRoot = await scaffoldAgent("shared-agent");
    let watchListener!: Parameters<SystemGraphWatchFactory>[1];
    const close = vi.fn();
    const watchFactory = vi.fn<SystemGraphWatchFactory>(
      (_watchRoot, listener) => {
        watchListener = listener;
        const handle: SystemGraphWatchHandle = {
          close,
          on: () => handle,
        };
        return handle;
      },
    );
    const broker = new SharedWorkspaceWatchBroker({
      watchFactory,
      sourceDebounceMs: 5,
      inventoryDebounceMs: 5,
    });
    const sessionChange = vi.fn();
    const sessionPotential = vi.fn();
    const sessions = new WorkspaceWatcherManager({
      sharedWatchBroker: broker,
      listSourceRoots: () => [...sourceRoots],
      listSourceObservations: () => [],
      onPotentialChange: sessionPotential,
      onChange: sessionChange,
    });
    const graphSourceChange = vi.fn();
    const graphPotential = vi.fn();
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
        listSourceObservations: () => [],
        onPotentialChange: graphPotential,
        onSourceChange: graphSourceChange,
        onInventoryChange,
      },
      { sharedBroker: broker },
    );

    sessions.start("session-a", root);
    sessions.start("session-b", path.join(root, "."));
    await manager.start(scope);

    expect(watchFactory).toHaveBeenCalledTimes(1);
    expect(broker.size).toBe(1);
    watchListener(
      "change",
      path.relative(root, path.join(agentRoot, "index.ts")),
    );

    await vi.waitFor(() => expect(graphSourceChange).toHaveBeenCalledOnce(), {
      timeout: 2_000,
      interval: 10,
    });
    expect(sessionChange).toHaveBeenCalledTimes(2);
    expect(sessionChange.mock.calls.map((call) => call[0]).sort()).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(sessionChange.mock.calls.map((call) => call[1])).toEqual([
      [agentRoot],
      [agentRoot],
    ]);
    expect(sessionPotential).toHaveBeenCalledTimes(2);
    expect(graphPotential).toHaveBeenCalledOnce();

    sessions.stopAll();
    manager.retain(new Set());
    expect(broker.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cleans a rejected shared subscription so the same scope can retry", async () => {
    let attempts = 0;
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const watchFactory = vi.fn<SystemGraphWatchFactory>(() => {
      const close = vi.fn();
      closes.push(close);
      const handle: SystemGraphWatchHandle = {
        close,
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
    });
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [],
        onSourceChange,
        onInventoryChange,
      },
      { sharedBroker: broker },
    );

    await expect(manager.start(scope)).rejects.toThrow("first baseline failed");
    expect(manager.size).toBe(0);
    expect(broker.size).toBe(0);
    expect(closes[0]).toHaveBeenCalledTimes(1);

    await manager.start(scope);
    expect(watchFactory).toHaveBeenCalledTimes(2);
    expect(manager.size).toBe(1);
    expect(broker.size).toBe(1);
  });
});
