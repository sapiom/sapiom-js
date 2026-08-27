import { createHash } from "node:crypto";
import * as path from "node:path";

import type {
  AgentKey,
  GraphWarning,
  SystemGraph,
  SystemGraphEdge,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "../shared/system-graph.js";
import { workspaceRelativeLocalKey } from "../shared/system-graph.js";
import {
  canonicalGraphPath,
  isWithinGraphPath,
  type AgentInventoryItem,
  type AgentInventoryProvider,
  type WorkspaceScope,
} from "./system-graph-inventory.js";
import {
  CachedAgentRelationshipProvider,
  SourceAgentRelationshipProvider,
  type AgentRelationshipProvider,
  type AgentRelationshipProviderResult,
} from "./system-graph-relationships.js";

export { HarnessRegistryInventoryProvider } from "./system-graph-inventory.js";
export type {
  AgentInventoryItem,
  AgentInventoryProvider,
  AgentInventoryResult,
  AgentInventoryWarning,
  WorkspaceScope,
} from "./system-graph-inventory.js";
export {
  CachedAgentRelationshipProvider,
  SourceAgentRelationshipProvider,
} from "./system-graph-relationships.js";
export type {
  AgentRelationshipCandidate,
  AgentRelationshipProvider,
  AgentRelationshipProviderResult,
  AgentRelationshipWarning,
} from "./system-graph-relationships.js";

export interface WorkspaceScopeResolver {
  resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null>;
}

export interface WorkspaceScopeCatalog extends WorkspaceScopeResolver {
  list(): Promise<WorkspaceScopeSummary[]>;
}

export interface SystemGraphBuilder {
  build(scope: WorkspaceScope): Promise<SystemGraphBuildResult>;
  /** Optional lifecycle hook for builders with workspace-scoped caches. */
  retainWorkspaces?(workspaceKeys: ReadonlySet<WorkspaceKey>): void;
}

export interface SystemGraphBuildResult {
  /** Internal cache policy; only graph crosses the HTTP boundary. */
  cacheable: boolean;
  graph: SystemGraph;
}

function workspaceKeyForRoot(root: string): WorkspaceKey {
  return `workspace-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/**
 * Resolves only roots the running Studio already knows about. A caller cannot
 * manufacture a key and turn the graph endpoint into an arbitrary path scan.
 */
export class LocalWorkspaceScopeCatalog implements WorkspaceScopeCatalog {
  constructor(
    private readonly listRoots: () =>
      | readonly string[]
      | Promise<readonly string[]>,
  ) {}

  async list(): Promise<WorkspaceScopeSummary[]> {
    const byRoot = new Map<string, WorkspaceScopeSummary>();
    for (const root of await this.listRoots()) {
      const canonical = canonicalGraphPath(root);
      byRoot.set(canonical, {
        workspaceKey: workspaceKeyForRoot(canonical),
        cwd: root,
      });
    }
    return [...byRoot.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, summary]) => summary);
  }

  async resolve(workspaceKey: WorkspaceKey): Promise<WorkspaceScope | null> {
    for (const root of await this.listRoots()) {
      const canonical = canonicalGraphPath(root);
      if (workspaceKeyForRoot(canonical) === workspaceKey) {
        return { workspaceKey, root: canonical };
      }
    }
    return null;
  }
}

function warningOrder(left: GraphWarning, right: GraphWarning): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.agentKey ?? "").localeCompare(right.agentKey ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function fallbackAgentKey(scope: WorkspaceScope, sourceRoot: string): AgentKey {
  const canonicalScope = canonicalGraphPath(scope.root);
  const canonicalSource = canonicalGraphPath(sourceRoot);
  if (isWithinGraphPath(canonicalScope, canonicalSource)) {
    const localKey = workspaceRelativeLocalKey(canonicalScope, canonicalSource);
    if (localKey) return localKey;
  }
  return `local:${createHash("sha256")
    .update(canonicalSource)
    .digest("hex")
    .slice(0, 16)}`;
}

function safeAgentKey(value: string): AgentKey | null {
  const key = value.trim();
  if (
    key === "" ||
    /[\0\r\n]/.test(key) ||
    path.posix.isAbsolute(key) ||
    path.win32.isAbsolute(key) ||
    key.includes("\\")
  ) {
    return null;
  }
  if (!key.startsWith("local:")) return key.includes("/") ? null : key;

  const relative = key.slice("local:".length);
  if (
    relative === "" ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  return key;
}

function safeLabel(value: string, agentKey: AgentKey): string {
  const label = value.trim();
  if (
    label !== "" &&
    !/[\0\r\n]/.test(label) &&
    !path.posix.isAbsolute(label) &&
    !path.win32.isAbsolute(label)
  ) {
    return label;
  }
  if (agentKey.startsWith("local:")) {
    return agentKey.slice("local:".length) || "Local agent";
  }
  return agentKey;
}

interface PreparedInventoryItem {
  agent: AgentInventoryItem;
  candidateKey: AgentKey;
  fallbackKey: AgentKey;
}

/**
 * The provider contract promises safe unique keys, but projection is the last
 * server-side boundary before serialization. Re-assert that invariant here so
 * a future provider cannot make the browser reject the whole graph payload.
 */
function normalizeInventory(
  scope: WorkspaceScope,
  inventory: readonly AgentInventoryItem[],
): { agents: AgentInventoryItem[]; warnings: GraphWarning[] } {
  const prepared: PreparedInventoryItem[] = inventory
    .map((agent) => {
      const fallbackKey = fallbackAgentKey(scope, agent.sourceRoot);
      return {
        agent,
        candidateKey: safeAgentKey(agent.agentKey) ?? fallbackKey,
        fallbackKey,
      };
    })
    .sort(
      (left, right) =>
        left.candidateKey.localeCompare(right.candidateKey) ||
        left.agent.sourceRoot.localeCompare(right.agent.sourceRoot) ||
        left.agent.label.localeCompare(right.agent.label),
    );
  const counts = new Map<AgentKey, number>();
  for (const item of prepared) {
    counts.set(item.candidateKey, (counts.get(item.candidateKey) ?? 0) + 1);
  }

  const used = new Set<AgentKey>();
  const duplicateKeys = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([candidateKey]) => candidateKey),
  );
  const agents = prepared.map(({ agent, candidateKey, fallbackKey }) => {
    const duplicate = (counts.get(candidateKey) ?? 0) > 1;
    let agentKey = duplicate ? fallbackKey : candidateKey;
    if (used.has(agentKey)) {
      duplicateKeys.add(agentKey);
      agentKey = fallbackKey;
    }
    const base = agentKey;
    let suffix = 2;
    while (used.has(agentKey)) {
      duplicateKeys.add(base);
      agentKey = `${base}~${suffix}`;
      suffix += 1;
    }
    used.add(agentKey);

    const resolutionAliases = [
      ...new Set(
        [
          ...(agentKey !== candidateKey ? [candidateKey] : []),
          ...agent.resolutionAliases,
        ]
          .map(safeAgentKey)
          .filter((alias): alias is AgentKey => alias !== null),
      ),
    ];
    return {
      ...agent,
      agentKey,
      label: safeLabel(agent.label, agentKey),
      resolutionAliases,
    };
  });
  agents.sort(
    (left, right) =>
      left.agentKey.localeCompare(right.agentKey) ||
      left.sourceRoot.localeCompare(right.sourceRoot),
  );

  const warnings: GraphWarning[] = [];
  for (const candidateKey of [...duplicateKeys].sort()) {
    warnings.push({
      code: "duplicate-agent-key",
      agentKey: candidateKey,
      message: `Multiple agents use ${candidateKey}; kept each with a local identity.`,
    });
  }
  return { agents, warnings };
}

export class StaticSystemGraphBuilder implements SystemGraphBuilder {
  private readonly callersByWorkspace = new Map<
    WorkspaceKey,
    readonly AgentInventoryItem[]
  >();

  constructor(
    private readonly inventory: AgentInventoryProvider,
    private readonly relationships: AgentRelationshipProvider = new CachedAgentRelationshipProvider(
      new SourceAgentRelationshipProvider(),
    ),
  ) {}

  async build(scope: WorkspaceScope): Promise<SystemGraphBuildResult> {
    const inventory = await this.inventory.listAgents(scope);
    const normalized = normalizeInventory(scope, inventory.agents);
    const agents = normalized.agents;
    this.callersByWorkspace.set(scope.workspaceKey, agents);
    this.retainRelationshipCallers();
    const nodes = agents.map((agent) => ({
      id: `agent:${agent.agentKey}`,
      agentKey: agent.agentKey,
      label: agent.label,
    }));
    const byTarget = new Map<string, AgentInventoryItem[]>();
    const registerTarget = (key: string, agent: AgentInventoryItem): void => {
      const candidates = byTarget.get(key) ?? [];
      if (
        !candidates.some((candidate) => candidate.agentKey === agent.agentKey)
      ) {
        candidates.push(agent);
        byTarget.set(key, candidates);
      }
    };
    for (const agent of agents) {
      registerTarget(agent.agentKey, agent);
      for (const alias of agent.resolutionAliases) {
        registerTarget(alias, agent);
      }
    }

    const edges: SystemGraphEdge[] = [];
    const warnings: GraphWarning[] = [
      ...inventory.warnings,
      ...normalized.warnings,
    ];
    const seenEdges = new Set<string>();
    let relationshipsComplete = true;

    // Source walks are independent. Run them together so first-open latency is
    // bounded by the slowest agent tree rather than the sum of every tree.
    const scans = await Promise.all(
      agents.map(async (caller) => {
        try {
          return {
            caller,
            result: await this.relationships.listRelationships(caller),
            failed: false as const,
          };
        } catch {
          return {
            caller,
            result: {
              relationships: [],
              warnings: [],
            } satisfies AgentRelationshipProviderResult,
            failed: true as const,
          };
        }
      }),
    );

    for (const { caller, result, failed } of scans) {
      if (failed) {
        relationshipsComplete = false;
        warnings.push({
          code: "projection-failed",
          agentKey: caller.agentKey,
          message: `Could not inspect ${caller.label}.`,
        });
        continue;
      }

      for (const warning of result.warnings) {
        if (warning.code === "dynamic-target") {
          warnings.push({
            code: "dynamic-target",
            agentKey: caller.agentKey,
            message: `${caller.label} has a dynamic agent target that V0 cannot resolve.`,
          });
        }
      }

      for (const relationship of result.relationships) {
        const candidates = byTarget.get(relationship.target) ?? [];
        if (candidates.length !== 1) {
          const target = /^[A-Za-z0-9@_.:-]+$/.test(relationship.target)
            ? relationship.target
            : null;
          warnings.push({
            code: "unresolved-target",
            agentKey: caller.agentKey,
            message:
              candidates.length === 0
                ? target
                  ? `${caller.label} invokes unknown agent ${target}.`
                  : `${caller.label} invokes an invalid agent target.`
                : `${caller.label} invokes ambiguous agent ${target ?? "target"}.`,
          });
          continue;
        }
        const target = candidates[0]!;
        if (target.agentKey === caller.agentKey) continue;
        const from = `agent:${caller.agentKey}`;
        const to = `agent:${target.agentKey}`;
        const edgeKey = `${from}\0${to}\0${relationship.mode}`;
        if (relationship.evidence.length > 1 || seenEdges.has(edgeKey)) {
          warnings.push({
            code: "duplicate-edge",
            agentKey: caller.agentKey,
            message: `${caller.label} invokes ${target.label} more than once.`,
          });
        }
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);
        edges.push({
          from,
          to,
          kind: "invokes",
          basis: "static",
          mode: relationship.mode,
        });
      }
    }

    const modeOrder = { blocking: 0, async: 1 } as const;
    edges.sort(
      (left, right) =>
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        modeOrder[left.mode] - modeOrder[right.mode],
    );
    const uniqueWarnings = [
      ...new Map(
        warnings.map((warning) => [
          `${warning.code}\0${warning.agentKey ?? ""}\0${warning.message}`,
          warning,
        ]),
      ).values(),
    ].sort(warningOrder);

    return {
      cacheable: inventory.cacheable && relationshipsComplete,
      graph: {
        kind: "system",
        scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
        nodes,
        edges,
        warnings: uniqueWarnings,
      },
    };
  }

  retainWorkspaces(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    for (const workspaceKey of this.callersByWorkspace.keys()) {
      if (!workspaceKeys.has(workspaceKey)) {
        this.callersByWorkspace.delete(workspaceKey);
      }
    }
    this.retainRelationshipCallers();
  }

  private retainRelationshipCallers(): void {
    try {
      this.relationships.retainCallers?.(
        [...this.callersByWorkspace.values()].flat(),
      );
    } catch {
      // Cache pruning is an optimization and cannot make projection fail.
    }
  }
}
