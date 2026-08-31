import { createHash } from "node:crypto";

import {
  packageInventorySchema,
  type PackageGraphStaticEvidenceState,
  type PackageInventory,
} from "@sapiom/agent";

import type {
  GraphWarning,
  SystemGraph,
  SystemGraphNavigationTarget,
  WorkspaceKey,
  WorkspaceScopeSummary,
} from "../shared/system-graph.js";
import {
  canonicalGraphPath,
  inventorySourceRoot,
  isWithinGraphPath,
  type AgentInventoryItem,
  type AgentInventoryProvider,
  type AgentInventoryWarning,
  type WorkspaceScope,
} from "./system-graph-inventory.js";
import {
  adaptDirectInvocationsToGraphEvidence,
  type DirectInvocationScan,
} from "./system-graph-invocation-evidence.js";
import {
  CachedAgentInvocationProvider,
  SourceAgentInvocationProvider,
  type AgentInvocationProvider,
  type AgentInvocationProviderResult,
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
  CachedAgentInvocationProvider,
  SourceAgentInvocationProvider,
} from "./system-graph-relationships.js";
export type {
  AgentInvocationCandidate,
  AgentInvocationProvider,
  AgentInvocationProviderResult,
  AgentInvocationWarning,
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
  /** Private resolver data committed atomically with the graph revision. */
  navigation?: SystemGraphNavigationTarget[];
  /** Starts non-blocking enrichment only after this result is visible. */
  afterCommit?: () => void;
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

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function fallbackLabel(agentKey: string): string {
  if (!agentKey.startsWith("local:")) return agentKey;
  return agentKey.slice("local:".length).split("/").at(-1) ?? "Agent";
}

function isScopedPackageLabel(value: string): boolean {
  return /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/.test(value);
}

function safeContextLabel(label: unknown, agentKey: string): string {
  if (typeof label !== "string") return fallbackLabel(agentKey);
  const trimmed = label.trim();
  return trimmed === "" ||
    hasControlCharacter(trimmed) ||
    trimmed.includes("\\") ||
    (trimmed.includes("/") && !isScopedPackageLabel(trimmed))
    ? fallbackLabel(agentKey)
    : trimmed;
}

function normalizeResolutionAliases(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("System graph inventory context was invalid");
  }
  const aliases = value.map((alias) => {
    if (
      typeof alias !== "string" ||
      alias === "" ||
      alias !== alias.trim() ||
      alias === "." ||
      alias === ".." ||
      alias.startsWith("local:") ||
      hasControlCharacter(alias) ||
      alias.includes("/") ||
      alias.includes("\\")
    ) {
      throw new Error("System graph inventory context was invalid");
    }
    return alias;
  });
  return [...new Set(aliases)].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

function sanitizeInventoryWarnings(
  warnings: readonly AgentInventoryWarning[],
  publicAgents: ReturnType<typeof packageInventorySchema.parse>["agents"],
  agents: readonly AgentInventoryItem[],
): GraphWarning[] {
  const agentsByKey = new Map(agents.map((agent) => [agent.agentKey, agent]));
  const publicAgentsByKey = new Map(
    publicAgents.map((agent) => [agent.agentKey, agent]),
  );
  const duplicateCandidates = new Set<string>();
  for (const agent of publicAgents) {
    if (
      agent.identityStatus === "provisional" &&
      agent.identityIssue === "duplicate-agent-key"
    ) {
      duplicateCandidates.add(agent.candidateAgentKey);
    }
  }

  const sanitized: GraphWarning[] = [...duplicateCandidates].map(
    (candidateAgentKey) => ({
      code: "duplicate-agent-key",
      agentKey: candidateAgentKey,
      message: `Multiple agents use ${candidateAgentKey}; kept each with a local identity.`,
    }),
  );
  const seenExtractionFailures = new Set<string>();
  for (const warning of warnings) {
    if (
      !warning ||
      typeof warning !== "object" ||
      typeof warning.agentKey !== "string" ||
      typeof warning.message !== "string"
    ) {
      throw new Error("System graph inventory warning was invalid");
    }
    if (warning.code === "duplicate-agent-key") {
      if (!duplicateCandidates.has(warning.agentKey)) {
        throw new Error("System graph inventory warning was invalid");
      }
      continue;
    }
    if (warning.code === "inventory-extraction-failed") {
      const agent = agentsByKey.get(warning.agentKey);
      const publicAgent = publicAgentsByKey.get(warning.agentKey);
      if (
        !agent ||
        !publicAgent ||
        publicAgent.identityStatus !== "provisional" ||
        (publicAgent.identityIssue !== "identity-unavailable" &&
          publicAgent.identityIssue !== "identity-invalid")
      ) {
        throw new Error("System graph inventory warning was invalid");
      }
      if (seenExtractionFailures.has(warning.agentKey)) continue;
      seenExtractionFailures.add(warning.agentKey);
      sanitized.push({
        code: warning.code,
        agentKey: warning.agentKey,
        message: `Could not resolve ${agent.label}'s source identity; using its provisional identity.`,
      });
      continue;
    }
    throw new Error("System graph inventory warning was invalid");
  }
  return sanitized.sort(warningOrder);
}

interface ConsumedInventory {
  inventory: PackageInventory;
  agents: AgentInventoryItem[];
  warnings: GraphWarning[];
  /** Every identity has finished resolving, however it resolved. */
  identitySettled: boolean;
  /** The accepted workspace walk considered every eligible discovery path. */
  discoveryComplete: boolean;
  startEnrichment?: () => void;
}

/**
 * Re-parse the public contract and join private context at the last boundary
 * before graph projection. A future adapter cannot bypass inventory safety or
 * smuggle an outside navigation target into the resolver.
 */
function consumeInventory(
  scope: WorkspaceScope,
  result: Awaited<ReturnType<AgentInventoryProvider["listAgents"]>>,
): ConsumedInventory {
  const inventory = packageInventorySchema.parse(result.inventory);
  if (
    inventory.version.kind !== "working-tree" ||
    inventory.version.workspaceKey !== scope.workspaceKey
  ) {
    throw new Error("System graph received an inventory for another scope");
  }
  const canonicalScope = canonicalGraphPath(scope.root);
  const context = new Map(
    result.context.map((item) => [`${item.path}\0${item.entrypoint}`, item]),
  );
  if (
    context.size !== result.context.length ||
    result.context.length !== inventory.agents.length
  ) {
    throw new Error(
      "System graph inventory context did not match public locations",
    );
  }
  const agents = inventory.agents.map((agent) => {
    const key = `${agent.path}\0${agent.entrypoint}`;
    const item = context.get(key);
    const sourceRoot = item ? canonicalGraphPath(item.sourceRoot) : "";
    const workflowPath = item ? canonicalGraphPath(item.workflowPath) : "";
    const expectedSourceRoot = inventorySourceRoot(scope.root, agent.path);
    if (
      !item ||
      item.agentKey !== agent.agentKey ||
      !isWithinGraphPath(canonicalScope, sourceRoot) ||
      !isWithinGraphPath(expectedSourceRoot, sourceRoot) ||
      !isWithinGraphPath(sourceRoot, expectedSourceRoot) ||
      !isWithinGraphPath(sourceRoot, workflowPath) ||
      !isWithinGraphPath(workflowPath, sourceRoot)
    ) {
      throw new Error("System graph inventory context was invalid");
    }
    return {
      ...item,
      identityStatus: agent.identityStatus,
      label: safeContextLabel(item.label, item.agentKey),
      resolutionAliases: normalizeResolutionAliases(item.resolutionAliases),
    };
  });
  return {
    inventory,
    agents,
    warnings: sanitizeInventoryWarnings(
      result.warnings,
      inventory.agents,
      agents,
    ),
    identitySettled:
      result.identitySettled &&
      !inventory.agents.some(
        (agent) =>
          agent.identityStatus === "provisional" &&
          agent.identityIssue === "identity-pending",
      ),
    discoveryComplete: result.discoveryComplete === true,
    ...(typeof result.startEnrichment === "function"
      ? { startEnrichment: result.startEnrichment }
      : {}),
  };
}

export class StaticSystemGraphBuilder implements SystemGraphBuilder {
  private readonly callersByWorkspace = new Map<
    WorkspaceKey,
    readonly AgentInventoryItem[]
  >();
  private readonly evidenceByWorkspace = new Map<
    WorkspaceKey,
    PackageGraphStaticEvidenceState
  >();

  constructor(
    private readonly inventory: AgentInventoryProvider,
    private readonly invocations: AgentInvocationProvider = new CachedAgentInvocationProvider(
      new SourceAgentInvocationProvider(),
    ),
  ) {}

  async build(scope: WorkspaceScope): Promise<SystemGraphBuildResult> {
    const inventory = await this.inventory.listAgents(scope);
    const consumed = consumeInventory(scope, inventory);
    const agents = consumed.agents;
    this.callersByWorkspace.set(scope.workspaceKey, agents);
    this.retainInvocationCallers();
    const nodes = agents.map((agent) => ({
      id: `agent:${agent.agentKey}`,
      agentKey: agent.agentKey,
      label: agent.label,
    }));
    const supportsBackgroundInvocations =
      typeof this.invocations.peekInvocations === "function" &&
      typeof this.invocations.startInvocations === "function";
    // Production is deliberately two-phase: project cache-only inventory now,
    // then perform bounded invocation I/O after nodes/navigation are visible.
    // Legacy/test providers without the cache surface retain the old awaited
    // adapter behavior.
    const scans: DirectInvocationScan[] = supportsBackgroundInvocations
      ? agents.map((caller) => {
          const snapshot = this.invocations.peekInvocations!(caller);
          return {
            caller,
            result:
              snapshot?.result ??
              ({
                invocations: [],
                warnings: [],
              } satisfies AgentInvocationProviderResult),
            failed: snapshot?.status === "failed",
            pending: snapshot === undefined,
          };
        })
      : await Promise.all(
          agents.map(async (caller) => {
            try {
              return {
                caller,
                result: await this.invocations.listInvocations(caller),
                failed: false,
                pending: false,
              };
            } catch {
              return {
                caller,
                result: {
                  invocations: [],
                  warnings: [],
                } satisfies AgentInvocationProviderResult,
                failed: true,
                pending: false,
              };
            }
          }),
        );

    const adapted = adaptDirectInvocationsToGraphEvidence({
      inventory: consumed.inventory,
      agents,
      scans,
      previousState: this.evidenceByWorkspace.get(scope.workspaceKey),
    });
    const pendingOnlyPlaceholder =
      scans.length > 0 &&
      scans.every((scan) => scan.pending) &&
      adapted.state.status === "partial";
    // The cache-only cold phase is not a producer result. Do not let its empty
    // placeholder occupy the last-good slot before a real scan can seed it.
    if (pendingOnlyPlaceholder) {
      this.evidenceByWorkspace.delete(scope.workspaceKey);
    } else {
      this.evidenceByWorkspace.set(scope.workspaceKey, adapted.state);
    }
    const edges = adapted.edges;
    const warnings: GraphWarning[] = [
      ...consumed.warnings,
      ...adapted.warnings,
    ];
    const uniqueWarnings = [
      ...new Map(
        warnings.map((warning) => [
          `${warning.code}\0${warning.agentKey ?? ""}\0${warning.message}`,
          warning,
        ]),
      ).values(),
    ].sort(warningOrder);

    const afterCommit =
      consumed.startEnrichment || supportsBackgroundInvocations
        ? () => {
            consumed.startEnrichment?.();
            if (supportsBackgroundInvocations) {
              this.invocations.startInvocations!(agents);
            }
          }
        : undefined;
    return {
      cacheable:
        consumed.identitySettled &&
        consumed.discoveryComplete &&
        adapted.cacheable,
      graph: {
        kind: "system",
        scope: { kind: "working-tree", workspaceKey: scope.workspaceKey },
        nodes,
        edges,
        warnings: uniqueWarnings,
      },
      navigation: agents.map(({ agentKey, workflowPath }) => ({
        agentKey,
        workflowPath,
      })),
      ...(afterCommit ? { afterCommit } : {}),
    };
  }

  retainWorkspaces(workspaceKeys: ReadonlySet<WorkspaceKey>): void {
    for (const workspaceKey of this.callersByWorkspace.keys()) {
      if (!workspaceKeys.has(workspaceKey)) {
        this.callersByWorkspace.delete(workspaceKey);
        this.evidenceByWorkspace.delete(workspaceKey);
      }
    }
    try {
      this.inventory.retainSources?.(
        new Set(
          [...this.callersByWorkspace.values()]
            .flat()
            .map((caller) => caller.sourceRoot),
        ),
      );
    } catch {
      // Private cache pruning cannot make graph projection fail.
    }
    this.retainInvocationCallers();
  }

  private retainInvocationCallers(): void {
    const callers = [...this.callersByWorkspace.values()].flat();
    try {
      this.invocations.retainCallers?.(callers);
    } catch {
      // Cache pruning is an optimization and cannot make projection fail.
    }
  }
}
