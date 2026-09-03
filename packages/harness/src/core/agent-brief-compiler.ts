import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  PlanNode,
  PlanNodeId,
  PlanRelationship,
} from "../shared/agent-map.js";
import type {
  AgentBriefId,
  AgentBriefVersionRecord,
  BriefContractPort,
  BriefDependency,
  BriefDependencyId,
  BuildPlanDiagnostic,
  CompileAgentBriefsRequest,
  CompileAgentBriefsResult,
  CompiledBriefCandidate,
  DependencyFingerprint,
  DependencyFingerprintKind,
  PlanContractId,
  PlanningAssignmentId,
  PlanningAssignmentRef,
  PersistedAgentBriefVersionRecord,
  ProjectBuildPlanVersion,
  RecordDigest,
} from "../shared/build-plan.js";
import {
  AGENT_BRIEF_DIGEST_VERSION,
  AGENT_BRIEF_SCHEMA_VERSION,
  architectureSourceRefsEqual,
  BUILD_PLAN_VERSION_HISTORY_LIMIT,
} from "../shared/build-plan.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeArchitectureGraphDigest,
  buildPlanSemanticProjection,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
  computeCanonicalDigest,
} from "./build-plan-canonicalization.js";
import {
  BuilderBootstrapLimitError,
  createBuilderBootstrapContext,
  createPersistedBuilderBootstrapContext,
  BUILDER_BOOTSTRAP_COMPILER_VERSION,
  selectRelevantMilestones,
} from "./builder-bootstrap-context.js";
import { evaluatePersistedBuildPlanImpact } from "./build-plan-impact-evaluator.js";
import type {
  AgentBriefCompiler,
  AgentBriefCompileResult,
} from "./build-plan-service.js";

export const AGENT_BRIEF_COMPILER_VERSION = BUILDER_BOOTSTRAP_COMPILER_VERSION;
export const AGENT_BRIEF_COMPILER_DIAGNOSTIC_LIMIT = 64;

const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as RecordDigest;
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const unique = <T extends string>(values: readonly T[]): T[] =>
  [...new Set(values)].sort(compare);
const by = <T>(values: readonly T[], id: (value: T) => string): T[] =>
  [...values].sort((left, right) => compare(id(left), id(right)));
const generatedId = (prefix: string, seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const planRef = (plan: ProjectBuildPlanVersion) => ({
  planId: plan.planId,
  version: plan.version,
  semanticDigest: plan.semanticDigest,
});
const briefRef = (brief: PersistedAgentBriefVersionRecord) => ({
  briefId: brief.briefId,
  version: brief.version,
  semanticDigest: brief.semanticDigest,
});

function diagnostic(
  code: BuildPlanDiagnostic["code"],
  path: string,
  relatedIds: readonly string[] = [],
  severity: BuildPlanDiagnostic["severity"] = "error",
): BuildPlanDiagnostic {
  const messages: Record<BuildPlanDiagnostic["code"], string> = {
    "missing-agent-assignment":
      "A top-level agent requires exactly one assignment",
    "unknown-node-reference": "A referenced architecture node does not exist",
    "cross-project-reference":
      "The plan and compile request projects do not match",
    "missing-brief": "A current assignment requires a focused brief",
    "incompatible-contract-direction":
      "A contract direction conflicts with typed graph fields",
    "ambiguous-contract-direction":
      "Typed graph fields do not establish a contract direction",
    "ownership-cycle": "Architecture ownership contains a cycle",
    "multiple-top-level-owners":
      "A stable node resolves to multiple top-level owners",
    "dangling-ownership":
      "Architecture ownership does not resolve to a top-level agent",
    "authored-architecture-conflict":
      "Authored intent conflicts with architecture-owned facts",
    "brief-mission-missing":
      "The assignment requires a bounded agent-specific mission",
    "brief-scope-missing": "The assignment requires explicit in-scope work",
    "brief-non-goals-suspicious": "The assignment has no explicit non-goals",
    "brief-deliverable-missing":
      "The assignment requires a concrete deliverable",
    "brief-acceptance-criterion-missing":
      "The assignment requires acceptance evidence",
    "brief-change-protocol-missing":
      "The compiled brief requires the architecture change protocol",
    "bootstrap-limit-exceeded":
      "Builder bootstrap content exceeds a safe bound",
    "invalid-dependency":
      "A dependency is not supported by the typed architecture",
    "unresolved-required-decision": "A required decision remains unresolved",
    "source-not-found": "The exact architecture source was not found",
    "source-digest-mismatch":
      "The source, plan, or graph digest does not match",
  };
  return {
    code,
    severity,
    path: path.slice(0, 512),
    message: messages[code],
    relatedIds: unique(relatedIds).slice(0, 16),
  };
}

function finalizeDiagnostics(values: readonly BuildPlanDiagnostic[]) {
  const deduplicated = new Map<string, BuildPlanDiagnostic>();
  values.forEach((entry) =>
    deduplicated.set(
      JSON.stringify([entry.path, entry.code, entry.relatedIds]),
      entry,
    ),
  );
  return [...deduplicated.values()]
    .sort(
      (left, right) =>
        compare(left.relatedIds[0] ?? "", right.relatedIds[0] ?? "") ||
        compare(left.path, right.path) ||
        compare(left.code, right.code) ||
        compare(left.relatedIds.join("\0"), right.relatedIds.join("\0")),
    )
    .slice(0, AGENT_BRIEF_COMPILER_DIAGNOSTIC_LIMIT);
}

type GraphIndex = Readonly<{
  nodes: ReadonlyMap<PlanNodeId, PlanNode>;
  relationships: readonly PlanRelationship[];
  rootByNodeId: ReadonlyMap<PlanNodeId, PlanNodeId>;
  ownedByRoot: ReadonlyMap<PlanNodeId, readonly PlanNodeId[]>;
  topLevelAgents: readonly PlanNode[];
}>;

function indexGraph(
  graph: AgentMapGraph,
  diagnostics: BuildPlanDiagnostic[],
): GraphIndex {
  const nodes = new Map<PlanNodeId, PlanNode>();
  for (const [index, node] of graph.nodes.entries()) {
    const existing = nodes.get(node.id);
    if (existing) {
      diagnostics.push(
        diagnostic(
          existing.ownerAgentId !== node.ownerAgentId
            ? "multiple-top-level-owners"
            : "invalid-dependency",
          `graph.nodes[${index}].id`,
          [node.id],
        ),
      );
      continue;
    }
    nodes.set(node.id, node);
  }
  const rootByNodeId = new Map<PlanNodeId, PlanNodeId>();
  const resolveRoot = (start: PlanNode): PlanNodeId | null => {
    const visited: PlanNodeId[] = [];
    let current: PlanNode | undefined = start;
    while (current) {
      if (visited.includes(current.id)) {
        diagnostics.push(
          diagnostic("ownership-cycle", "graph.nodes.ownerAgentId", [
            ...visited,
            current.id,
          ]),
        );
        return null;
      }
      visited.push(current.id);
      if (current.ownerAgentId === null) {
        if (current.kind === "agent") return current.id;
        return null;
      }
      const owner = nodes.get(current.ownerAgentId);
      if (!owner) {
        diagnostics.push(
          diagnostic("dangling-ownership", "graph.nodes.ownerAgentId", [
            start.id,
            current.ownerAgentId,
          ]),
        );
        return null;
      }
      current = owner;
    }
    return null;
  };
  for (const node of by([...nodes.values()], (entry) => entry.id)) {
    const root = resolveRoot(node);
    if (root) rootByNodeId.set(node.id, root);
    else if (node.kind === "subagent")
      diagnostics.push(
        diagnostic("dangling-ownership", "graph.nodes.ownerAgentId", [node.id]),
      );
  }
  const ownedByRoot = new Map<PlanNodeId, PlanNodeId[]>();
  for (const [nodeId, root] of rootByNodeId)
    ownedByRoot.set(root, [...(ownedByRoot.get(root) ?? []), nodeId]);
  ownedByRoot.forEach((ids) => ids.sort(compare));
  const relationships = by(graph.relationships, (entry) => entry.id);
  const relationshipIds = new Set<string>();
  relationships.forEach((relationship, index) => {
    if (relationshipIds.has(relationship.id))
      diagnostics.push(
        diagnostic("invalid-dependency", `graph.relationships[${index}].id`, [
          relationship.id,
        ]),
      );
    relationshipIds.add(relationship.id);
    if (
      !nodes.has(relationship.fromNodeId) ||
      !nodes.has(relationship.toNodeId)
    )
      diagnostics.push(
        diagnostic("unknown-node-reference", `graph.relationships[${index}]`, [
          relationship.id,
          relationship.fromNodeId,
          relationship.toNodeId,
        ]),
      );
  });
  return {
    nodes,
    relationships,
    rootByNodeId,
    ownedByRoot,
    topLevelAgents: by(
      [...nodes.values()].filter(
        (node) => node.kind === "agent" && node.ownerAgentId === null,
      ),
      (entry) => entry.id,
    ),
  };
}

type Flow = Readonly<{
  relationship: PlanRelationship;
  fromNodeId: PlanNodeId;
  toNodeId: PlanNodeId;
  fromRoot: PlanNodeId | null;
  toRoot: PlanNodeId | null;
}>;

function effectiveFlow(
  relationship: PlanRelationship,
  index: GraphIndex,
): Flow | null {
  if (relationship.kind === "uses") return null;
  const fromNodeId =
    relationship.kind === "reads"
      ? relationship.toNodeId
      : relationship.fromNodeId;
  const toNodeId =
    relationship.kind === "reads"
      ? relationship.fromNodeId
      : relationship.toNodeId;
  return {
    relationship,
    fromNodeId,
    toNodeId,
    fromRoot: index.rootByNodeId.get(fromNodeId) ?? null,
    toRoot: index.rootByNodeId.get(toNodeId) ?? null,
  };
}

function actorRoot(nodeId: PlanNodeId, index: GraphIndex): PlanNodeId | null {
  const node = index.nodes.get(nodeId);
  return node?.kind === "agent" || node?.kind === "subagent"
    ? (index.rootByNodeId.get(nodeId) ?? null)
    : null;
}

function connectedFlowEvidence(
  flows: readonly Flow[],
  providerAgentId: PlanNodeId,
  consumerAgentId: PlanNodeId,
  index: GraphIndex,
): Flow[] | null {
  const eligible = flows;
  const starts = new Set(
    eligible
      .flatMap((flow) => [flow.fromNodeId, flow.toNodeId])
      .filter((nodeId) => actorRoot(nodeId, index) === providerAgentId),
  );
  const targets = new Set(
    eligible
      .flatMap((flow) => [flow.fromNodeId, flow.toNodeId])
      .filter((nodeId) => actorRoot(nodeId, index) === consumerAgentId),
  );
  if (starts.size === 0 || targets.size === 0) return null;
  const reachable = (
    initial: ReadonlySet<PlanNodeId>,
    reverse: boolean,
  ): Set<PlanNodeId> => {
    const reached = new Set(initial);
    const queue = [...initial];
    for (let offset = 0; offset < queue.length; offset += 1) {
      const current = queue[offset]!;
      for (const flow of eligible) {
        const from = reverse ? flow.toNodeId : flow.fromNodeId;
        const to = reverse ? flow.fromNodeId : flow.toNodeId;
        if (from !== current || reached.has(to)) continue;
        reached.add(to);
        queue.push(to);
      }
    }
    return reached;
  };
  const forward = reachable(starts, false);
  if (![...targets].some((target) => forward.has(target))) return null;
  const backward = reachable(targets, true);
  return eligible.filter(
    (flow) => forward.has(flow.fromNodeId) && backward.has(flow.toNodeId),
  );
}

const port = (
  contractId: PlanContractId,
  nodeId: PlanNodeId,
  relationships: readonly PlanRelationship[],
): BriefContractPort => ({
  contractId,
  nodeId,
  relationshipIds: unique(relationships.map((entry) => entry.id)),
  executionModes: unique(
    relationships.flatMap((entry) =>
      entry.executionMode ? [entry.executionMode] : [],
    ),
  ),
  description: relationships
    .map((entry) => entry.description)
    .sort(compare)[0]!,
});

function boundaryForAgent(
  agentId: PlanNodeId,
  plan: ProjectBuildPlanVersion,
  index: GraphIndex,
  diagnostics: BuildPlanDiagnostic[],
) {
  const inputs: BriefContractPort[] = [];
  const outputs: BriefContractPort[] = [];
  const dependencies: BriefDependency[] = [];
  const relevant = new Set<PlanNodeId>();
  const contractGroups = new Map<string, Flow[]>();

  for (const relationship of index.relationships) {
    const fromRoot = index.rootByNodeId.get(relationship.fromNodeId) ?? null;
    const toRoot = index.rootByNodeId.get(relationship.toNodeId) ?? null;
    if (fromRoot === agentId || toRoot === agentId) {
      const otherId =
        fromRoot === agentId ? relationship.toNodeId : relationship.fromNodeId;
      const other = index.nodes.get(otherId);
      if (
        other &&
        (other.kind === "resource" ||
          other.kind === "connector" ||
          other.kind === "artifact")
      )
        relevant.add(other.id);
    }
    if (relationship.contractRef) {
      const flow = effectiveFlow(relationship, index);
      if (!flow) {
        diagnostics.push(
          diagnostic(
            "ambiguous-contract-direction",
            "graph.relationships.contractRef",
            [agentId, relationship.id, relationship.contractRef],
          ),
        );
      } else {
        contractGroups.set(relationship.contractRef, [
          ...(contractGroups.get(relationship.contractRef) ?? []),
          flow,
        ]);
      }
    }
  }

  for (const [contractIdValue, flows] of by(
    [...contractGroups.entries()],
    ([id]) => id,
  )) {
    const contractId = contractIdValue as PlanContractId;
    const producing = flows.filter((flow) => flow.fromRoot === agentId);
    const consuming = flows.filter((flow) => flow.toRoot === agentId);
    producing.forEach((flow) => {
      if (
        !outputs.some(
          (entry) =>
            entry.contractId === contractId && entry.nodeId === flow.fromNodeId,
        )
      )
        outputs.push(
          port(
            contractId,
            flow.fromNodeId,
            producing
              .filter((entry) => entry.fromNodeId === flow.fromNodeId)
              .map((entry) => entry.relationship),
          ),
        );
      if (!flow.toRoot) relevant.add(flow.toNodeId);
    });
    consuming.forEach((flow) => {
      if (
        !inputs.some(
          (entry) =>
            entry.contractId === contractId && entry.nodeId === flow.toNodeId,
        )
      )
        inputs.push(
          port(
            contractId,
            flow.toNodeId,
            consuming
              .filter((entry) => entry.toNodeId === flow.toNodeId)
              .map((entry) => entry.relationship),
          ),
        );
      if (!flow.fromRoot) relevant.add(flow.fromNodeId);
    });
    const rawProviderRoots = unique(
      flows.flatMap((flow) => (flow.fromRoot ? [flow.fromRoot] : [])),
    );
    const rawConsumerRoots = unique(
      flows.flatMap((flow) => (flow.toRoot ? [flow.toRoot] : [])),
    );
    const providerRoots = unique(
      flows.flatMap((flow) => {
        const root = actorRoot(flow.fromNodeId, index);
        return root ? [root] : [];
      }),
    );
    const consumerRoots = unique(
      flows.flatMap((flow) => {
        const root = actorRoot(flow.toNodeId, index);
        return root ? [root] : [];
      }),
    );
    const terminalProviders = rawProviderRoots.filter(
      (root) => !rawConsumerRoots.includes(root),
    );
    const terminalConsumers = rawConsumerRoots.filter(
      (root) => !rawProviderRoots.includes(root),
    );
    for (const provider of terminalProviders) {
      for (const consumer of terminalConsumers) {
        if (
          provider === consumer ||
          (provider !== agentId && consumer !== agentId) ||
          (providerRoots.includes(provider) && consumerRoots.includes(consumer))
        )
          continue;
        diagnostics.push(
          diagnostic(
            "incompatible-contract-direction",
            "graph.relationships.contractRef",
            [
              contractId,
              provider,
              consumer,
              ...flows.map((flow) => flow.relationship.id),
            ],
          ),
        );
      }
    }
    for (const provider of providerRoots) {
      for (const consumer of consumerRoots) {
        if (
          provider === consumer ||
          (provider !== agentId && consumer !== agentId)
        )
          continue;
        const evidence = connectedFlowEvidence(
          flows,
          provider,
          consumer,
          index,
        );
        if (!evidence) {
          diagnostics.push(
            diagnostic(
              "incompatible-contract-direction",
              "graph.relationships.contractRef",
              [
                contractId,
                provider,
                consumer,
                ...flows.map((flow) => flow.relationship.id),
              ],
            ),
          );
          continue;
        }
        const providing = provider === agentId;
        const counterpartAgentId = providing ? consumer : provider;
        dependencies.push({
          dependencyId: generatedId(
            "dependency",
            `${agentId}\0${providing ? "provides" : "consumes"}\0${counterpartAgentId}\0${contractId}`,
          ) as BriefDependencyId,
          kind: providing ? "provides-input" : "consumes-output",
          direction: providing ? "downstream" : "upstream",
          counterpartAgentId,
          relationshipIds: unique(
            evidence.map((entry) => entry.relationship.id),
          ),
          contractIds: [contractId],
          requiredByMilestoneIds: unique(
            plan.assignments.find((entry) => entry.plannedAgentId === agentId)
              ?.milestoneIds ?? [],
          ),
          blocking: true,
          description: `Typed contract ${contractId} crosses the agent boundary`,
        });
      }
    }
  }

  const carrierNodes = [...index.nodes.values()].filter(
    (node) => node.kind === "resource" || node.kind === "connector",
  );
  for (const carrier of by(carrierNodes, (entry) => entry.id)) {
    const evidence = index.relationships.filter(
      (entry) =>
        entry.fromNodeId === carrier.id || entry.toNodeId === carrier.id,
    );
    const roots = unique(
      evidence.flatMap((entry) => [
        ...(index.rootByNodeId.get(entry.fromNodeId)
          ? [index.rootByNodeId.get(entry.fromNodeId)!]
          : []),
        ...(index.rootByNodeId.get(entry.toNodeId)
          ? [index.rootByNodeId.get(entry.toNodeId)!]
          : []),
      ]),
    );
    if (!roots.includes(agentId) || roots.length < 2) continue;
    relevant.add(carrier.id);
    for (const counterpartAgentId of roots.filter((id) => id !== agentId))
      dependencies.push({
        dependencyId: generatedId(
          "dependency",
          `${agentId}\0shared\0${counterpartAgentId}\0${carrier.id}`,
        ) as BriefDependencyId,
        kind: "shared-resource",
        direction: "bidirectional",
        counterpartAgentId,
        relationshipIds: unique(evidence.map((entry) => entry.id)),
        contractIds: unique(
          evidence.flatMap((entry) =>
            entry.contractRef ? [entry.contractRef as PlanContractId] : [],
          ),
        ),
        requiredByMilestoneIds: [],
        blocking: false,
        description: `Shared ${carrier.kind} ${carrier.id}`,
      });
  }

  for (const relationship of index.relationships) {
    const fromRoot = index.rootByNodeId.get(relationship.fromNodeId) ?? null;
    const toRoot = index.rootByNodeId.get(relationship.toNodeId) ?? null;
    if (
      !fromRoot ||
      !toRoot ||
      fromRoot === toRoot ||
      relationship.contractRef ||
      (fromRoot !== agentId && toRoot !== agentId)
    )
      continue;
    const downstream = fromRoot === agentId;
    const milestones = unique(
      plan.assignments.find((entry) => entry.plannedAgentId === agentId)
        ?.milestoneIds ?? [],
    );
    const sequence = relationship.kind === "triggers" && milestones.length > 0;
    dependencies.push({
      dependencyId: generatedId(
        "dependency",
        `${agentId}\0${relationship.id}\0${sequence ? "sequence" : "coordination"}`,
      ) as BriefDependencyId,
      kind: sequence ? "sequence-gate" : "coordination",
      direction: downstream ? "downstream" : "upstream",
      counterpartAgentId: downstream ? toRoot : fromRoot,
      relationshipIds: [relationship.id],
      contractIds: [],
      requiredByMilestoneIds: sequence ? milestones : [],
      blocking: sequence,
      description: relationship.description,
    });
  }

  return {
    inputs: by(inputs, (entry) => `${entry.contractId}\0${entry.nodeId}`),
    outputs: by(outputs, (entry) => `${entry.contractId}\0${entry.nodeId}`),
    dependencies: by(dependencies, (entry) => entry.dependencyId),
    relevantNodeIds: unique([...relevant]),
  };
}

function fingerprint(
  kind: DependencyFingerprintKind,
  value: unknown,
  refs: {
    nodeIds?: readonly PlanNodeId[];
    relationshipIds?: DependencyFingerprint["relationshipIds"];
    contractIds?: readonly PlanContractId[];
  } = {},
): DependencyFingerprint {
  return {
    kind,
    digest: computeCanonicalDigest(
      `sapiom.agent-brief-dependency.${kind}.v1`,
      value,
    ),
    nodeIds: unique(refs.nodeIds ?? []),
    relationshipIds: unique(refs.relationshipIds ?? []),
    contractIds: unique(refs.contractIds ?? []),
  };
}

function makeFingerprints(input: {
  agentId: PlanNodeId;
  ownedNodeIds: readonly PlanNodeId[];
  relevantNodeIds: readonly PlanNodeId[];
  inputs: readonly BriefContractPort[];
  outputs: readonly BriefContractPort[];
  dependencies: readonly BriefDependency[];
  plan: ProjectBuildPlanVersion;
  index: GraphIndex;
}) {
  const nodeProjection = (ids: readonly PlanNodeId[]) =>
    ids.map((id) => {
      const node = input.index.nodes.get(id)!;
      return {
        id: node.id,
        kind: node.kind,
        purpose: node.purpose,
        ownerAgentId: node.ownerAgentId,
        contractRefs: unique(node.contractRefs),
      };
    });
  const relationships = unique(
    input.dependencies.flatMap((entry) => entry.relationshipIds),
  );
  const relationshipProjection = relationships.map((id) => {
    const entry = input.index.relationships.find((item) => item.id === id)!;
    return {
      id: entry.id,
      fromNodeId: entry.fromNodeId,
      toNodeId: entry.toNodeId,
      kind: entry.kind,
      executionMode: entry.executionMode,
      contractRef: entry.contractRef,
      description: entry.description,
    };
  });
  const sharedRelationshipIds = unique(
    input.dependencies
      .filter((entry) => entry.kind === "shared-resource")
      .flatMap((entry) => entry.relationshipIds),
  );
  const sharedResourceIds = unique(
    input.index.relationships
      .filter((entry) => sharedRelationshipIds.includes(entry.id))
      .flatMap((entry) => [entry.fromNodeId, entry.toNodeId])
      .filter((id) => {
        const kind = input.index.nodes.get(id)?.kind;
        return kind === "resource" || kind === "connector";
      }),
  );
  const assignment = input.plan.assignments.find(
    (entry) => entry.plannedAgentId === input.agentId,
  )!;
  const canonicalPlan = buildPlanSemanticProjection(input.plan);
  const canonicalAssignment = canonicalPlan.assignments.find(
    (entry) => entry.plannedAgentId === input.agentId,
  )!;
  const milestones = selectRelevantMilestones(
    input.plan,
    assignment.milestoneIds,
  );
  const ports = (values: readonly BriefContractPort[]) => ({
    values,
    relationshipIds: unique(values.flatMap((entry) => entry.relationshipIds)),
    contractIds: unique(values.map((entry) => entry.contractId)),
  });
  const inputPorts = ports(input.inputs);
  const outputPorts = ports(input.outputs);
  return [
    fingerprint("owned-nodes", nodeProjection(input.ownedNodeIds), {
      nodeIds: input.ownedNodeIds,
      contractIds: unique(
        input.ownedNodeIds.flatMap(
          (id) =>
            (input.index.nodes.get(id)?.contractRefs as
              | PlanContractId[]
              | undefined) ?? [],
        ),
      ),
    }),
    fingerprint("relevant-nodes", nodeProjection(input.relevantNodeIds), {
      nodeIds: input.relevantNodeIds,
    }),
    fingerprint("input-contracts", input.inputs, inputPorts),
    fingerprint("output-contracts", input.outputs, outputPorts),
    fingerprint("cross-agent-relationships", relationshipProjection, {
      relationshipIds: relationships,
      contractIds: unique(
        input.dependencies.flatMap((entry) => entry.contractIds),
      ),
      nodeIds: unique(
        input.dependencies.flatMap((entry) => [
          input.agentId,
          entry.counterpartAgentId,
        ]),
      ),
    }),
    fingerprint("shared-resources", nodeProjection(sharedResourceIds), {
      nodeIds: sharedResourceIds,
      relationshipIds: sharedRelationshipIds,
    }),
    fingerprint("milestones", milestones, { nodeIds: [input.agentId] }),
    fingerprint(
      "shared-plan-content",
      {
        outcome: canonicalPlan.outcome,
        sharedConstraints: canonicalPlan.sharedConstraints,
        integrationCriteria: canonicalPlan.integrationCriteria,
        repositoryIntents: canonicalPlan.repositoryIntents.filter(
          (entry) => entry.plannedAgentId === input.agentId,
        ),
      },
      { nodeIds: [input.agentId] },
    ),
    fingerprint("assignment-content", canonicalAssignment, {
      nodeIds: [input.agentId],
    }),
  ];
}

function identitiesFor(
  request: Pick<CompileAgentBriefsRequest, "plan" | "assignments"> & {
    previous?: Readonly<{
      briefs: readonly PersistedAgentBriefVersionRecord[];
    }>;
  },
): Map<PlanNodeId, PlanningAssignmentRef> {
  const supplied = new Map<PlanNodeId, PlanningAssignmentRef>();
  for (const entry of by(
    request.assignments ?? [],
    (item) => `${item.plannedAgentId}\0${item.assignmentId}\0${item.briefId}`,
  ))
    if (!supplied.has(entry.plannedAgentId))
      supplied.set(entry.plannedAgentId, entry);
  for (const brief of by(
    request.previous?.briefs ?? [],
    (entry) =>
      `${entry.plannedAgentId}\0${entry.assignmentId}\0${entry.briefId}`,
  ))
    if (!supplied.has(brief.plannedAgentId))
      supplied.set(brief.plannedAgentId, {
        plannedAgentId: brief.plannedAgentId,
        assignmentId: brief.assignmentId,
        briefId: brief.briefId,
      });
  for (const assignment of request.plan.assignments)
    if (!supplied.has(assignment.plannedAgentId))
      supplied.set(assignment.plannedAgentId, {
        plannedAgentId: assignment.plannedAgentId,
        assignmentId: generatedId(
          "assignment",
          `${request.plan.planId}\0${assignment.plannedAgentId}`,
        ) as PlanningAssignmentId,
        briefId: generatedId(
          "brief",
          `${request.plan.planId}\0${assignment.plannedAgentId}`,
        ) as AgentBriefId,
      });
  return supplied;
}

function sealBrief(value: AgentBriefVersionRecord): AgentBriefVersionRecord {
  const semanticDigest = computeAgentBriefSemanticDigest(value);
  const withSemantic = { ...value, semanticDigest };
  return {
    ...withSemantic,
    recordDigest: computeAgentBriefRecordDigest(withSemantic),
  };
}

type PersistedCompileAgentBriefsRequest = Omit<
  CompileAgentBriefsRequest,
  "previous"
> & {
  previous?: Omit<
    NonNullable<CompileAgentBriefsRequest["previous"]>,
    "briefs"
  > & {
    briefs: readonly PersistedAgentBriefVersionRecord[];
  };
};

type PersistedCompiledBriefCandidate = Omit<CompiledBriefCandidate, "brief"> & {
  brief: PersistedAgentBriefVersionRecord;
};

type PersistedCompileAgentBriefsResult = Omit<
  CompileAgentBriefsResult,
  "briefs"
> & {
  briefs: readonly PersistedCompiledBriefCandidate[];
};

function compilePersistedAgentBriefs(
  request: PersistedCompileAgentBriefsRequest,
): PersistedCompileAgentBriefsResult {
  const diagnostics: BuildPlanDiagnostic[] = [];
  if (request.projectId !== request.plan.projectId)
    diagnostics.push(
      diagnostic("cross-project-reference", "projectId", [
        request.projectId,
        request.plan.projectId,
      ]),
    );
  if (!architectureSourceRefsEqual(request.source, request.plan.source))
    diagnostics.push(
      diagnostic("source-digest-mismatch", "source", [request.plan.planId]),
    );
  if (
    computeArchitectureGraphDigest(request.graph) !== request.source.graphDigest
  )
    diagnostics.push(
      diagnostic("source-digest-mismatch", "source.graphDigest", [
        request.source.graphDigest,
      ]),
    );
  if (
    computeBuildPlanSemanticDigest(request.plan) !== request.plan.semanticDigest
  )
    diagnostics.push(
      diagnostic("source-digest-mismatch", "plan.semanticDigest", [
        request.plan.planId,
      ]),
    );
  if (computeBuildPlanRecordDigest(request.plan) !== request.plan.recordDigest)
    diagnostics.push(
      diagnostic("source-digest-mismatch", "plan.recordDigest", [
        request.plan.planId,
      ]),
    );
  if (request.previous) {
    const previous = request.previous;
    const allowedPlanRefs = previous.allowedPlanRefs ?? [
      planRef(previous.plan),
    ];
    if (allowedPlanRefs.length > BUILD_PLAN_VERSION_HISTORY_LIMIT)
      diagnostics.push(
        diagnostic("bootstrap-limit-exceeded", "previous.allowedPlanRefs", [
          previous.plan.planId,
        ]),
      );
    const allowedByVersion = new Map<
      number,
      (typeof allowedPlanRefs)[number]
    >();
    for (const [refIndex, ref] of by(
      allowedPlanRefs,
      (entry) =>
        `${String(entry.version).padStart(16, "0")}\0${entry.planId}\0${entry.semanticDigest}`,
    ).entries()) {
      const existing = allowedByVersion.get(ref.version);
      if (
        ref.planId !== previous.plan.planId ||
        ref.version > previous.plan.version ||
        existing
      )
        diagnostics.push(
          diagnostic(
            "source-digest-mismatch",
            `previous.allowedPlanRefs[${refIndex}]`,
            [ref.planId, String(ref.version)],
          ),
        );
      if (!existing || compare(ref.semanticDigest, existing.semanticDigest) < 0)
        allowedByVersion.set(ref.version, ref);
    }
    const currentPreviousRef = allowedByVersion.get(previous.plan.version);
    if (
      !currentPreviousRef ||
      currentPreviousRef.planId !== previous.plan.planId ||
      currentPreviousRef.semanticDigest !== previous.plan.semanticDigest
    )
      diagnostics.push(
        diagnostic("source-digest-mismatch", "previous.allowedPlanRefs", [
          previous.plan.planId,
          String(previous.plan.version),
        ]),
      );
    if (previous.plan.projectId !== request.projectId)
      diagnostics.push(
        diagnostic("cross-project-reference", "previous.plan.projectId", [
          previous.plan.projectId,
          request.projectId,
        ]),
      );
    if (
      previous.plan.planId !== request.plan.planId ||
      previous.plan.version > request.plan.version ||
      (previous.plan.version !== request.plan.version &&
        request.plan.parentVersion !== previous.plan.version)
    )
      diagnostics.push(
        diagnostic("source-digest-mismatch", "previous.plan", [
          previous.plan.planId,
          request.plan.planId,
        ]),
      );
    if (
      computeArchitectureGraphDigest(previous.graph) !==
      previous.plan.source.graphDigest
    )
      diagnostics.push(
        diagnostic("source-digest-mismatch", "previous.graph", [
          previous.plan.planId,
        ]),
      );
    if (
      computeBuildPlanSemanticDigest(previous.plan) !==
        previous.plan.semanticDigest ||
      computeBuildPlanRecordDigest(previous.plan) !== previous.plan.recordDigest
    )
      diagnostics.push(
        diagnostic("source-digest-mismatch", "previous.plan", [
          previous.plan.planId,
        ]),
      );
    const seenPreviousAgents = new Set<PlanNodeId>();
    by(
      previous.briefs,
      (brief) =>
        `${brief.plannedAgentId}\0${brief.assignmentId}\0${brief.briefId}\0${brief.version}`,
    ).forEach((brief, briefIndex) => {
      if (seenPreviousAgents.has(brief.plannedAgentId))
        diagnostics.push(
          diagnostic(
            "invalid-dependency",
            `previous.briefs[${briefIndex}].plannedAgentId`,
            [brief.plannedAgentId],
          ),
        );
      seenPreviousAgents.add(brief.plannedAgentId);
      if (brief.projectId !== request.projectId)
        diagnostics.push(
          diagnostic(
            "cross-project-reference",
            `previous.briefs[${briefIndex}].projectId`,
            [brief.briefId, brief.projectId],
          ),
        );
      if (
        brief.plan.planId !== previous.plan.planId ||
        allowedByVersion.get(brief.plan.version)?.planId !==
          brief.plan.planId ||
        allowedByVersion.get(brief.plan.version)?.semanticDigest !==
          brief.plan.semanticDigest ||
        !architectureSourceRefsEqual(brief.source, previous.plan.source) ||
        computeAgentBriefSemanticDigest(brief) !== brief.semanticDigest ||
        computeAgentBriefRecordDigest(brief) !== brief.recordDigest
      )
        diagnostics.push(
          diagnostic(
            "source-digest-mismatch",
            `previous.briefs[${briefIndex}]`,
            [brief.briefId],
          ),
        );
    });
  }
  const suppliedIdentityOwners = new Map<string, PlanNodeId>();
  const suppliedAgentIds = new Set<PlanNodeId>();
  const previousIdentityByAgent = new Map<
    PlanNodeId,
    PersistedAgentBriefVersionRecord
  >();
  for (const brief of by(
    request.previous?.briefs ?? [],
    (entry) =>
      `${entry.plannedAgentId}\0${entry.assignmentId}\0${entry.briefId}`,
  ))
    if (!previousIdentityByAgent.has(brief.plannedAgentId))
      previousIdentityByAgent.set(brief.plannedAgentId, brief);
  for (const [assignmentIndex, assignment] of by(
    request.assignments ?? [],
    (entry) =>
      `${entry.plannedAgentId}\0${entry.assignmentId}\0${entry.briefId}`,
  ).entries()) {
    const identities = [assignment.assignmentId, assignment.briefId];
    const duplicateAgent = suppliedAgentIds.has(assignment.plannedAgentId);
    suppliedAgentIds.add(assignment.plannedAgentId);
    const conflictingOwner = identities.find(
      (id) =>
        suppliedIdentityOwners.has(id) &&
        suppliedIdentityOwners.get(id) !== assignment.plannedAgentId,
    );
    identities.forEach((id) =>
      suppliedIdentityOwners.set(id, assignment.plannedAgentId),
    );
    const previousIdentity = previousIdentityByAgent.get(
      assignment.plannedAgentId,
    );
    const conflictsWithPrevious =
      previousIdentity !== undefined &&
      (previousIdentity.assignmentId !== assignment.assignmentId ||
        previousIdentity.briefId !== assignment.briefId);
    if (duplicateAgent || conflictingOwner || conflictsWithPrevious)
      diagnostics.push(
        diagnostic("invalid-dependency", `assignments[${assignmentIndex}]`, [
          assignment.plannedAgentId,
          assignment.assignmentId,
          assignment.briefId,
        ]),
      );
  }
  const index = indexGraph(request.graph, diagnostics);
  const assignmentGroups = new Map<PlanNodeId, number[]>();
  request.plan.assignments.forEach((assignment, assignmentIndex) =>
    assignmentGroups.set(assignment.plannedAgentId, [
      ...(assignmentGroups.get(assignment.plannedAgentId) ?? []),
      assignmentIndex,
    ]),
  );
  const identities = identitiesFor(request);
  const previousByAgent = new Map<
    PlanNodeId,
    PersistedAgentBriefVersionRecord
  >();
  for (const brief of by(
    request.previous?.briefs ?? [],
    (entry) =>
      `${entry.plannedAgentId}\0${entry.assignmentId}\0${entry.briefId}`,
  ))
    if (!previousByAgent.has(brief.plannedAgentId))
      previousByAgent.set(brief.plannedAgentId, brief);
  const candidates: PersistedCompiledBriefCandidate[] = [];

  for (const agent of index.topLevelAgents) {
    const assignmentIndexes = assignmentGroups.get(agent.id) ?? [];
    if (assignmentIndexes.length !== 1) {
      diagnostics.push(
        diagnostic("missing-agent-assignment", "plan.assignments", [agent.id]),
      );
      continue;
    }
    const assignmentIndex = assignmentIndexes[0]!;
    const assignment = request.plan.assignments[assignmentIndex]!;
    const identity = identities.get(agent.id)!;
    if (assignment.mission.trim().length === 0)
      diagnostics.push(
        diagnostic(
          "brief-mission-missing",
          `plan.assignments[${assignmentIndex}].mission`,
          [agent.id],
        ),
      );
    if (assignment.scope.inScope.length === 0)
      diagnostics.push(
        diagnostic(
          "brief-scope-missing",
          `plan.assignments[${assignmentIndex}].scope.inScope`,
          [agent.id],
        ),
      );
    if (assignment.scope.nonGoals.length === 0)
      diagnostics.push(
        diagnostic(
          "brief-non-goals-suspicious",
          `plan.assignments[${assignmentIndex}].scope.nonGoals`,
          [agent.id],
          "warning",
        ),
      );
    if (assignment.deliverables.length === 0)
      diagnostics.push(
        diagnostic(
          "brief-deliverable-missing",
          `plan.assignments[${assignmentIndex}].deliverables`,
          [agent.id],
        ),
      );
    if (
      assignment.acceptanceCriteria.length === 0 &&
      request.plan.integrationCriteria.length === 0
    )
      diagnostics.push(
        diagnostic(
          "brief-acceptance-criterion-missing",
          `plan.assignments[${assignmentIndex}].acceptanceCriteria`,
          [agent.id],
        ),
      );
    assignment.unresolvedDecisions.forEach((decision, decisionIndex) => {
      if (decision.required && decision.status === "open")
        diagnostics.push(
          diagnostic(
            "unresolved-required-decision",
            `plan.assignments[${assignmentIndex}].unresolvedDecisions[${decisionIndex}]`,
            [agent.id, decision.decisionId],
          ),
        );
    });
    const ownedNodeIds = index.ownedByRoot.get(agent.id) ?? [agent.id];
    assignment.deliverables.forEach((deliverable, deliverableIndex) =>
      deliverable.artifactNodeIds.forEach((nodeId, nodeIndex) => {
        const node = index.nodes.get(nodeId);
        if (!node)
          diagnostics.push(
            diagnostic(
              "unknown-node-reference",
              `plan.assignments[${assignmentIndex}].deliverables[${deliverableIndex}].artifactNodeIds[${nodeIndex}]`,
              [agent.id, nodeId],
            ),
          );
        else {
          const owner = index.rootByNodeId.get(nodeId);
          if (owner && owner !== agent.id)
            diagnostics.push(
              diagnostic(
                "authored-architecture-conflict",
                `plan.assignments[${assignmentIndex}].deliverables[${deliverableIndex}].artifactNodeIds[${nodeIndex}]`,
                [agent.id, nodeId, owner],
              ),
            );
        }
      }),
    );
    const boundary = boundaryForAgent(
      agent.id,
      request.plan,
      index,
      diagnostics,
    );
    const constraints = by(
      [...request.plan.sharedConstraints, ...assignment.constraints].filter(
        (entry, entryIndex, entries) =>
          entries.findIndex(
            (candidate) => candidate.constraintId === entry.constraintId,
          ) === entryIndex,
      ),
      (entry) => entry.constraintId,
    );
    for (const own of assignment.constraints) {
      const shared = request.plan.sharedConstraints.find(
        (entry) => entry.constraintId === own.constraintId,
      );
      if (
        shared &&
        computeCanonicalDigest("constraint", shared) !==
          computeCanonicalDigest("constraint", own)
      )
        diagnostics.push(
          diagnostic(
            "authored-architecture-conflict",
            `plan.assignments[${assignmentIndex}].constraints`,
            [agent.id, own.constraintId],
          ),
        );
    }
    const criteria = [...assignment.acceptanceCriteria].sort(
      (left, right) =>
        left.ordinal - right.ordinal ||
        compare(left.criterionId, right.criterionId),
    );
    const fingerprints = makeFingerprints({
      agentId: agent.id,
      ownedNodeIds,
      relevantNodeIds: boundary.relevantNodeIds,
      inputs: boundary.inputs,
      outputs: boundary.outputs,
      dependencies: boundary.dependencies,
      plan: request.plan,
      index,
    });
    const previous = previousByAgent.get(agent.id);
    const draft = sealBrief({
      schemaVersion: AGENT_BRIEF_SCHEMA_VERSION,
      digestVersion: AGENT_BRIEF_DIGEST_VERSION,
      projectId: request.projectId,
      briefId: identity.briefId,
      version: ((previous?.version ?? 0) +
        1) as AgentBriefVersionRecord["version"],
      parentVersion: previous?.version ?? null,
      plannedAgentId: agent.id,
      assignmentId: identity.assignmentId,
      plan: planRef(request.plan),
      source: request.source,
      mission: assignment.mission,
      scope: {
        inScope: unique(assignment.scope.inScope),
        nonGoals: unique(assignment.scope.nonGoals),
      },
      ownedNodeIds: unique(ownedNodeIds),
      relevantNodeIds: boundary.relevantNodeIds,
      inputs: boundary.inputs,
      outputs: boundary.outputs,
      dependencies: boundary.dependencies,
      deliverables: by(
        assignment.deliverables,
        (entry) => entry.deliverableId,
      ).map((entry) => ({
        ...entry,
        artifactNodeIds: unique(entry.artifactNodeIds),
        acceptanceCriterionIds: unique(entry.acceptanceCriterionIds),
      })),
      acceptanceCriteria: criteria,
      constraints,
      milestones: unique(assignment.milestoneIds),
      unresolvedDecisions: by(
        [
          ...request.plan.unresolvedDecisions,
          ...assignment.unresolvedDecisions,
        ],
        (entry) => entry.decisionId,
      ),
      changeProtocol: {
        proposeArchitectureChanges: true,
        instructions: [
          "Use agent_map_propose for architecture changes.",
          "Submit a structured planning result.",
          "Stop before implementation.",
        ],
      },
      compilerVersion: AGENT_BRIEF_COMPILER_VERSION,
      dependencyFingerprints: fingerprints,
      semanticDigest:
        ZERO_DIGEST as unknown as AgentBriefVersionRecord["semanticDigest"],
      recordDigest: ZERO_DIGEST,
      authoredBy: request.plan.authoredBy,
      createdAt: request.plan.createdAt,
    });
    const sameSemantic =
      previous?.schemaVersion === AGENT_BRIEF_SCHEMA_VERSION &&
      previous.digestVersion === AGENT_BRIEF_DIGEST_VERSION &&
      previous.semanticDigest === draft.semanticDigest;
    const sameSource = previous
      ? architectureSourceRefsEqual(previous.source, request.source)
      : false;
    const disposition: CompiledBriefCandidate["disposition"] = !previous
      ? "created"
      : !sameSemantic
        ? "new-version"
        : !sameSource
          ? "source-rebound"
          : "unchanged";
    const brief =
      disposition === "unchanged"
        ? (previous as AgentBriefVersionRecord)
        : draft;
    try {
      candidates.push({
        plannedAgentId: agent.id,
        assignmentId: identity.assignmentId,
        existingBriefRef: previous ? briefRef(previous) : null,
        disposition,
        brief,
        bootstrap: createBuilderBootstrapContext({
          plan: request.plan,
          graph: request.graph,
          brief: draft,
          briefRef: briefRef(brief),
        }),
      });
    } catch (error) {
      if (error instanceof BuilderBootstrapLimitError)
        diagnostics.push(
          diagnostic("bootstrap-limit-exceeded", error.path, [agent.id]),
        );
      else throw error;
    }
  }

  const activeIds = new Set(index.topLevelAgents.map((entry) => entry.id));
  for (const previous of by(
    request.previous?.briefs ?? [],
    (entry) => entry.plannedAgentId,
  )) {
    if (activeIds.has(previous.plannedAgentId)) continue;
    candidates.push({
      plannedAgentId: previous.plannedAgentId,
      assignmentId: previous.assignmentId,
      existingBriefRef: briefRef(previous),
      disposition: "retired",
      brief: previous,
      bootstrap: createPersistedBuilderBootstrapContext({
        plan: request.previous!.plan,
        graph: request.previous!.graph,
        brief: previous,
      }),
    });
  }

  const nextBriefs = candidates
    .filter((entry) => entry.disposition !== "retired")
    .map((entry) => entry.brief);
  const previous = request.previous ?? {
    plan: request.plan,
    graph: { nodes: [], relationships: [] },
    briefs: [],
  };
  const impact = evaluatePersistedBuildPlanImpact({
    previousSource: previous.plan.source,
    nextSource: request.source,
    briefs: previous.briefs,
    previousPlan: previous.plan,
    nextPlan: request.plan,
    previousGraph: previous.graph,
    nextGraph: request.graph,
    nextBriefs,
  });
  const finalizedDiagnostics = finalizeDiagnostics(diagnostics);
  const complete = finalizedDiagnostics.every(
    (entry) => entry.severity !== "error",
  );
  const reasons: CompileAgentBriefsResult["eligibility"]["reasons"][number][] =
    [];
  if (!complete) reasons.push("plan-incomplete");
  if (
    candidates.filter((entry) => entry.disposition !== "retired").length !==
    index.topLevelAgents.length
  )
    reasons.push("brief-missing");
  if (request.source.kind !== "revision") reasons.push("source-not-confirmed");
  return {
    plan: planRef(request.plan),
    source: request.source,
    briefs: by(candidates, (entry) => entry.plannedAgentId),
    impact,
    completeness: {
      status: complete ? "complete" : "incomplete",
      issues: finalizedDiagnostics,
    },
    eligibility: {
      planningEligible: complete,
      implementationEligible: complete && request.source.kind === "revision",
      reasons: unique(reasons),
    },
    diagnostics: finalizedDiagnostics,
  };
}

export class AgentBriefCompilationError extends Error {
  constructor(
    readonly diagnostics: readonly BuildPlanDiagnostic[],
    readonly code:
      | "invalid-compilation"
      | "legacy-brief-result" = "invalid-compilation",
  ) {
    super(
      code === "legacy-brief-result"
        ? "Agent brief compiler produced a legacy brief"
        : "Agent brief compilation failed",
    );
    this.name = "AgentBriefCompilationError";
  }
}

export function compileAgentBriefs(
  request: CompileAgentBriefsRequest,
): CompileAgentBriefsResult {
  const compilation = compilePersistedAgentBriefs(request);
  if (
    compilation.briefs.some(
      (candidate) =>
        candidate.brief.schemaVersion !== AGENT_BRIEF_SCHEMA_VERSION,
    )
  )
    throw new AgentBriefCompilationError([], "legacy-brief-result");
  return compilation as CompileAgentBriefsResult;
}

/** Production adapter for the build-plan authoring orchestration seam. */
export class DeterministicAgentBriefCompiler implements AgentBriefCompiler {
  async compile(
    input: Parameters<AgentBriefCompiler["compile"]>[0],
  ): Promise<AgentBriefCompileResult> {
    const previous =
      input.previousPlan && input.previousGraph
        ? {
            plan: input.previousPlan,
            graph: input.previousGraph,
            briefs: input.currentBriefs,
            allowedPlanRefs: input.previousPlanRefs ?? [
              planRef(input.previousPlan),
            ],
          }
        : undefined;
    const compilation = compilePersistedAgentBriefs({
      projectId: input.plan.projectId,
      source: input.plan.source,
      graph: input.graph,
      plan: input.plan,
      assignments: input.assignments,
      ...(previous ? { previous } : {}),
    });
    if (compilation.diagnostics.some((entry) => entry.severity === "error"))
      throw new AgentBriefCompilationError(compilation.diagnostics);
    return {
      briefs: compilation.briefs
        .filter(
          (entry): entry is typeof entry & { brief: AgentBriefVersionRecord } =>
            ["created", "new-version", "source-rebound"].includes(
              entry.disposition,
            ) && entry.brief.schemaVersion === AGENT_BRIEF_SCHEMA_VERSION,
        )
        .map((entry) => entry.brief),
      changes: compilation.briefs.map((entry) => ({
        plannedAgentId: entry.plannedAgentId,
        change:
          entry.disposition === "created"
            ? "created"
            : entry.disposition === "unchanged"
              ? "preserved"
              : entry.disposition === "retired"
                ? "staled"
                : "changed",
      })),
      impact: compilation.impact,
    };
  }
}
