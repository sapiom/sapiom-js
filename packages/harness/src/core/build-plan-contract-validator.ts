import type { AgentMapGraph, PlanNodeId } from "../shared/agent-map.js";
import type {
  AgentBriefVersionRecord,
  ArchitectureSourceRef,
  BriefFreshness,
  BuildPlanCompleteness,
  BuildPlanDiagnostic,
  BuildPlanEligibility,
  ProjectBuildPlanVersion,
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
const sameSource = (
  left: ArchitectureSourceRef,
  right: ArchitectureSourceRef,
) => JSON.stringify(left) === JSON.stringify(right);

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
  if (!sameSource(brief.source, plan.source))
    issues.push(
      diagnostic("source-digest-mismatch", `${prefix}.source`, [brief.briefId]),
    );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const relationships = new Map(
    graph.relationships.map((entry) => [entry.id, entry]),
  );
  const knownContracts = new Set([
    ...graph.nodes.flatMap((node) => node.contractRefs),
    ...graph.relationships.flatMap((entry) =>
      entry.contractRef === null ? [] : [entry.contractRef],
    ),
  ]);
  const owned = new Set(brief.ownedNodeIds);
  const belongsToPlannedAgent = (nodeId: PlanNodeId): boolean => {
    const visited = new Set<PlanNodeId>();
    let current = nodes.get(nodeId);
    while (current && current.ownerAgentId !== null) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      current = nodes.get(current.ownerAgentId);
    }
    return current?.id === brief.plannedAgentId;
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
    if (!nodes.has(port.nodeId))
      issues.push(
        diagnostic(
          "unknown-node-reference",
          `${prefix}.ports[${portIndex}].nodeId`,
          [port.nodeId],
        ),
      );
    if (!knownContracts.has(port.contractId))
      issues.push(
        diagnostic(
          "invalid-dependency",
          `${prefix}.ports[${portIndex}].contractId`,
          [port.contractId],
        ),
      );
    port.relationshipIds.forEach((id) => {
      const relation = relationships.get(id);
      const isInput = portIndex < brief.inputs.length;
      if (
        !relation ||
        (isInput
          ? !owned.has(relation.toNodeId)
          : !owned.has(relation.fromNodeId))
      )
        issues.push(
          diagnostic(
            "incompatible-contract-direction",
            `${prefix}.ports[${portIndex}].relationshipIds`,
            [id],
          ),
        );
    });
  });
  brief.dependencies.forEach((dependency, dependencyIndex) => {
    const counterpart = nodes.get(dependency.counterpartAgentId);
    const supported = dependency.relationshipIds.every((id) => {
      const relation = relationships.get(id);
      return (
        relation &&
        ((owned.has(relation.fromNodeId) &&
          relation.toNodeId === dependency.counterpartAgentId) ||
          (owned.has(relation.toNodeId) &&
            relation.fromNodeId === dependency.counterpartAgentId))
      );
    });
    const contractsExist = dependency.contractIds.every((id) =>
      knownContracts.has(id),
    );
    if (
      !counterpart ||
      counterpart.kind !== "agent" ||
      !supported ||
      !contractsExist
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
  if (sameSource(brief.source, evaluatedAgainst))
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
