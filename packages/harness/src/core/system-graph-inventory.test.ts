import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import {
  dirtyGraphSourceRoots,
  graphSourceRootsWithinScope,
  HarnessRegistryInventoryProvider,
  type WorkspaceScope,
} from "./system-graph-inventory.js";
import type { ManifestNameInspection } from "./definition-name.js";

const WORKSPACE = "/private/workspaces/acme";
const SCOPE: WorkspaceScope = {
  workspaceKey: "workspace-acme",
  root: WORKSPACE,
};

function workflow(
  name: string,
  relativePath: string,
  definitionSlug: string | null,
  overrides: Partial<WorkflowInfo> = {},
): WorkflowInfo {
  return {
    name,
    path: `${WORKSPACE}/${relativePath}`,
    definitionId: definitionSlug ? 1 : null,
    definitionSlug,
    source: "scan",
    ...overrides,
  };
}

function provider(
  workflows: readonly WorkflowInfo[],
  options: {
    inspectManifestName?: (
      sourceRoot: string,
    ) => Promise<ManifestNameInspection>;
    manifestInspectionBudgetMs?: number;
  } = {},
): HarnessRegistryInventoryProvider {
  return new HarnessRegistryInventoryProvider({
    listWorkflows: () => workflows,
    ...(options.inspectManifestName
      ? { inspectManifestName: options.inspectManifestName }
      : {}),
    ...(options.manifestInspectionBudgetMs !== undefined
      ? { manifestInspectionBudgetMs: options.manifestInspectionBudgetMs }
      : {}),
  });
}

describe("HarnessRegistryInventoryProvider", () => {
  it("matches canonical workflow roots beneath a symlinked workspace", async () => {
    if (process.platform === "win32") return;
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-symlink-"),
    );
    try {
      const workspaceRoot = path.join(tempRoot, "real-workspace");
      const agentRoot = path.join(workspaceRoot, "agent");
      const nestedRoot = path.join(agentRoot, "nested-agent");
      const outsideRoot = path.join(tempRoot, "outside", "agent");
      const linkedRoot = path.join(tempRoot, "linked-workspace");
      await Promise.all([
        fs.mkdir(nestedRoot, { recursive: true }),
        fs.mkdir(outsideRoot, { recursive: true }),
      ]);
      await fs.symlink(workspaceRoot, linkedRoot, "dir");

      const canonicalAgentRoot = await fs.realpath(agentRoot);
      const canonicalNestedRoot = await fs.realpath(nestedRoot);
      expect(
        graphSourceRootsWithinScope(linkedRoot, [
          agentRoot,
          nestedRoot,
          outsideRoot,
        ]),
      ).toEqual([canonicalAgentRoot, canonicalNestedRoot]);
      expect(
        dirtyGraphSourceRoots(
          linkedRoot,
          [agentRoot, nestedRoot, outsideRoot],
          [path.join(linkedRoot, "agent", "nested-agent", "index.ts")],
        ),
      ).toEqual([canonicalNestedRoot]);
      expect(
        dirtyGraphSourceRoots(
          linkedRoot,
          [agentRoot, nestedRoot],
          [path.join(linkedRoot, "unregistered", "index.ts")],
        ),
      ).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns every registry-known agent regardless of deployment, source, or relationships", async () => {
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      if (sourceRoot.endsWith("/growth")) {
        return { status: "found" as const, name: "growth-manifest" };
      }
      return { status: "absent" as const };
    });
    const inventory = provider(
      [
        workflow("Research package", "research", "research", {
          definitionId: 101,
        }),
        workflow("Growth package", "growth", null, { source: "connect" }),
        workflow("Reporting package", "reporting", null),
        {
          ...workflow("Outside", "outside", "outside"),
          path: `${WORKSPACE}-archive/outside`,
        },
      ],
      { inspectManifestName },
    );

    await expect(inventory.listAgents(SCOPE)).resolves.toEqual({
      agents: [
        {
          agentKey: "growth-manifest",
          definitionId: null,
          definitionSlug: null,
          label: "Growth package",
          resolutionAliases: ["growth-manifest"],
          sourceRoot: `${WORKSPACE}/growth`,
        },
        {
          agentKey: "local:reporting",
          definitionId: null,
          definitionSlug: null,
          label: "Reporting package",
          resolutionAliases: ["local:reporting"],
          sourceRoot: `${WORKSPACE}/reporting`,
        },
        {
          agentKey: "research",
          definitionId: 101,
          definitionSlug: "research",
          label: "Research package",
          resolutionAliases: ["research"],
          sourceRoot: `${WORKSPACE}/research`,
        },
      ],
      cacheable: true,
      warnings: [],
    });
    expect(inspectManifestName).toHaveBeenCalledTimes(2);
    expect(inspectManifestName).not.toHaveBeenCalledWith(
      `${WORKSPACE}/research`,
    );
  });

  it("bounds manifest inspection concurrency and keeps partial results", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      started.push(sourceRoot);
      await gate;
      if (sourceRoot.endsWith("/broken")) {
        return { status: "failed" as const };
      }
      if (sourceRoot.endsWith("/thrown")) {
        throw new Error(`unreadable ${sourceRoot}`);
      }
      return sourceRoot.endsWith("/named")
        ? { status: "found" as const, name: "declared-name" }
        : { status: "absent" as const };
    });
    const inventoryPromise = provider(
      [
        workflow("Named", "named", null),
        workflow("Broken", "broken", null),
        workflow("Thrown", "thrown", null),
        workflow("Fallback", "fallback", null),
        workflow("Extra A", "extra-a", null),
        workflow("Extra B", "extra-b", null),
      ],
      { inspectManifestName },
    ).listAgents(SCOPE);

    await vi.waitFor(() => expect(started).toHaveLength(4));
    await Promise.resolve();
    expect(started).toHaveLength(4);
    release();
    const result = await inventoryPromise;

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "declared-name",
      "local:broken",
      "local:extra-a",
      "local:extra-b",
      "local:fallback",
      "local:thrown",
    ]);
    expect(result.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:broken",
        message: "Could not inspect Broken; using its local identity.",
      },
      {
        code: "inventory-extraction-failed",
        agentKey: "local:thrown",
        message: "Could not inspect Thrown; using its local identity.",
      },
    ]);
    expect(inspectManifestName).toHaveBeenCalledTimes(6);
    expect(result.cacheable).toBe(false);
    expect(JSON.stringify(result.warnings)).not.toContain(WORKSPACE);
  });

  it("returns partial inventory when the enrichment budget expires", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const inspectManifestName = vi.fn(async (sourceRoot: string) => {
      started.push(sourceRoot);
      if (sourceRoot.endsWith("/fast")) {
        return { status: "found" as const, name: "fast-manifest" };
      }
      await gate;
      return { status: "absent" as const };
    });

    const result = await provider(
      [
        workflow("Fast", "fast", null),
        workflow("Slow A", "slow-a", null),
        workflow("Slow B", "slow-b", null),
        workflow("Slow C", "slow-c", null),
        workflow("Slow D", "slow-d", null),
        workflow("Slow E", "slow-e", null),
      ],
      { inspectManifestName, manifestInspectionBudgetMs: 20 },
    ).listAgents(SCOPE);

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "fast-manifest",
      "local:slow-a",
      "local:slow-b",
      "local:slow-c",
      "local:slow-d",
      "local:slow-e",
    ]);
    expect(
      result.warnings.map(({ code, agentKey }) => [code, agentKey]),
    ).toEqual([
      ["inventory-extraction-failed", "local:slow-a"],
      ["inventory-extraction-failed", "local:slow-b"],
      ["inventory-extraction-failed", "local:slow-c"],
      ["inventory-extraction-failed", "local:slow-d"],
      ["inventory-extraction-failed", "local:slow-e"],
    ]);
    expect(started).toHaveLength(5);
    expect(result.cacheable).toBe(false);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveLength(5);
  });

  it("includes nested agents in every containing selected project", async () => {
    const nestedRoot = `${WORKSPACE}/experiments`;
    const workflows = [
      workflow("Root agent", "", "root-agent"),
      workflow("Parent agent", "research", "research"),
      workflow("Nested agent", "experiments/evaluator", "evaluator"),
      {
        ...workflow("Prefix sibling", "sibling", "sibling"),
        path: `${WORKSPACE}-archive/sibling`,
      },
    ];

    const parent = await provider(workflows).listAgents(SCOPE);
    const nested = await provider(workflows).listAgents({
      workspaceKey: "workspace-experiments",
      root: nestedRoot,
    });

    expect(parent.agents.map((agent) => agent.agentKey)).toEqual([
      "evaluator",
      "research",
      "root-agent",
    ]);
    expect(nested.agents.map((agent) => agent.agentKey)).toEqual(["evaluator"]);
  });

  it("does not confuse same-basename roots or mixed Windows separators", async () => {
    const windowsScope: WorkspaceScope = {
      workspaceKey: "workspace-windows",
      root: "C:\\Users\\Demo\\project",
    };
    const workflows: WorkflowInfo[] = [
      {
        ...workflow("Windows parent", "unused", "windows-parent"),
        path: "c:/users/demo/project/main-agent",
      },
      {
        ...workflow("Windows nested", "unused", "windows-nested"),
        path: "C:\\Users\\Demo\\project\\experiments\\evaluator",
      },
      {
        ...workflow("Prefix sibling", "unused", "prefix-sibling"),
        path: "C:\\Users\\Demo\\project-old\\agent",
      },
      {
        ...workflow("Other basename", "unused", "other"),
        path: "D:\\Other\\project\\agent",
      },
    ];
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => workflows,
    });

    const result = await inventory.listAgents(windowsScope);

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "windows-nested",
      "windows-parent",
    ]);
  });

  it("preserves duplicate slugs with deterministic local identities and a warning", async () => {
    const result = await provider([
      workflow("First copy", "first", "shared"),
      workflow("Second copy", "second", "shared", { source: "connect" }),
    ]).listAgents(SCOPE);

    expect(result.agents).toMatchObject([
      {
        agentKey: "local:first",
        definitionSlug: "shared",
        resolutionAliases: ["shared"],
      },
      {
        agentKey: "local:second",
        definitionSlug: "shared",
        resolutionAliases: ["shared"],
      },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain(WORKSPACE);
  });

  it("keeps a duplicated local candidate ambiguous after suffixing its node ids", async () => {
    const duplicate = workflow("Connected copy", "connected", null, {
      source: "connect",
    });

    const result = await provider([duplicate, { ...duplicate }]).listAgents(
      SCOPE,
    );

    expect(result.agents.map((agent) => agent.agentKey)).toEqual([
      "local:connected",
      "local:connected~2",
    ]);
    expect(result.agents.map((agent) => agent.resolutionAliases)).toEqual([
      ["local:connected"],
      ["local:connected"],
    ]);
    expect(result.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "local:connected",
        message:
          "Multiple agents use local:connected; kept each with a local identity.",
      },
    ]);
  });

  it("needs only the selected scope to build a cacheable inventory", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [workflow("Research", "research", "research")],
    });

    await expect(inventory.listAgents(SCOPE)).resolves.toMatchObject({
      agents: [{ agentKey: "research" }],
      cacheable: true,
      warnings: [],
    });
  });

  it("fails the provider call when the registry snapshot cannot be read", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: async () => {
        throw new Error("registry unavailable");
      },
    });

    await expect(inventory.listAgents(SCOPE)).rejects.toThrow(
      "registry unavailable",
    );
  });
});
