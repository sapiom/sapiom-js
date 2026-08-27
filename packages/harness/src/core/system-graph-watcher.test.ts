import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceScope } from "./system-graph.js";
import {
  SystemGraphWatcherManager,
  type SystemGraphWatchFactory,
  type SystemGraphWatchHandle,
} from "./system-graph-watcher.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let scope: WorkspaceScope;
let manager: SystemGraphWatcherManager;
let onSourceChange: ReturnType<typeof vi.fn>;
let onInventoryChange: ReturnType<typeof vi.fn>;
let sourceRoots: Set<string>;

async function scaffoldAgent(name: string): Promise<string> {
  const agentRoot = path.join(root, name);
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "sapiom.json"),
    JSON.stringify({ name }),
  );
  await fs.writeFile(path.join(agentRoot, "index.ts"), "export {};\n");
  sourceRoots.add(agentRoot);
  return agentRoot;
}

describe("SystemGraphWatcherManager", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "system-graph-watch-"));
    scope = { workspaceKey: "workspace-test", root };
    onSourceChange = vi.fn();
    onInventoryChange = vi.fn();
    sourceRoots = new Set();
    manager = new SystemGraphWatcherManager(
      {
        listSourceRoots: () => [...sourceRoots],
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

  it("ignores non-source and generated-tree churn", async () => {
    await manager.start(scope);
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
    expect(onInventoryChange).not.toHaveBeenCalled();
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
});
