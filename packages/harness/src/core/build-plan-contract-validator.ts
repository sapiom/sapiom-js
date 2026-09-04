import type { AgentMapGraph, PlanNodeId, PlanRelationship } from "../shared/agent-map.js";
import type {
  BuildPlanDiagnostic,
  BuildPlanDependencyIntent,
  ProjectBuildPlanContent,
} from "../shared/build-plan.js";

export const BUILD_PLAN_DIAGNOSTIC_LIMIT = 64;

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const issue = (
  code: BuildPlanDiagnostic["code"],
  severity: BuildPlanDiagnostic["severity"],
  path: string,
  relatedIds: readonly string[] = [],
): BuildPlanDiagnostic => ({ code, severity, path: path.slice(0, 512), relatedIds: [...relatedIds].sort(compare).slice(0, 16) });

const effectiveFlow = (relationship: PlanRelationship) =>
  relationship.kind === "reads"
    ? { from: relationship.toNodeId, to: relationship.fromNodeId }
    : relationship.kind === "uses"
      ? null
      : { from: relationship.fromNodeId, to: relationship.toNodeId };

export function validateProjectBuildPlanContent(
  content: ProjectBuildPlanContent,
  graph: AgentMapGraph,
  activeBriefIds: ReadonlySet<string> = new Set(),
): BuildPlanDiagnostic[] {
  const diagnostics: BuildPlanDiagnostic[] = [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const relationships = new Map<string, PlanRelationship>(graph.relationships.map((relationship) => [relationship.id, relationship]));
  const ownershipRoot = (nodeId: PlanNodeId): PlanNodeId | null => {
    const seen = new Set<PlanNodeId>();
    let current = nodes.get(nodeId);
    while (current) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      if (current.ownerAgentId === null) return current.kind === "agent" ? current.id : null;
      current = nodes.get(current.ownerAgentId);
    }
    return null;
  };
  const topAgents = graph.nodes.filter(({ kind, ownerAgentId }) => kind === "agent" && ownerAgentId === null);
  const assigned = new Set(content.assignments.map(({ plannedAgentId }) => plannedAgentId));
  for (const agent of topAgents) {
    if (!assigned.has(agent.id)) diagnostics.push(issue("missing-assignment", "warning", "assignments", [agent.id]));
  }

  const milestoneIds = new Set(content.milestones.map(({ id }) => id));
  const milestoneOrdinals = new Set<number>();
  content.milestones.forEach((milestone, index) => {
    if (milestoneOrdinals.has(milestone.ordinal))
      diagnostics.push(issue("duplicate-ordinal", "error", `milestones[${index}].ordinal`, [milestone.id]));
    milestoneOrdinals.add(milestone.ordinal);
    milestone.dependsOn.forEach((dependency, dependencyIndex) => {
      if (!milestoneIds.has(dependency) || dependency === milestone.id)
        diagnostics.push(issue("invalid-milestone-dependency", "error", `milestones[${index}].dependsOn[${dependencyIndex}]`, [milestone.id, dependency]));
    });
  });
  const gateOrdinals = new Set<number>();
  content.sequenceGates.forEach((gate, index) => {
    if (gateOrdinals.has(gate.ordinal))
      diagnostics.push(issue("duplicate-ordinal", "error", `sequenceGates[${index}].ordinal`, [gate.id]));
    gateOrdinals.add(gate.ordinal);
    gate.milestoneIds.forEach((milestoneId, item) => {
      if (!milestoneIds.has(milestoneId))
        diagnostics.push(issue("invalid-milestone-dependency", "error", `sequenceGates[${index}].milestoneIds[${item}]`, [gate.id, milestoneId]));
    });
  });

  const validatePlannedAgent = (nodeId: PlanNodeId, path: string, code: BuildPlanDiagnostic["code"]) => {
    const node = nodes.get(nodeId);
    if (!node || node.kind !== "agent" || node.ownerAgentId !== null)
      diagnostics.push(issue(code, "error", path, [nodeId]));
  };
  content.repositoryIntents.forEach((intent, index) =>
    validatePlannedAgent(intent.plannedAgentId, `repositoryIntents[${index}].plannedAgentId`, "invalid-repository-owner"));

  const dependencyEvidenceValid = (
    dependency: BuildPlanDependencyIntent,
    plannedAgentId: PlanNodeId,
  ): boolean => {
    const target = nodes.get(dependency.nodeId);
    if (!target || dependency.relationshipIds.length === 0) return false;
    const evidence = dependency.relationshipIds.map((id) => relationships.get(id));
    if (evidence.some((relationship) => !relationship ||
      (dependency.contractRef !== null && relationship.contractRef !== dependency.contractRef))) return false;
    if (dependency.kind === "shared-resource") {
      if (!["resource", "artifact", "connector"].includes(target.kind)) return false;
      return evidence.every((relationship) => relationship !== undefined &&
        ["reads", "writes", "uses"].includes(relationship.kind) &&
        relationship.toNodeId === dependency.nodeId && ownershipRoot(relationship.fromNodeId) === plannedAgentId);
    }
    if (dependency.kind === "depends-on" &&
      (target.kind !== "agent" || target.ownerAgentId !== null || target.id === plannedAgentId)) return false;
    const flows = evidence.map((relationship) => relationship ? effectiveFlow(relationship) : null);
    if (flows.some((flow) => flow === null)) return false;
    const owned = (nodeId: PlanNodeId) => ownershipRoot(nodeId) === plannedAgentId;
    const targetSide = (nodeId: PlanNodeId) => nodeId === dependency.nodeId || ownershipRoot(nodeId) === dependency.nodeId;
    if (dependency.kind === "input" || dependency.kind === "depends-on")
      return flows.some((flow) => flow !== null && targetSide(flow.from) && owned(flow.to));
    return flows.some((flow) => flow !== null && owned(flow.from) && targetSide(flow.to));
  };

  content.assignments.forEach((assignment, index) => {
    validatePlannedAgent(assignment.plannedAgentId, `assignments[${index}].plannedAgentId`, "unknown-node-reference");
    if (assignment.briefId === null || !activeBriefIds.has(assignment.briefId))
      diagnostics.push(issue("missing-brief", "warning", `assignments[${index}].briefId`, [assignment.id]));
    assignment.dependencies.forEach((dependency, dependencyIndex) => {
      if (!dependencyEvidenceValid(dependency, assignment.plannedAgentId))
        diagnostics.push(issue("invalid-dependency", "error", `assignments[${index}].dependencies[${dependencyIndex}]`, [assignment.id, dependency.id, dependency.nodeId]));
    });
  });
  [...content.decisions, ...content.unresolvedDecisions].forEach((decision, index) => {
    if (decision.status === "open") diagnostics.push(issue("unresolved-decision", "warning", `decisions[${index}]`, [decision.id]));
  });

  const unique = new Map<string, BuildPlanDiagnostic>();
  for (const diagnostic of diagnostics)
    unique.set(JSON.stringify([diagnostic.path, diagnostic.code, diagnostic.relatedIds]), diagnostic);
  return [...unique.values()].sort((left, right) =>
    compare(left.path, right.path) || compare(left.code, right.code) ||
    compare(left.relatedIds.join("\0"), right.relatedIds.join("\0"))).slice(0, BUILD_PLAN_DIAGNOSTIC_LIMIT);
}
