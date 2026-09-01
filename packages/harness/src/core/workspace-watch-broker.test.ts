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
    await fs.rm(root, { recursive: true, force: true });
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
    const alias = `${root}-alias`;
    await fs.symlink(root, alias, "dir");
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
    await broker.subscribe(secondKey, subscriber({ root: alias }));

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

    await fs.unlink(alias);
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
