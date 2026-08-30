import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { PackageInventoryAgent } from "@sapiom/agent";
import type { WorkflowInfo } from "../shared/types.js";
import {
  HarnessRegistryInventoryProvider,
  CachedAgentInvocationProvider,
  LocalWorkspaceScopeCatalog,
  StaticSystemGraphBuilder,
  type AgentInventoryProvider,
  type AgentInventoryResult,
  type AgentInvocationProvider,
  type AgentInvocationProviderResult,
  type WorkspaceScope,
} from "./system-graph.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "system-graph-workspace",
);

function workflow(
  name: string,
  relativePath: string,
  definitionSlug: string | null,
): WorkflowInfo {
  return {
    name,
    path: path.join(FIXTURE, relativePath),
    definitionId: definitionSlug ? 1 : null,
    definitionSlug,
    source: "scan",
  };
}

async function buildGraph(
  builder: StaticSystemGraphBuilder,
  scope: WorkspaceScope,
) {
  return (await builder.build(scope)).graph;
}

function invocationProvider(
  listInvocations: (
    sourceRoot: string,
  ) => Promise<AgentInvocationProviderResult>,
): AgentInvocationProvider {
  return {
    listInvocations: vi.fn((caller) => listInvocations(caller.sourceRoot)),
  };
}

const EMPTY_INVOCATIONS: AgentInvocationProviderResult = {
  invocations: [],
  warnings: [],
};

const EVIDENCE = [{ file: "index.ts", line: 1, column: 1 }];
const REVISION = `sha256:${"a".repeat(64)}` as const;

function inventoryResult(
  scope: WorkspaceScope,
  agents: Array<{
    agentKey: string;
    label: string;
    sourceRoot?: string;
    workflowPath?: string;
    definitionId?: number | null;
    definitionSlug?: string | null;
    resolutionAliases?: string[];
    provisional?: boolean;
    identityIssue?:
      | "identity-pending"
      | "identity-unavailable"
      | "identity-invalid"
      | "duplicate-agent-key";
    candidateAgentKey?: string;
  }>,
  options: {
    warnings?: AgentInventoryResult["warnings"];
    degraded?: boolean;
    identitySettled?: boolean;
  } = {},
): AgentInventoryResult {
  const records = agents.map((agent) => {
    const sourceRoot =
      agent.sourceRoot ?? path.join(scope.root, agent.agentKey);
    const relative =
      path.relative(scope.root, sourceRoot).split(path.sep).join("/") || ".";
    const provisional =
      agent.provisional ?? agent.agentKey.startsWith("local:");
    let publicAgent: PackageInventoryAgent;
    if (!provisional) {
      publicAgent = {
        agentKey: agent.agentKey,
        identityStatus: "canonical",
        path: relative,
        entrypoint: "index.ts",
      };
    } else if (agent.identityIssue === "duplicate-agent-key") {
      if (!agent.candidateAgentKey) {
        throw new Error(
          "Duplicate inventory fixtures require a candidate agent key",
        );
      }
      publicAgent = {
        agentKey: agent.agentKey,
        identityStatus: "provisional",
        identityIssue: "duplicate-agent-key",
        candidateAgentKey: agent.candidateAgentKey,
        path: relative,
        entrypoint: "index.ts",
      };
    } else {
      publicAgent = {
        agentKey: agent.agentKey,
        identityStatus: "provisional",
        identityIssue: agent.identityIssue ?? "identity-unavailable",
        path: relative,
        entrypoint: "index.ts",
      };
    }
    return {
      public: publicAgent,
      context: {
        agentKey: agent.agentKey,
        definitionId: agent.definitionId ?? null,
        definitionSlug: agent.definitionSlug ?? null,
        label: agent.label,
        resolutionAliases: agent.resolutionAliases ?? [],
        sourceRoot,
        workflowPath: agent.workflowPath ?? sourceRoot,
        path: relative,
        entrypoint: "index.ts",
      },
    };
  });
  const degraded =
    options.degraded ??
    records.some((record) => record.public.identityStatus === "provisional");
  return {
    inventory: {
      protocol: 1,
      version: {
        kind: "working-tree",
        workspaceKey: scope.workspaceKey,
        revision: REVISION,
      },
      status: degraded ? "degraded" : "complete",
      agents: records.map((record) => record.public),
    },
    context: records.map((record) => record.context),
    warnings: options.warnings ?? [],
    identitySettled:
      options.identitySettled ??
      !records.some(
        (record) =>
          record.public.identityStatus === "provisional" &&
          record.public.identityIssue === "identity-pending",
      ),
  };
}

describe("LocalWorkspaceScopeCatalog", () => {
  it("gives a canonical root a stable opaque key and rejects unknown keys", async () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      FIXTURE,
      path.join(FIXTURE, "."),
    ]);
    const scopes = await catalog.list();

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.workspaceKey).toMatch(/^workspace-[a-f0-9]{16}$/);
    expect(scopes[0]!.workspaceKey).not.toContain(FIXTURE);
    expect((await catalog.resolve(scopes[0]!.workspaceKey))?.root).toBe(
      FIXTURE,
    );
    await expect(catalog.resolve("workspace-not-known")).resolves.toBeNull();
  });

  it("does not collide when two roots share a basename", async () => {
    const catalog = new LocalWorkspaceScopeCatalog(() => [
      "/tmp/one/project",
      "/tmp/two/project",
    ]);
    expect(
      new Set((await catalog.list()).map((scope) => scope.workspaceKey)).size,
    ).toBe(2);
  });

  it("can resolve persisted workspace roots without a live session", async () => {
    const listRoots = vi.fn(async () => [FIXTURE]);
    const catalog = new LocalWorkspaceScopeCatalog(listRoots);
    const [scope] = await catalog.list();

    await expect(catalog.resolve(scope!.workspaceKey)).resolves.toEqual({
      workspaceKey: scope!.workspaceKey,
      root: FIXTURE,
    });
  });
});

describe("StaticSystemGraphBuilder", () => {
  const scope: WorkspaceScope = {
    workspaceKey: "workspace-fixture",
    root: FIXTURE,
  };

  it("projects literal Research -> Growth blocking and async calls into the public contract", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(scope, [
          {
            agentKey: "growth",
            label: "Growth",
            sourceRoot: path.join(FIXTURE, "growth"),
            resolutionAliases: ["growth"],
          },
          {
            agentKey: "research",
            label: "Research",
            sourceRoot: path.join(FIXTURE, "research"),
            resolutionAliases: ["research"],
          },
        ]),
      ),
    };

    const builder = new StaticSystemGraphBuilder(inventory);
    const first = await builder.build(scope);

    // The cold phase is inventory-only: all cards and navigation are available
    // before bounded project invocation I/O starts.
    expect(first.cacheable).toBe(false);
    expect(first.graph.nodes).toHaveLength(2);
    expect(first.graph.edges).toEqual([]);
    expect(first.navigation).toHaveLength(2);
    first.afterCommit?.();

    let graph = first.graph;
    await vi.waitFor(async () => {
      graph = (await builder.build(scope)).graph;
      expect(graph.edges).toHaveLength(2);
    });

    expect(graph).toEqual({
      kind: "system",
      scope: { kind: "working-tree", workspaceKey: "workspace-fixture" },
      nodes: [
        { id: "agent:growth", agentKey: "growth", label: "Growth" },
        { id: "agent:research", agentKey: "research", label: "Research" },
      ],
      edges: [
        {
          from: "agent:research",
          to: "agent:growth",
          kind: "invokes",
          basis: "static-invocation",
          mode: "blocking",
        },
        {
          from: "agent:research",
          to: "agent:growth",
          kind: "invokes",
          basis: "static-invocation",
          mode: "async",
        },
      ],
      warnings: [],
    });
    expect(JSON.stringify(graph)).not.toContain(FIXTURE);
  });

  it("returns inventory navigation while invocation extraction is still held", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(scope, [
          {
            agentKey: "growth",
            label: "Growth",
            resolutionAliases: ["growth"],
          },
          {
            agentKey: "research",
            label: "Research",
            resolutionAliases: ["research"],
          },
        ]),
      ),
    };
    let release!: (result: AgentInvocationProviderResult) => void;
    const held = new Promise<AgentInvocationProviderResult>((resolve) => {
      release = resolve;
    });
    const inner = invocationProvider(async (root) =>
      root.endsWith("research") ? held : EMPTY_INVOCATIONS,
    );
    const onChange = vi.fn();
    const invocations = new CachedAgentInvocationProvider(
      inner,
      async () => "unused",
      { concurrency: 1, onChange },
    );
    const builder = new StaticSystemGraphBuilder(inventory, invocations);

    const cold = await builder.build(scope);

    expect(inner.listInvocations).not.toHaveBeenCalled();
    expect(cold.cacheable).toBe(false);
    expect(cold.graph.nodes.map((node) => node.agentKey)).toEqual([
      "growth",
      "research",
    ]);
    expect(cold.graph.edges).toEqual([]);
    expect(cold.navigation?.map((target) => target.agentKey)).toEqual([
      "growth",
      "research",
    ]);

    cold.afterCommit?.();
    await vi.waitFor(() => expect(inner.listInvocations).toHaveBeenCalled());
    // The held project task cannot withhold the already-returned inventory.
    expect(cold.graph.nodes).toHaveLength(2);
    release({
      invocations: [
        {
          target: "growth",
          mode: "blocking",
          evidence: EVIDENCE,
        },
      ],
      warnings: [],
    });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const enriched = await builder.build(scope);
    expect(enriched.graph.edges).toEqual([
      {
        from: "agent:research",
        to: "agent:growth",
        kind: "invokes",
        basis: "static-invocation",
        mode: "blocking",
      },
    ]);
    expect(enriched.cacheable).toBe(true);
  });

  it("deduplicates by mode, retains dual-mode edges, and reports duplicate and unresolved targets", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(scope, [
          {
            agentKey: "research",
            definitionId: 1,
            definitionSlug: "research",
            label: "Research",
            resolutionAliases: ["research"],
          },
          {
            agentKey: "growth",
            definitionId: 2,
            definitionSlug: "growth",
            label: "Growth",
            resolutionAliases: ["growth"],
          },
        ]),
      ),
    };
    const invocations = invocationProvider(async (root) =>
      root.endsWith("research")
        ? {
            invocations: [
              {
                target: "growth",
                mode: "blocking",
                evidence: [
                  ...EVIDENCE,
                  { file: "second.ts", line: 2, column: 1 },
                ],
              },
              { target: "growth", mode: "async", evidence: EVIDENCE },
              { target: "research", mode: "async", evidence: EVIDENCE },
              { target: "missing", mode: "async", evidence: EVIDENCE },
            ],
            warnings: [],
          }
        : EMPTY_INVOCATIONS,
    );

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(inventory, invocations),
      scope,
    );
    expect(graph.edges).toEqual([
      {
        from: "agent:research",
        to: "agent:growth",
        kind: "invokes",
        basis: "static-invocation",
        mode: "blocking",
      },
      {
        from: "agent:research",
        to: "agent:growth",
        kind: "invokes",
        basis: "static-invocation",
        mode: "async",
      },
    ]);
    expect(graph.warnings.map((warning) => warning.code)).toEqual([
      "duplicate-edge",
      "unresolved-target",
    ]);
    expect(graph.warnings[0]).toEqual({
      code: "duplicate-edge",
      agentKey: "research",
      message: "Research invokes Growth more than once.",
    });
    expect(JSON.stringify(graph)).not.toContain("/private/");
  });

  it("projects dynamic extraction warnings without degrading cacheability or leaking evidence", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(scope, [
          {
            agentKey: "research",
            definitionId: 1,
            definitionSlug: "research",
            label: "Research",
            resolutionAliases: ["research"],
          },
        ]),
      ),
    };
    const invocations = invocationProvider(async () => ({
      invocations: [],
      warnings: [
        {
          code: "dynamic-target",
          mode: "blocking",
          evidence: { file: "private/index.ts", line: 8, column: 5 },
        },
      ],
    }));

    const built = await new StaticSystemGraphBuilder(
      inventory,
      invocations,
    ).build(scope);

    expect(built.cacheable).toBe(true);
    expect(built.graph.edges).toEqual([]);
    expect(built.graph.warnings).toEqual([
      {
        code: "dynamic-target",
        agentKey: "research",
        message: "Research has a dynamic agent target that V0 cannot resolve.",
      },
    ]);
    expect(JSON.stringify(built.graph)).not.toContain("private/index.ts");
  });

  it("keeps duplicate definition slugs as unique nodes and reports ambiguous launches", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(
          scope,
          [
            {
              agentKey: "caller",
              label: "Caller",
              resolutionAliases: ["caller"],
            },
            {
              agentKey: "local:growth",
              label: "First copy",
              sourceRoot: path.join(FIXTURE, "growth"),
              resolutionAliases: ["shared"],
              provisional: true,
              identityIssue: "duplicate-agent-key",
              candidateAgentKey: "shared",
            },
            {
              agentKey: "local:research",
              label: "Second copy",
              sourceRoot: path.join(FIXTURE, "research"),
              resolutionAliases: ["shared"],
              provisional: true,
              identityIssue: "duplicate-agent-key",
              candidateAgentKey: "shared",
            },
          ],
          {
            degraded: true,
            warnings: [
              {
                code: "duplicate-agent-key",
                agentKey: "shared",
                message:
                  "Multiple agents use shared; kept each with a local identity.",
              },
            ],
          },
        ),
      ),
    };
    const invocations = invocationProvider(async (root) =>
      root.endsWith("caller")
        ? {
            invocations: [
              { target: "shared", mode: "async", evidence: EVIDENCE },
            ],
            warnings: [],
          }
        : EMPTY_INVOCATIONS,
    );

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(inventory, invocations),
      scope,
    );

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "agent:caller",
      "agent:local:growth",
      "agent:local:research",
    ]);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(3);
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
      {
        code: "unresolved-target",
        agentKey: "caller",
        message: "Caller invokes ambiguous agent shared.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain(FIXTURE);
  });

  it("synthesizes a duplicate warning from public identity evidence", async () => {
    const result = inventoryResult(
      scope,
      [
        {
          agentKey: "local:only",
          label: "Only",
          sourceRoot: path.join(FIXTURE, "only"),
          provisional: true,
          identityIssue: "duplicate-agent-key",
          candidateAgentKey: "shared",
          resolutionAliases: ["shared"],
        },
      ],
      { degraded: true, warnings: [] },
    );
    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => result },
        invocationProvider(async () => EMPTY_INVOCATIONS),
      ),
      scope,
    );

    expect(graph.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);
  });

  it("deduplicates redundant provider duplicate warnings", async () => {
    const duplicateWarning = {
      code: "duplicate-agent-key" as const,
      agentKey: "shared",
      message: "provider-owned private wording",
    };
    const result = inventoryResult(
      scope,
      [
        {
          agentKey: "local:only",
          label: "Only",
          sourceRoot: path.join(FIXTURE, "only"),
          provisional: true,
          identityIssue: "duplicate-agent-key",
          candidateAgentKey: "shared",
          resolutionAliases: ["shared"],
        },
      ],
      {
        degraded: true,
        warnings: [duplicateWarning, duplicateWarning],
      },
    );
    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => result },
        invocationProvider(async () => EMPTY_INVOCATIONS),
      ),
      scope,
    );

    expect(graph.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain("provider-owned");
  });

  it("rejects a provider duplicate warning without matching public evidence", async () => {
    const result = inventoryResult(
      scope,
      [{ agentKey: "reporting", label: "Reporting" }],
      {
        warnings: [
          {
            code: "duplicate-agent-key",
            agentKey: "unsupported",
            message: "private",
          },
        ],
      },
    );

    await expect(
      buildGraph(
        new StaticSystemGraphBuilder(
          { listAgents: async () => result },
          invocationProvider(async () => EMPTY_INVOCATIONS),
        ),
        scope,
      ),
    ).rejects.toThrow("inventory warning was invalid");
  });

  it("resolves an exact canonical key before a stale compatibility alias", async () => {
    const inventory = inventoryResult(
      scope,
      [
        {
          agentKey: "caller",
          label: "Caller",
          sourceRoot: path.join(FIXTURE, "caller"),
        },
        {
          agentKey: "payments",
          label: "Payments",
          sourceRoot: path.join(FIXTURE, "payments"),
        },
        {
          agentKey: "local:pending",
          label: "Pending",
          sourceRoot: path.join(FIXTURE, "pending"),
          provisional: true,
          identityIssue: "identity-unavailable",
          resolutionAliases: ["payments"],
        },
      ],
      { degraded: true },
    );
    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => inventory },
        invocationProvider(async (sourceRoot) =>
          sourceRoot.endsWith("caller")
            ? {
                invocations: [
                  { target: "payments", mode: "async", evidence: EVIDENCE },
                ],
                warnings: [],
              }
            : EMPTY_INVOCATIONS,
        ),
      ),
      scope,
    );

    expect(graph.edges).toEqual([
      {
        from: "agent:caller",
        to: "agent:payments",
        kind: "invokes",
        basis: "static-invocation",
        mode: "async",
      },
    ]);
  });

  it("keeps a invocation ambiguous when only multiple aliases match", async () => {
    const inventory = inventoryResult(
      scope,
      [
        {
          agentKey: "caller",
          label: "Caller",
          sourceRoot: path.join(FIXTURE, "caller"),
        },
        {
          agentKey: "local:first",
          label: "First",
          sourceRoot: path.join(FIXTURE, "first"),
          provisional: true,
          resolutionAliases: ["legacy"],
        },
        {
          agentKey: "local:second",
          label: "Second",
          sourceRoot: path.join(FIXTURE, "second"),
          provisional: true,
          resolutionAliases: ["legacy"],
        },
      ],
      { degraded: true },
    );
    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => inventory },
        invocationProvider(async (sourceRoot) =>
          sourceRoot.endsWith("caller")
            ? {
                invocations: [
                  { target: "legacy", mode: "async", evidence: EVIDENCE },
                ],
                warnings: [],
              }
            : EMPTY_INVOCATIONS,
        ),
      ),
      scope,
    );

    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toContainEqual({
      code: "unresolved-target",
      agentKey: "caller",
      message: "Caller invokes ambiguous agent legacy.",
    });
  });

  it("keeps a provisional public key ambiguous with another agent's alias", async () => {
    const inventory = inventoryResult(
      scope,
      [
        {
          agentKey: "caller",
          label: "Caller",
          sourceRoot: path.join(FIXTURE, "caller"),
        },
        {
          agentKey: "legacy",
          label: "Provisional",
          sourceRoot: path.join(FIXTURE, "provisional"),
          provisional: true,
          identityIssue: "identity-unavailable",
        },
        {
          agentKey: "current",
          label: "Current",
          sourceRoot: path.join(FIXTURE, "current"),
          resolutionAliases: ["legacy"],
        },
      ],
      { degraded: true },
    );
    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => inventory },
        invocationProvider(async (sourceRoot) =>
          sourceRoot.endsWith("caller")
            ? {
                invocations: [
                  { target: "legacy", mode: "async", evidence: EVIDENCE },
                ],
                warnings: [],
              }
            : EMPTY_INVOCATIONS,
        ),
      ),
      scope,
    );

    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toContainEqual({
      code: "unresolved-target",
      agentKey: "caller",
      message: "Caller invokes ambiguous agent legacy.",
    });
  });

  it("rejects an arbitrary provider that violates the public or private boundary", async () => {
    const duplicate = inventoryResult(scope, [
      { agentKey: "alpha", label: "Alpha" },
      { agentKey: "beta", label: "Beta" },
    ]);
    duplicate.inventory = {
      ...duplicate.inventory,
      agents: duplicate.inventory.agents.map((agent) => ({
        ...agent,
        agentKey: "alpha",
      })),
    };
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () => duplicate),
    };

    await expect(
      buildGraph(
        new StaticSystemGraphBuilder(
          inventory,
          invocationProvider(async () => EMPTY_INVOCATIONS),
        ),
        scope,
      ),
    ).rejects.toThrow();

    const outside = inventoryResult(scope, [
      {
        agentKey: "alpha",
        label: "Alpha",
        sourceRoot: path.join(FIXTURE, "growth"),
      },
    ]);
    outside.context[0]!.sourceRoot = "/outside/private-agent";
    await expect(
      buildGraph(
        new StaticSystemGraphBuilder(
          { listAgents: async () => outside },
          invocationProvider(async () => EMPTY_INVOCATIONS),
        ),
        scope,
      ),
    ).rejects.toThrow("inventory context was invalid");

    const mismatchedLocation = inventoryResult(scope, [
      {
        agentKey: "alpha",
        label: "Alpha",
        sourceRoot: path.join(FIXTURE, "alpha"),
      },
    ]);
    mismatchedLocation.context[0]!.sourceRoot = path.join(FIXTURE, "growth");
    mismatchedLocation.context[0]!.workflowPath = path.join(FIXTURE, "growth");
    await expect(
      buildGraph(
        new StaticSystemGraphBuilder(
          { listAgents: async () => mismatchedLocation },
          invocationProvider(async () => EMPTY_INVOCATIONS),
        ),
        scope,
      ),
    ).rejects.toThrow("inventory context was invalid");
  });

  it("degrades a scanner failure into a path-free warning", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(scope, [
          {
            agentKey: "research",
            definitionId: 1,
            definitionSlug: "research",
            label: "Research",
            resolutionAliases: ["research"],
          },
        ]),
      ),
    };
    const built = await new StaticSystemGraphBuilder(
      inventory,
      invocationProvider(async () => {
        throw new Error("boom at private source");
      }),
    ).build(scope);
    const graph = built.graph;

    expect(built.cacheable).toBe(false);
    expect(graph.warnings).toEqual([
      {
        code: "projection-failed",
        agentKey: "research",
        message: "Could not inspect Research.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain("/private/");
  });

  it("keeps path-shaped registry and extraction values out of the public graph", async () => {
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [
        {
          ...workflow(FIXTURE, "reporting", FIXTURE),
          definitionId: null,
        },
      ],
      inspectManifestName: vi.fn(async () => ({
        status: "found" as const,
        name: FIXTURE,
      })),
    });

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        inventory,
        invocationProvider(async () => EMPTY_INVOCATIONS),
      ),
      scope,
    );

    expect(graph.nodes).toEqual([
      {
        id: "agent:local:reporting",
        agentKey: "local:reporting",
        label: "reporting",
      },
    ]);
    expect(graph.warnings).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain(FIXTURE);
  });

  it("keeps marker-resolved edges when source identity inspection fails", async () => {
    const changed = vi.fn();
    const inventory = new HarnessRegistryInventoryProvider({
      listWorkflows: () => [
        workflow("Caller", "caller", "caller-marker"),
        workflow("Target", "target", "target-marker"),
      ],
      inspectManifestName: vi.fn(async () => ({
        status: "failed" as const,
        retryable: false,
      })),
      fingerprintSource: async (sourceRoot) => `fingerprint:${sourceRoot}`,
      onIdentityChange: changed,
    });
    const builder = new StaticSystemGraphBuilder(
      inventory,
      invocationProvider(async (sourceRoot) =>
        sourceRoot.endsWith("caller")
          ? {
              invocations: [
                {
                  target: "target-marker",
                  mode: "async",
                  evidence: EVIDENCE,
                },
              ],
              warnings: [],
            }
          : EMPTY_INVOCATIONS,
      ),
    );
    const initial = await builder.build(scope);
    initial.afterCommit?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

    const failed = await builder.build(scope);

    expect(failed.graph.nodes.map((node) => node.agentKey)).toEqual([
      "caller-marker",
      "target-marker",
    ]);
    expect(failed.graph.edges).toEqual([
      {
        from: "agent:caller-marker",
        to: "agent:target-marker",
        kind: "invokes",
        basis: "static-invocation",
        mode: "async",
      },
    ]);
    expect(failed.graph.warnings.map((warning) => warning.code)).toEqual([
      "inventory-extraction-failed",
      "inventory-extraction-failed",
    ]);
    expect(JSON.stringify(failed.graph)).not.toContain(FIXTURE);
  });

  it("sanitizes private labels and warning messages at an arbitrary provider boundary", async () => {
    const leakedPath = "/private/provider-secret";
    const result = inventoryResult(
      scope,
      [
        {
          agentKey: "local:reporting",
          label: `${leakedPath}\u0085`,
          sourceRoot: path.join(FIXTURE, "reporting"),
          provisional: true,
        },
      ],
      {
        degraded: true,
        warnings: [
          {
            code: "inventory-extraction-failed",
            agentKey: "local:reporting",
            message: `inspection failed at ${leakedPath}`,
          },
        ],
      },
    );

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => result },
        invocationProvider(async () => EMPTY_INVOCATIONS),
      ),
      scope,
    );

    expect(graph.nodes).toEqual([
      {
        id: "agent:local:reporting",
        agentKey: "local:reporting",
        label: "reporting",
      },
    ]);
    expect(graph.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:reporting",
        message:
          "Could not resolve reporting's source identity; using its provisional identity.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain(leakedPath);
    expect(JSON.stringify(graph)).not.toContain("\u0085");
  });

  it("preserves a scoped package display label without admitting path-shaped labels", async () => {
    const result = inventoryResult(scope, [
      {
        agentKey: "reporting",
        label: "@acme/proj-a",
        sourceRoot: path.join(FIXTURE, "reporting"),
      },
    ]);

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => result },
        invocationProvider(async () => EMPTY_INVOCATIONS),
      ),
      scope,
    );

    expect(graph.nodes).toEqual([
      {
        id: "agent:reporting",
        agentKey: "reporting",
        label: "@acme/proj-a",
      },
    ]);
  });

  it("rejects a provider warning whose identity is not inventory-owned", async () => {
    const result = inventoryResult(
      scope,
      [
        {
          agentKey: "local:reporting",
          label: "Reporting",
          sourceRoot: path.join(FIXTURE, "reporting"),
          provisional: true,
        },
      ],
      {
        degraded: true,
        warnings: [
          {
            code: "inventory-extraction-failed",
            agentKey: "/private/provider-secret",
            message: "private",
          },
        ],
      },
    );

    await expect(
      buildGraph(
        new StaticSystemGraphBuilder(
          { listAgents: async () => result },
          invocationProvider(async () => EMPTY_INVOCATIONS),
        ),
        scope,
      ),
    ).rejects.toThrow("inventory warning was invalid");
  });

  it("rejects extraction warnings unsupported by parsed identity evidence", async () => {
    const unsupported = [
      {
        agentKey: "canonical",
        result: inventoryResult(scope, [
          { agentKey: "canonical", label: "Canonical" },
        ]),
      },
      {
        agentKey: "local:pending",
        result: inventoryResult(
          scope,
          [
            {
              agentKey: "local:pending",
              label: "Pending",
              provisional: true,
              identityIssue: "identity-pending",
            },
          ],
          { degraded: true },
        ),
      },
      {
        agentKey: "local:duplicate",
        result: inventoryResult(
          scope,
          [
            {
              agentKey: "local:duplicate",
              label: "Duplicate",
              provisional: true,
              identityIssue: "duplicate-agent-key",
              candidateAgentKey: "shared",
            },
          ],
          { degraded: true },
        ),
      },
    ];

    for (const { agentKey, result } of unsupported) {
      result.warnings = [
        {
          code: "inventory-extraction-failed",
          agentKey,
          message: "private",
        },
      ];
      await expect(
        buildGraph(
          new StaticSystemGraphBuilder(
            { listAgents: async () => result },
            invocationProvider(async () => EMPTY_INVOCATIONS),
          ),
          scope,
        ),
      ).rejects.toThrow("inventory warning was invalid");
    }
  });

  it.each([
    ["path alias", ["private/agent"]],
    ["control alias", ["agent\u0085name"]],
    ["reserved local alias", ["local:agent"]],
  ])("rejects an arbitrary provider %s", async (_case, resolutionAliases) => {
    const result = inventoryResult(scope, [
      {
        agentKey: "reporting",
        label: "Reporting",
        sourceRoot: path.join(FIXTURE, "reporting"),
        resolutionAliases,
      },
    ]);

    await expect(
      buildGraph(
        new StaticSystemGraphBuilder(
          { listAgents: async () => result },
          invocationProvider(async () => EMPTY_INVOCATIONS),
        ),
        scope,
      ),
    ).rejects.toThrow("inventory context was invalid");
  });

  it("normalizes arbitrary provider aliases before invocation resolution", async () => {
    const result = inventoryResult(scope, [
      {
        agentKey: "reporting",
        label: "Reporting",
        sourceRoot: path.join(FIXTURE, "reporting"),
        resolutionAliases: ["zeta", "alpha", "zeta"],
      },
    ]);
    const listInvocations = vi.fn<AgentInvocationProvider["listInvocations"]>(
      async () => EMPTY_INVOCATIONS,
    );

    await buildGraph(
      new StaticSystemGraphBuilder(
        { listAgents: async () => result },
        { listInvocations },
      ),
      scope,
    );

    expect(listInvocations.mock.calls[0]?.[0].resolutionAliases).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("projects disconnected inventory nodes and merges inventory warnings", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(
          scope,
          [
            {
              agentKey: "research",
              definitionId: 1,
              definitionSlug: "research",
              label: "Research",
              resolutionAliases: ["research"],
            },
            {
              agentKey: "local:reporting",
              label: "Reporting",
              provisional: true,
            },
          ],
          {
            degraded: true,
            warnings: [
              {
                code: "inventory-extraction-failed",
                agentKey: "local:reporting",
                message:
                  "Could not inspect Reporting; using its local identity.",
              },
            ],
          },
        ),
      ),
    };

    const graph = await buildGraph(
      new StaticSystemGraphBuilder(
        inventory,
        invocationProvider(async () => EMPTY_INVOCATIONS),
      ),
      scope,
    );

    expect(graph.nodes.map((node) => node.agentKey)).toEqual([
      "local:reporting",
      "research",
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:reporting",
        message:
          "Could not resolve Reporting's source identity; using its provisional identity.",
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain("/private/");
  });

  it("keeps degraded cache policy outside the public graph contract", async () => {
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async () =>
        inventoryResult(
          scope,
          [
            {
              agentKey: "local:pending",
              label: "Pending",
              provisional: true,
              identityIssue: "identity-pending",
            },
          ],
          { degraded: true },
        ),
      ),
    };

    const built = await new StaticSystemGraphBuilder(
      inventory,
      invocationProvider(async () => EMPTY_INVOCATIONS),
    ).build(scope);

    expect(built.cacheable).toBe(false);
    expect(built.graph).toEqual({
      kind: "system",
      scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
      nodes: [
        {
          id: "agent:local:pending",
          agentKey: "local:pending",
          label: "Pending",
        },
      ],
      edges: [],
      warnings: [],
    });
    expect(built.graph).not.toHaveProperty("cacheable");
  });

  it("caches a settled provisional identity while preserving its warning", async () => {
    const result = inventoryResult(
      scope,
      [
        {
          agentKey: "local:dashboard",
          label: "Dashboard",
          provisional: true,
          identityIssue: "identity-unavailable",
        },
      ],
      {
        degraded: true,
        identitySettled: true,
        warnings: [
          {
            code: "inventory-extraction-failed",
            agentKey: "local:dashboard",
            message: "private provider wording",
          },
        ],
      },
    );

    const built = await new StaticSystemGraphBuilder(
      { listAgents: async () => result },
      relationshipProvider(async () => EMPTY_RELATIONSHIPS),
    ).build(scope);

    expect(built.cacheable).toBe(true);
    expect(built.graph.warnings).toEqual([
      {
        code: "inventory-extraction-failed",
        agentKey: "local:dashboard",
        message:
          "Could not resolve Dashboard's source identity; using its provisional identity.",
      },
    ]);
  });

  it("uses the normalized inventory status even if a provider mutates its result", async () => {
    let release!: () => void;
    const invocationsPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = inventoryResult(
      scope,
      [
        {
          agentKey: "local:pending",
          label: "Pending",
          sourceRoot: path.join(FIXTURE, "pending"),
          provisional: true,
          identityIssue: "identity-pending",
        },
      ],
      { degraded: true },
    );
    const listInvocations = vi.fn(async () => {
      await invocationsPending;
      return EMPTY_INVOCATIONS;
    });
    const building = new StaticSystemGraphBuilder(
      { listAgents: async () => result },
      { listInvocations },
    ).build(scope);
    await vi.waitFor(() => expect(listInvocations).toHaveBeenCalledTimes(1));

    (result.inventory as { status: "complete" | "degraded" }).status =
      "complete";
    release();
    const built = await building;

    expect(built.cacheable).toBe(false);
  });

  it("retains caller caches across active workspaces and prunes retired ones", async () => {
    const secondScope: WorkspaceScope = {
      workspaceKey: "workspace-second",
      root: "/private/second",
    };
    const retainSources = vi.fn<(sources: ReadonlySet<string>) => void>();
    const inventory: AgentInventoryProvider = {
      listAgents: vi.fn(async (activeScope) => {
        const second = activeScope.workspaceKey === secondScope.workspaceKey;
        const agentKey = second ? "second" : "first";
        return inventoryResult(activeScope, [
          {
            agentKey,
            definitionSlug: agentKey,
            label: agentKey,
            resolutionAliases: [agentKey],
            sourceRoot: path.join(activeScope.root, agentKey),
          },
        ]);
      }),
      retainSources,
    };
    const retainCallers = vi.fn();
    const invocations: AgentInvocationProvider = {
      listInvocations: vi.fn(async () => EMPTY_INVOCATIONS),
      retainCallers,
    };
    const builder = new StaticSystemGraphBuilder(inventory, invocations);

    await builder.build(scope);
    await builder.build(secondScope);
    expect(
      retainCallers.mock.calls
        .at(-1)?.[0]
        .map((caller: { agentKey: string }) => caller.agentKey),
    ).toEqual(["first", "second"]);

    builder.retainWorkspaces(new Set([secondScope.workspaceKey]));
    expect(
      retainCallers.mock.calls
        .at(-1)?.[0]
        .map((caller: { agentKey: string }) => caller.agentKey),
    ).toEqual(["second"]);
    expect([...(retainSources.mock.calls.at(-1)?.[0] ?? [])]).toEqual([
      "/private/second/second",
    ]);
  });
});
