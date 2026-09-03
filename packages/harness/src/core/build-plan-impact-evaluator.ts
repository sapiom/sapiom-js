import type { AgentMapGraph, PlanNodeId } from "../shared/agent-map.js";
import type {
  AgentBriefId,
  AgentBriefVersionRecord,
  AssignmentImpact,
  BriefStaleReason,
  BuildPlanImpactEvaluator,
  BuildPlanImpactResult,
  DependencyFingerprint,
  DependencyFingerprintKind,
  ImpactDigest,
  PlanContractId,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import type { PlanRelationshipId } from "../shared/agent-map.js";
import {
  canonicalJson,
  computeCanonicalDigest,
} from "./build-plan-canonicalization.js";

const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const unique = <T extends string>(values: readonly T[]): T[] =>
  [...new Set(values)].sort(compare);
const planRef = (plan: ProjectBuildPlanVersion) => ({
  planId: plan.planId,
  version: plan.version,
  semanticDigest: plan.semanticDigest,
});

const reasonCode = (
  kind: DependencyFingerprintKind,
): BriefStaleReason["code"] => {
  switch (kind) {
    case "owned-nodes":
      return "ownership-changed";
    case "input-contracts":
    case "output-contracts":
      return "contract-changed";
    case "cross-agent-relationships":
      return "relationship-changed";
    case "relevant-nodes":
    case "shared-resources":
      return "relevant-node-changed";
    case "milestones":
    case "shared-plan-content":
      return "shared-plan-content-changed";
    case "assignment-content":
      return "assignment-content-changed";
  }
};

function graphChanges(previous: AgentMapGraph, next: AgentMapGraph) {
  const changed = <T extends { id: string }>(
    left: readonly T[],
    right: readonly T[],
    project: (entry: T) => unknown = (entry) => entry,
  ): string[] => {
    const leftIndex = new Map(left.map((entry) => [entry.id, entry]));
    const rightIndex = new Map(right.map((entry) => [entry.id, entry]));
    return unique([...leftIndex.keys(), ...rightIndex.keys()]).filter(
      (id) =>
        canonicalJson(
          leftIndex.get(id) ? project(leftIndex.get(id)!) : null,
        ) !==
        canonicalJson(rightIndex.get(id) ? project(rightIndex.get(id)!) : null),
    );
  };
  const changedNodeIds = changed(previous.nodes, next.nodes, (node) => ({
    ...node,
    contractRefs: [...node.contractRefs].sort(compare),
  })) as PlanNodeId[];
  const changedRelationshipIds = changed(
    previous.relationships,
    next.relationships,
  ) as unknown as PlanRelationshipId[];
  const contracts = (graph: AgentMapGraph) => {
    const result = new Map<string, unknown[]>();
    const add = (id: string, value: unknown) =>
      result.set(id, [...(result.get(id) ?? []), value]);
    graph.nodes.forEach((node) =>
      node.contractRefs.forEach((id) =>
        add(id, {
          nodeId: node.id,
          kind: node.kind,
          ownerAgentId: node.ownerAgentId,
        }),
      ),
    );
    graph.relationships.forEach((relationship) => {
      if (relationship.contractRef)
        add(relationship.contractRef, {
          relationshipId: relationship.id,
          fromNodeId: relationship.fromNodeId,
          toNodeId: relationship.toNodeId,
          kind: relationship.kind,
          executionMode: relationship.executionMode,
          description: relationship.description,
        });
    });
    result.forEach((entries, id) =>
      result.set(
        id,
        [...entries].sort((left, right) =>
          compare(canonicalJson(left), canonicalJson(right)),
        ),
      ),
    );
    return result;
  };
  const previousContracts = contracts(previous);
  const nextContracts = contracts(next);
  const changedContractIds = unique([
    ...previousContracts.keys(),
    ...nextContracts.keys(),
  ]).filter(
    (id) =>
      canonicalJson(previousContracts.get(id) ?? []) !==
      canonicalJson(nextContracts.get(id) ?? []),
  ) as unknown as PlanContractId[];
  return { changedNodeIds, changedRelationshipIds, changedContractIds };
}

function fingerprintReasons(
  previous: AgentBriefVersionRecord,
  next: AgentBriefVersionRecord,
): BriefStaleReason[] {
  const previousIndex = new Map(
    previous.dependencyFingerprints.map((entry) => [entry.kind, entry]),
  );
  const nextIndex = new Map(
    next.dependencyFingerprints.map((entry) => [entry.kind, entry]),
  );
  return unique([...previousIndex.keys(), ...nextIndex.keys()]).flatMap(
    (kind) => {
      const before = previousIndex.get(kind);
      const after = nextIndex.get(kind);
      if (before?.digest === after?.digest) return [];
      const entries = [before, after].filter(
        (entry): entry is DependencyFingerprint => entry !== undefined,
      );
      return [
        {
          code: reasonCode(kind),
          affectedNodeIds: unique(entries.flatMap((entry) => entry.nodeIds)),
          affectedRelationshipIds: unique(
            entries.flatMap((entry) => entry.relationshipIds),
          ),
          affectedContractIds: unique(
            entries.flatMap((entry) => entry.contractIds),
          ),
          ...(before ? { previousFingerprint: before.digest } : {}),
          ...(after ? { currentFingerprint: after.digest } : {}),
        },
      ];
    },
  );
}

export function evaluateBuildPlanImpact(input: {
  previousSource: ProjectBuildPlanVersion["source"];
  nextSource: ProjectBuildPlanVersion["source"];
  briefs: readonly AgentBriefVersionRecord[];
  previousPlan: ProjectBuildPlanVersion;
  nextPlan: ProjectBuildPlanVersion;
  previousGraph: AgentMapGraph;
  nextGraph: AgentMapGraph;
  nextBriefs: readonly AgentBriefVersionRecord[];
}): BuildPlanImpactResult {
  const previous = new Map(
    input.briefs.map((brief) => [brief.plannedAgentId, brief]),
  );
  const next = new Map(
    input.nextBriefs.map((brief) => [brief.plannedAgentId, brief]),
  );
  const previousAgentIds = unique([...previous.keys()]);
  const nextAgentIds = unique([...next.keys()]);
  const addedAgentIds = nextAgentIds.filter((id) => !previous.has(id));
  const removedAgentIds = previousAgentIds.filter((id) => !next.has(id));
  const changes = graphChanges(input.previousGraph, input.nextGraph);
  const staleBriefIds: AgentBriefId[] = [];
  const preservedBriefIds: AgentBriefId[] = [];
  const assignmentChanges: AssignmentImpact[] = [];

  for (const plannedAgentId of unique([...previousAgentIds, ...nextAgentIds])) {
    const before = previous.get(plannedAgentId);
    const after = next.get(plannedAgentId);
    if (!before && after) {
      assignmentChanges.push({
        plannedAgentId,
        assignmentId: after.assignmentId,
        briefId: after.briefId,
        disposition: "added",
        reasons: [
          {
            code: "agent-added",
            affectedNodeIds: [plannedAgentId],
            affectedRelationshipIds: [],
            affectedContractIds: [],
          },
        ],
      });
      continue;
    }
    if (before && !after) {
      staleBriefIds.push(before.briefId);
      assignmentChanges.push({
        plannedAgentId,
        assignmentId: before.assignmentId,
        briefId: before.briefId,
        disposition: "removed",
        reasons: [
          {
            code: "agent-removed",
            affectedNodeIds: [plannedAgentId],
            affectedRelationshipIds: [],
            affectedContractIds: [],
          },
        ],
      });
      continue;
    }
    const reasons = fingerprintReasons(before!, after!);
    const presentationChanged =
      reasons.length === 0 &&
      changes.changedNodeIds.some(
        (id) =>
          before!.ownedNodeIds.includes(id) ||
          before!.relevantNodeIds.includes(id),
      );
    if (reasons.length) staleBriefIds.push(before!.briefId);
    else preservedBriefIds.push(before!.briefId);
    assignmentChanges.push({
      plannedAgentId,
      assignmentId: after!.assignmentId,
      briefId: after!.briefId,
      disposition: reasons.length
        ? "stale"
        : presentationChanged
          ? "presentation-refreshed"
          : "preserved",
      reasons,
    });
  }

  const withoutDigest = {
    from: { source: input.previousSource, plan: planRef(input.previousPlan) },
    to: { source: input.nextSource, plan: planRef(input.nextPlan) },
    assignmentChanges,
    staleBriefIds: unique(staleBriefIds),
    preservedBriefIds: unique(preservedBriefIds),
    addedAgentIds,
    removedAgentIds,
    ...changes,
    semanticChange:
      addedAgentIds.length > 0 ||
      removedAgentIds.length > 0 ||
      assignmentChanges.some((entry) => entry.reasons.length > 0),
  };
  return {
    ...withoutDigest,
    digest: computeCanonicalDigest(
      "sapiom.build-plan-impact.v1",
      withoutDigest,
    ) as ImpactDigest,
  };
}

export class CanonicalBuildPlanImpactEvaluator implements BuildPlanImpactEvaluator {
  evaluate(
    input: Parameters<BuildPlanImpactEvaluator["evaluate"]>[0],
  ): BuildPlanImpactResult {
    if (
      !input.previousPlan ||
      !input.nextPlan ||
      !input.previousGraph ||
      !input.nextGraph ||
      !input.nextBriefs
    )
      throw new Error(
        "canonical impact evaluation requires exact plans and graphs",
      );
    return evaluateBuildPlanImpact({
      ...input,
      previousPlan: input.previousPlan,
      nextPlan: input.nextPlan,
      previousGraph: input.previousGraph,
      nextGraph: input.nextGraph,
      nextBriefs: input.nextBriefs,
    });
  }
}
