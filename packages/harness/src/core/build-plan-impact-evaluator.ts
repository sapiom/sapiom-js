import type { AgentMapGraph, PlanNodeId } from "../shared/agent-map.js";
import type {
  AgentBriefId,
  AssignmentImpact,
  BriefStaleReason,
  BuildPlanImpactEvaluator,
  BuildPlanImpactResult,
  DependencyFingerprint,
  DependencyFingerprintKind,
  ImpactDigest,
  PersistedAgentBriefVersionRecord,
  PlanContractId,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import {
  BUILD_PLAN_IMPACT_ID_LIST_LIMIT,
  BUILD_PLAN_IMPACT_REASON_ID_LIMIT,
  BUILD_PLAN_MAX_IMPACT_BYTES,
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
  return {
    changedNodeIds: changedNodeIds.slice(0, BUILD_PLAN_IMPACT_ID_LIST_LIMIT),
    changedRelationshipIds: changedRelationshipIds.slice(
      0,
      BUILD_PLAN_IMPACT_ID_LIST_LIMIT,
    ),
    changedContractIds: changedContractIds.slice(
      0,
      BUILD_PLAN_IMPACT_ID_LIST_LIMIT,
    ),
  };
}

function fingerprintReasons(
  previous: PersistedAgentBriefVersionRecord,
  next: PersistedAgentBriefVersionRecord,
  changes: ReturnType<typeof graphChanges>,
): BriefStaleReason[] {
  if (previous.schemaVersion === 1 || next.schemaVersion === 1)
    return previous.semanticDigest === next.semanticDigest
      ? []
      : [
          {
            code: "assignment-content-changed",
            affectedNodeIds: [next.plannedAgentId],
            affectedRelationshipIds: [],
            affectedContractIds: [],
            previousFingerprint: previous.semanticDigest,
            currentFingerprint: next.semanticDigest,
          },
        ];
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
      const graphDerived = ![
        "milestones",
        "shared-plan-content",
        "assignment-content",
      ].includes(kind);
      const affected = <T extends string>(
        values: readonly T[],
        changed: readonly string[],
      ) => {
        const canonical = unique(values);
        return (
          graphDerived
            ? canonical.filter((id) => changed.includes(id))
            : canonical
        ).slice(0, BUILD_PLAN_IMPACT_REASON_ID_LIMIT);
      };
      return [
        {
          code: reasonCode(kind),
          affectedNodeIds: affected(
            entries.flatMap((entry) => entry.nodeIds),
            changes.changedNodeIds,
          ),
          affectedRelationshipIds: affected(
            entries.flatMap((entry) => entry.relationshipIds),
            changes.changedRelationshipIds,
          ),
          affectedContractIds: affected(
            entries.flatMap((entry) => entry.contractIds),
            changes.changedContractIds,
          ),
          ...(before ? { previousFingerprint: before.digest } : {}),
          ...(after ? { currentFingerprint: after.digest } : {}),
        },
      ];
    },
  );
}

type ImpactWithoutDigest = Omit<BuildPlanImpactResult, "digest">;

function sealImpact(value: ImpactWithoutDigest): BuildPlanImpactResult {
  return {
    ...value,
    digest: computeCanonicalDigest(
      "sapiom.build-plan-impact.v1",
      value,
    ) as ImpactDigest,
  };
}

function projectImpact(
  value: ImpactWithoutDigest,
  options: Readonly<{
    includeFingerprints: boolean;
    reasonIdLimit: number;
    changedIdLimit: number;
  }>,
): ImpactWithoutDigest {
  return {
    ...value,
    assignmentChanges: value.assignmentChanges.map((assignment) => ({
      ...assignment,
      reasons: assignment.reasons.map((reason) => ({
        code: reason.code,
        affectedNodeIds: reason.affectedNodeIds.slice(0, options.reasonIdLimit),
        affectedRelationshipIds: reason.affectedRelationshipIds.slice(
          0,
          options.reasonIdLimit,
        ),
        affectedContractIds: reason.affectedContractIds.slice(
          0,
          options.reasonIdLimit,
        ),
        ...(options.includeFingerprints && reason.previousFingerprint
          ? { previousFingerprint: reason.previousFingerprint }
          : {}),
        ...(options.includeFingerprints && reason.currentFingerprint
          ? { currentFingerprint: reason.currentFingerprint }
          : {}),
      })),
    })),
    changedNodeIds: value.changedNodeIds.slice(0, options.changedIdLimit),
    changedRelationshipIds: value.changedRelationshipIds.slice(
      0,
      options.changedIdLimit,
    ),
    changedContractIds: value.changedContractIds.slice(
      0,
      options.changedIdLimit,
    ),
  };
}

/**
 * Keep every affected assignment, disposition, and reason code while reducing
 * repeated evidence deterministically enough to fit an idempotency receipt.
 */
function boundBuildPlanImpact(
  value: ImpactWithoutDigest,
): BuildPlanImpactResult {
  const fits = (candidate: BuildPlanImpactResult) =>
    Buffer.byteLength(canonicalJson(candidate), "utf8") <=
    BUILD_PLAN_MAX_IMPACT_BYTES;
  const exact = sealImpact(value);
  if (fits(exact)) return exact;

  for (const reasonIdLimit of [16, 8, 4, 2, 1, 0]) {
    const candidate = sealImpact(
      projectImpact(value, {
        includeFingerprints: false,
        reasonIdLimit,
        changedIdLimit: BUILD_PLAN_IMPACT_ID_LIST_LIMIT,
      }),
    );
    if (fits(candidate)) return candidate;
  }
  for (const changedIdLimit of [64, 32, 16, 8, 4, 2, 1, 0]) {
    const candidate = sealImpact(
      projectImpact(value, {
        includeFingerprints: false,
        reasonIdLimit: 0,
        changedIdLimit,
      }),
    );
    if (fits(candidate)) return candidate;
  }
  const evidenceFree = sealImpact(
    projectImpact(value, {
      includeFingerprints: false,
      reasonIdLimit: 0,
      changedIdLimit: 0,
    }),
  );
  if (!fits(evidenceFree))
    throw new Error("canonical build-plan impact exceeds its byte budget");
  return evidenceFree;
}

export function evaluateBuildPlanImpact(input: {
  previousSource: ProjectBuildPlanVersion["source"];
  nextSource: ProjectBuildPlanVersion["source"];
  briefs: readonly PersistedAgentBriefVersionRecord[];
  previousPlan: ProjectBuildPlanVersion;
  nextPlan: ProjectBuildPlanVersion;
  previousGraph: AgentMapGraph;
  nextGraph: AgentMapGraph;
  nextBriefs: readonly PersistedAgentBriefVersionRecord[];
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
    const reasons = fingerprintReasons(before!, after!, changes);
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
  return boundBuildPlanImpact(withoutDigest);
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
