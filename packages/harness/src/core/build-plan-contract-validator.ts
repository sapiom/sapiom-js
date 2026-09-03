import type { AgentMapGraph, PlanNodeId } from "../shared/agent-map.js";
import {
  architectureSourceRefsEqual,
  type AgentBriefVersionRecord,
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

function validateBrief(
  brief: AgentBriefVersionRecord,
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
  if (
    brief.plan.planId !== plan.planId ||
    brief.plan.version !== plan.version ||
    brief.plan.semanticDigest !== plan.semanticDigest
  )
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
      evidence.every(
        (relation) =>
          relation !== undefined &&
          relation.contractRef === port.contractId &&
          (isInput
            ? relation.toNodeId === port.nodeId &&
              belongsToPlannedAgent(relation.toNodeId) &&
              ownershipRoot(relation.fromNodeId) !== brief.plannedAgentId
            : relation.fromNodeId === port.nodeId &&
              belongsToPlannedAgent(relation.fromNodeId) &&
              ownershipRoot(relation.toNodeId) !== brief.plannedAgentId),
      );
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
          dependency.contractIds.length > 0 &&
          counterpartToOwn.length === evidence.length
        : dependency.kind === "provides-input"
          ? dependency.direction === "downstream" &&
            dependency.contractIds.length > 0 &&
            ownToCounterpart.length === evidence.length
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
      !supported ||
      !contractsLinked
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
    briefs: readonly AgentBriefVersionRecord[],
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
    const briefsByAgent = new Map<PlanNodeId, AgentBriefVersionRecord>();
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
  brief: AgentBriefVersionRecord,
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
