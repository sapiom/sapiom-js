import type {
  AgentMapGraph,
  PlanNodeId,
  PlanRelationship,
} from "../shared/agent-map.js";
import {
  architectureSourceRefsEqual,
  type PersistedAgentBriefVersionRecord,
  type ArchitectureSourceRef,
  type BriefFreshness,
  type BuildPlanCompleteness,
  type BuildPlanDiagnostic,
  type BuildPlanEligibility,
  type ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import {
  ArchitectureSourceResolutionError,
  type ResolvedArchitectureSource,
} from "./architecture-source-resolver.js";

export const BUILD_PLAN_DIAGNOSTIC_LIMIT = 64;

export interface ExactArchitectureSourceResolver {
  resolve(
    projectId: string,
    source: ArchitectureSourceRef,
  ): Promise<ResolvedArchitectureSource>;
}

const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function diagnostic(
  code: BuildPlanDiagnostic["code"],
  path: string,
  relatedIds: readonly string[] = [],
  severity: BuildPlanDiagnostic["severity"] = "error",
): BuildPlanDiagnostic {
  const messages: Record<BuildPlanDiagnostic["code"], string> = {
    "missing-agent-assignment": "A top-level agent requires an assignment",
    "unknown-node-reference": "A referenced architecture node does not exist",
    "cross-project-reference": "A reference belongs to another project",
    "missing-brief": "A current assignment requires a focused brief",
    "incompatible-contract-direction":
      "A contract port direction conflicts with the architecture",
    "ambiguous-contract-direction":
      "Typed graph fields do not establish a contract direction",
    "ownership-cycle": "Architecture ownership contains a cycle",
    "multiple-top-level-owners":
      "A stable node resolves to multiple top-level owners",
    "dangling-ownership":
      "Architecture ownership does not resolve to a top-level agent",
    "authored-architecture-conflict":
      "Authored intent conflicts with architecture-owned facts",
    "brief-mission-missing": "The assignment requires a mission",
    "brief-scope-missing": "The assignment requires explicit scope",
    "brief-non-goals-suspicious": "The assignment has no explicit non-goals",
    "brief-deliverable-missing": "The assignment requires a deliverable",
    "brief-acceptance-criterion-missing":
      "The assignment requires acceptance evidence",
    "brief-change-protocol-missing":
      "The brief requires an architecture change protocol",
    "bootstrap-limit-exceeded":
      "Builder bootstrap content exceeds a safe bound",
    "invalid-dependency":
      "A dependency is not supported by the referenced architecture",
    "unresolved-required-decision": "A required decision remains unresolved",
    "source-not-found": "The exact architecture source was not found",
    "source-digest-mismatch":
      "The exact architecture source digest does not match",
  };
  return {
    code,
    severity,
    path: path.slice(0, 512),
    message: messages[code],
    relatedIds: [...relatedIds].slice(0, 16),
  };
}

function finalize(issues: BuildPlanDiagnostic[]): BuildPlanDiagnostic[] {
  const unique = new Map<string, BuildPlanDiagnostic>();
  for (const issue of issues)
    unique.set(
      JSON.stringify([issue.path, issue.code, issue.relatedIds]),
      issue,
    );
  return [...unique.values()]
    .sort(
      (left, right) =>
        compare(left.path, right.path) ||
        compare(left.code, right.code) ||
        compare(left.relatedIds.join("\0"), right.relatedIds.join("\0")),
    )
    .slice(0, BUILD_PLAN_DIAGNOSTIC_LIMIT);
}

type EffectiveDataFlow = Readonly<{
  fromNodeId: PlanNodeId;
  toNodeId: PlanNodeId;
}>;

/**
 * E2 records actor-oriented resource access: both reads and writes point from
 * the actor to the resource/artifact. Delivery dependencies need the semantic
 * direction of the transferred data, so reads flow in the opposite direction.
 * `uses` is deliberately excluded because resource access alone does not prove
 * that one agent produces an input consumed by another.
 */
function effectiveDataFlow(
  relationship: PlanRelationship,
): EffectiveDataFlow | null {
  if (relationship.kind === "uses") return null;
  if (relationship.kind === "reads")
    return {
      fromNodeId: relationship.toNodeId,
      toNodeId: relationship.fromNodeId,
    };
  return {
    fromNodeId: relationship.fromNodeId,
    toNodeId: relationship.toNodeId,
  };
}

function validateBrief(
  brief: PersistedAgentBriefVersionRecord,
  plan: ProjectBuildPlanVersion,
  graph: AgentMapGraph,
  index: number,
): BuildPlanDiagnostic[] {
  const issues: BuildPlanDiagnostic[] = [];
  const prefix = `briefs[${index}]`;
  if (brief.projectId !== plan.projectId)
    issues.push(
      diagnostic("cross-project-reference", `${prefix}.projectId`, [
        brief.briefId,
      ]),
    );
  if (brief.plan.planId !== plan.planId)
    issues.push(
      diagnostic("invalid-dependency", `${prefix}.plan`, [brief.plan.planId]),
    );
  if (!architectureSourceRefsEqual(brief.source, plan.source))
    issues.push(
      diagnostic("source-digest-mismatch", `${prefix}.source`, [brief.briefId]),
    );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const relationships = new Map(
    graph.relationships.map((entry) => [entry.id, entry]),
  );
  const ownershipRoot = (nodeId: PlanNodeId): PlanNodeId | null => {
    const visited = new Set<PlanNodeId>();
    let current = nodes.get(nodeId);
    while (current) {
      if (visited.has(current.id)) return null;
      visited.add(current.id);
      if (current.ownerAgentId === null)
        return current.kind === "agent" ? current.id : null;
      current = nodes.get(current.ownerAgentId);
    }
    return null;
  };
  const belongsToPlannedAgent = (nodeId: PlanNodeId): boolean =>
    ownershipRoot(nodeId) === brief.plannedAgentId;
  const isCarrierNode = (nodeId: PlanNodeId): boolean => {
    const kind = nodes.get(nodeId)?.kind;
    return kind === "artifact" || kind === "resource" || kind === "connector";
  };
  const evidenceFormsDataPath = (
    evidence: readonly EffectiveDataFlow[],
    producerAgentId: PlanNodeId,
    consumerAgentId: PlanNodeId,
  ): boolean => {
    if (evidence.length === 0) return false;
    const isActorFor = (nodeId: PlanNodeId, agentId: PlanNodeId): boolean => {
      const kind = nodes.get(nodeId)?.kind;
      return (
        ownershipRoot(nodeId) === agentId &&
        (kind === "agent" || kind === "subagent")
      );
    };
    const startIds = new Set(
      evidence
        .flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])
        .filter((nodeId) => isActorFor(nodeId, producerAgentId)),
    );
    const targetIds = new Set(
      evidence
        .flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])
        .filter((nodeId) => isActorFor(nodeId, consumerAgentId)),
    );
    if (startIds.size === 0 || targetIds.size === 0) return false;

    const reachableFrom = (
      initial: ReadonlySet<PlanNodeId>,
      reverse: boolean,
    ): Set<PlanNodeId> => {
      const reached = new Set(initial);
      const queue = [...initial];
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]!;
        for (const edge of evidence) {
          const fromNodeId = reverse ? edge.toNodeId : edge.fromNodeId;
          const toNodeId = reverse ? edge.fromNodeId : edge.toNodeId;
          if (fromNodeId !== current || reached.has(toNodeId)) continue;
          reached.add(toNodeId);
          queue.push(toNodeId);
        }
      }
      return reached;
    };
    const forward = reachableFrom(startIds, false);
    const backward = reachableFrom(targetIds, true);
    return (
      [...targetIds].some((targetId) => forward.has(targetId)) &&
      evidence.every(
        ({ fromNodeId, toNodeId }) =>
          forward.has(fromNodeId) && backward.has(toNodeId),
      )
    );
  };
  const plannedNode = nodes.get(brief.plannedAgentId);
  if (
    !plannedNode ||
    plannedNode.kind !== "agent" ||
    plannedNode.ownerAgentId !== null
  )
    issues.push(
      diagnostic("unknown-node-reference", `${prefix}.plannedAgentId`, [
        brief.plannedAgentId,
      ]),
    );
  for (const [field, ids] of [
    ["ownedNodeIds", brief.ownedNodeIds],
    ["relevantNodeIds", brief.relevantNodeIds],
  ] as const)
    ids.forEach((id, itemIndex) => {
      if (!nodes.has(id))
        issues.push(
          diagnostic(
            "unknown-node-reference",
            `${prefix}.${field}[${itemIndex}]`,
            [id],
          ),
        );
      else if (field === "ownedNodeIds" && !belongsToPlannedAgent(id))
        issues.push(
          diagnostic("invalid-dependency", `${prefix}.${field}[${itemIndex}]`, [
            id,
          ]),
        );
    });
  [...brief.inputs, ...brief.outputs].forEach((port, portIndex) => {
    const isInput = portIndex < brief.inputs.length;
    const evidence = port.relationshipIds.map((id) => relationships.get(id));
    if (!nodes.has(port.nodeId))
      issues.push(
        diagnostic(
          "unknown-node-reference",
          `${prefix}.ports[${portIndex}].nodeId`,
          [port.nodeId],
        ),
      );
    const validEvidence =
      port.relationshipIds.length > 0 &&
      evidence.every((relation) => {
        if (!relation || relation.contractRef !== port.contractId) return false;
        const flow = effectiveDataFlow(relation);
        if (!flow) return false;
        return isInput
          ? flow.toNodeId === port.nodeId &&
              belongsToPlannedAgent(flow.toNodeId) &&
              (ownershipRoot(flow.fromNodeId) !== brief.plannedAgentId ||
                isCarrierNode(flow.fromNodeId))
          : flow.fromNodeId === port.nodeId &&
              belongsToPlannedAgent(flow.fromNodeId) &&
              (ownershipRoot(flow.toNodeId) !== brief.plannedAgentId ||
                isCarrierNode(flow.toNodeId));
      });
    if (!validEvidence)
      issues.push(
        diagnostic(
          "incompatible-contract-direction",
          `${prefix}.ports[${portIndex}].relationshipIds`,
          [port.contractId, ...port.relationshipIds],
        ),
      );
  });
  brief.dependencies.forEach((dependency, dependencyIndex) => {
    const counterpart = nodes.get(dependency.counterpartAgentId);
    const evidence = dependency.relationshipIds
      .map((id) => relationships.get(id))
      .filter((entry) => entry !== undefined);
    const dataFlowEvidence = evidence.flatMap((relation) => {
      const flow = effectiveDataFlow(relation);
      return flow === null ? [] : [flow];
    });
    const ownToCounterpart = evidence.filter(
      (relation) =>
        ownershipRoot(relation.fromNodeId) === brief.plannedAgentId &&
        ownershipRoot(relation.toNodeId) === dependency.counterpartAgentId,
    );
    const counterpartToOwn = evidence.filter(
      (relation) =>
        ownershipRoot(relation.fromNodeId) === dependency.counterpartAgentId &&
        ownershipRoot(relation.toNodeId) === brief.plannedAgentId,
    );
    const supportsDirection =
      dependency.direction === "upstream"
        ? counterpartToOwn.length > 0
        : dependency.direction === "downstream"
          ? ownToCounterpart.length > 0
          : ownToCounterpart.length > 0 && counterpartToOwn.length > 0;
    const evidencedContracts = new Set(
      evidence.flatMap((relation) =>
        relation.contractRef === null ? [] : [relation.contractRef],
      ),
    );
    const contractsLinked = dependency.contractIds.every((id) =>
      evidencedContracts.has(id),
    );
    const dataFlowContractsLinked =
      dependency.contractIds.length > 0 &&
      dataFlowEvidence.length === evidence.length &&
      contractsLinked &&
      evidence.every(
        (relation) =>
          relation.contractRef !== null &&
          dependency.contractIds.some((id) => id === relation.contractRef),
      );
    const milestoneIds = new Set(
      plan.milestones.map(({ milestoneId }) => milestoneId),
    );
    const milestonesLinked = dependency.requiredByMilestoneIds.every(
      (id) => milestoneIds.has(id) && brief.milestones.includes(id),
    );
    const sharedResourceIds = graph.nodes
      .filter(
        (node) =>
          node.kind === "resource" ||
          node.kind === "connector" ||
          node.kind === "artifact",
      )
      .map((node) => node.id)
      .filter((resourceId) => {
        const adjacentRoots = new Set<PlanNodeId>();
        for (const relation of evidence) {
          if (relation.fromNodeId === resourceId) {
            const root = ownershipRoot(relation.toNodeId);
            if (root !== null) adjacentRoots.add(root);
          }
          if (relation.toNodeId === resourceId) {
            const root = ownershipRoot(relation.fromNodeId);
            if (root !== null) adjacentRoots.add(root);
          }
        }
        return (
          adjacentRoots.has(brief.plannedAgentId) &&
          adjacentRoots.has(dependency.counterpartAgentId)
        );
      });
    const allEvidenceResolved =
      evidence.length === dependency.relationshipIds.length &&
      evidence.length > 0;
    const allEvidenceCrossesBoundary =
      ownToCounterpart.length + counterpartToOwn.length === evidence.length;
    const allEvidenceUsesSharedResource = evidence.every((relation) =>
      sharedResourceIds.some(
        (resourceId) =>
          relation.fromNodeId === resourceId ||
          relation.toNodeId === resourceId,
      ),
    );
    const supported =
      allEvidenceResolved &&
      contractsLinked &&
      milestonesLinked &&
      (dependency.kind === "consumes-output"
        ? dependency.direction === "upstream" &&
          dataFlowContractsLinked &&
          evidenceFormsDataPath(
            dataFlowEvidence,
            dependency.counterpartAgentId,
            brief.plannedAgentId,
          )
        : dependency.kind === "provides-input"
          ? dependency.direction === "downstream" &&
            dataFlowContractsLinked &&
            evidenceFormsDataPath(
              dataFlowEvidence,
              brief.plannedAgentId,
              dependency.counterpartAgentId,
            )
          : dependency.kind === "shared-resource"
            ? dependency.direction === "bidirectional" &&
              sharedResourceIds.length > 0 &&
              allEvidenceUsesSharedResource
            : dependency.kind === "sequence-gate"
              ? dependency.requiredByMilestoneIds.length > 0 &&
                dependency.blocking &&
                allEvidenceCrossesBoundary &&
                supportsDirection
              : allEvidenceCrossesBoundary && supportsDirection);
    if (
      !counterpart ||
      counterpart.kind !== "agent" ||
      counterpart.ownerAgentId !== null ||
      dependency.counterpartAgentId === brief.plannedAgentId ||
      !supported
    )
      issues.push(
        diagnostic(
          "invalid-dependency",
          `${prefix}.dependencies[${dependencyIndex}]`,
          [dependency.counterpartAgentId, ...dependency.relationshipIds],
        ),
      );
  });
  brief.unresolvedDecisions.forEach((decision, decisionIndex) => {
    if (decision.required && decision.status === "open")
      issues.push(
        diagnostic(
          "unresolved-required-decision",
          `${prefix}.unresolvedDecisions[${decisionIndex}]`,
          [decision.decisionId],
        ),
      );
  });
  return issues;
}

export class BuildPlanContractValidator {
  constructor(private readonly resolver: ExactArchitectureSourceResolver) {}

  async validate(
    plan: ProjectBuildPlanVersion,
    briefs: readonly PersistedAgentBriefVersionRecord[],
  ): Promise<{
    completeness: BuildPlanCompleteness;
    eligibility: BuildPlanEligibility;
  }> {
    let resolved: ResolvedArchitectureSource;
    try {
      resolved = await this.resolver.resolve(plan.projectId, plan.source);
    } catch (error) {
      const code =
        error instanceof ArchitectureSourceResolutionError
          ? error.code === "cross_project"
            ? "cross-project-reference"
            : error.code === "source_digest_mismatch"
              ? "source-digest-mismatch"
              : "source-not-found"
          : "source-not-found";
      const issues = [diagnostic(code, "source")];
      return {
        completeness: { status: "incomplete", issues },
        eligibility: {
          planningEligible: false,
          implementationEligible: false,
          reasons: ["plan-incomplete"],
        },
      };
    }
    const issues: BuildPlanDiagnostic[] = [];
    const nodes = new Map(resolved.graph.nodes.map((node) => [node.id, node]));
    const topLevel = resolved.graph.nodes.filter(
      (node) => node.kind === "agent" && node.ownerAgentId === null,
    );
    const assignments = new Map(
      plan.assignments.map((entry) => [entry.plannedAgentId, entry]),
    );
    topLevel.forEach((node) => {
      if (!assignments.has(node.id))
        issues.push(
          diagnostic("missing-agent-assignment", "assignments", [node.id]),
        );
    });
    plan.assignments.forEach((assignment, index) => {
      const node = nodes.get(assignment.plannedAgentId);
      if (!node || node.kind !== "agent" || node.ownerAgentId !== null)
        issues.push(
          diagnostic(
            "unknown-node-reference",
            `assignments[${index}].plannedAgentId`,
            [assignment.plannedAgentId],
          ),
        );
      assignment.unresolvedDecisions.forEach((decision, decisionIndex) => {
        if (decision.required && decision.status === "open")
          issues.push(
            diagnostic(
              "unresolved-required-decision",
              `assignments[${index}].unresolvedDecisions[${decisionIndex}]`,
              [decision.decisionId],
            ),
          );
      });
    });
    plan.repositoryIntents.forEach((intent, index) => {
      const node = nodes.get(intent.plannedAgentId);
      if (!node || node.kind !== "agent" || node.ownerAgentId !== null)
        issues.push(
          diagnostic(
            "unknown-node-reference",
            `repositoryIntents[${index}].plannedAgentId`,
            [intent.plannedAgentId],
          ),
        );
    });
    plan.unresolvedDecisions.forEach((decision, index) => {
      if (decision.required && decision.status === "open")
        issues.push(
          diagnostic(
            "unresolved-required-decision",
            `unresolvedDecisions[${index}]`,
            [decision.decisionId],
          ),
        );
    });
    const briefsByAgent = new Map<
      PlanNodeId,
      PersistedAgentBriefVersionRecord
    >();
    briefs.forEach((brief, index) => {
      if (briefsByAgent.has(brief.plannedAgentId))
        issues.push(
          diagnostic("invalid-dependency", `briefs[${index}].plannedAgentId`, [
            brief.plannedAgentId,
          ]),
        );
      briefsByAgent.set(brief.plannedAgentId, brief);
      issues.push(...validateBrief(brief, plan, resolved.graph, index));
    });
    topLevel.forEach((node) => {
      if (!briefsByAgent.has(node.id))
        issues.push(diagnostic("missing-brief", "briefs", [node.id]));
    });
    const bounded = finalize(issues);
    const complete = bounded.every((entry) => entry.severity !== "error");
    const reasons: BuildPlanEligibility["reasons"][number][] = [];
    if (!complete) reasons.push("plan-incomplete");
    if (bounded.some((entry) => entry.code === "missing-brief"))
      reasons.push("brief-missing");
    if (plan.source.kind !== "revision") reasons.push("source-not-confirmed");
    return {
      completeness: {
        status: complete ? "complete" : "incomplete",
        issues: bounded,
      },
      eligibility: {
        planningEligible: complete,
        implementationEligible: complete && plan.source.kind === "revision",
        reasons,
      },
    };
  }
}

export function computeBriefFreshness(
  brief: PersistedAgentBriefVersionRecord,
  evaluatedAgainst: ArchitectureSourceRef,
): BriefFreshness {
  if (architectureSourceRefsEqual(brief.source, evaluatedAgainst))
    return { status: "current", evaluatedAgainst, reasons: [] };
  return {
    status: "stale",
    evaluatedAgainst,
    reasons: [
      {
        code: "source-changed",
        affectedNodeIds: [brief.plannedAgentId],
        affectedRelationshipIds: [],
        affectedContractIds: [],
      },
    ],
  };
}
