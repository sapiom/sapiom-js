import { createHash } from "node:crypto";

import type { AgentMapGraph } from "../shared/agent-map.js";
import type {
  AgentBriefSemanticDigest,
  AgentBriefVersionRecord,
  BuildPlanImpactResult,
  BuildPlanSemanticDigest,
  BuilderPlanningSubmission,
  GraphDigest,
  ImpactDigest,
  PlanningSubmissionDigest,
  PlanningAssignmentRecord,
  PersistedAgentBriefVersionRecord,
  ProjectBuildPlanVersion,
  RecordDigest,
} from "../shared/build-plan.js";
import { canonicalizeAgentMapGraph } from "./agent-map-proposal-validator.js";

const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const by = <T>(value: readonly T[], key: (entry: T) => string): T[] =>
  [...value].sort((left, right) => compare(key(left), key(right)));
const ordered = <T extends { ordinal: number }>(value: readonly T[]): T[] =>
  [...value].sort((left, right) => left.ordinal - right.ordinal);
const lines = (value: string): string => value.replace(/\r\n?/gu, "\n");
const omit = <T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;

function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") return lines(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, field]) => [key, canonicalValue(field)]),
    );
  return value;
}

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

export const computeCanonicalDigest = (
  domain: string,
  value: unknown,
): string =>
  `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex")}`;

const decision = <T extends { decisionId: string }>(entries: readonly T[]) =>
  by(entries, (entry) => entry.decisionId);
const constraints = <T extends { constraintId: string }>(
  entries: readonly T[],
) => by(entries, (entry) => entry.constraintId);
const deliverables = <
  T extends {
    deliverableId: string;
    artifactNodeIds: readonly string[];
    acceptanceCriterionIds: readonly string[];
  },
>(
  entries: readonly T[],
) =>
  by(entries, (entry) => entry.deliverableId).map((entry) => ({
    ...entry,
    artifactNodeIds: [...entry.artifactNodeIds].sort(compare),
    acceptanceCriterionIds: [...entry.acceptanceCriterionIds].sort(compare),
  }));

export function buildPlanSemanticProjection(plan: ProjectBuildPlanVersion) {
  return {
    schemaVersion: plan.schemaVersion,
    projectId: plan.projectId,
    planId: plan.planId,
    outcome: plan.outcome,
    milestones: ordered(plan.milestones).map((milestone) => ({
      ...milestone,
      dependsOn: [...milestone.dependsOn].sort(compare),
    })),
    sharedConstraints: constraints(plan.sharedConstraints),
    repositoryIntents: by(
      plan.repositoryIntents,
      (entry) => entry.repositoryIntentId,
    ),
    integrationCriteria: ordered(plan.integrationCriteria),
    assignments: by(plan.assignments, (entry) => entry.plannedAgentId).map(
      (assignment) => ({
        ...assignment,
        scope: {
          inScope: [...assignment.scope.inScope].sort(compare),
          nonGoals: [...assignment.scope.nonGoals].sort(compare),
        },
        deliverables: deliverables(assignment.deliverables),
        constraints: constraints(assignment.constraints),
        acceptanceCriteria: ordered(assignment.acceptanceCriteria),
        milestoneIds: [...assignment.milestoneIds].sort(compare),
        unresolvedDecisions: decision(assignment.unresolvedDecisions),
      }),
    ),
    unresolvedDecisions: decision(plan.unresolvedDecisions),
  };
}

export const computeBuildPlanSemanticDigest = (
  plan: ProjectBuildPlanVersion,
): BuildPlanSemanticDigest =>
  computeCanonicalDigest(
    "sapiom.build-plan.semantic.v1",
    buildPlanSemanticProjection(plan),
  ) as BuildPlanSemanticDigest;

export const computeBuildPlanRecordDigest = (
  plan: ProjectBuildPlanVersion,
): RecordDigest =>
  computeCanonicalDigest(
    "sapiom.build-plan.record.v1",
    omit(plan, ["recordDigest"]),
  ) as RecordDigest;

export const computeBuildPlanImpactDigest = (
  impact: BuildPlanImpactResult | Omit<BuildPlanImpactResult, "digest">,
): ImpactDigest =>
  computeCanonicalDigest(
    "sapiom.build-plan-impact.v1",
    "digest" in impact ? omit(impact, ["digest"]) : impact,
  ) as ImpactDigest;

/** Exact digest projection used by immutable v1 records. */
export function legacyAgentBriefSemanticProjection(
  brief: Extract<PersistedAgentBriefVersionRecord, { schemaVersion: 1 }>,
) {
  return {
    schemaVersion: brief.schemaVersion,
    projectId: brief.projectId,
    plannedAgentId: brief.plannedAgentId,
    plan: {
      planId: brief.plan.planId,
      semanticDigest: brief.plan.semanticDigest,
    },
    mission: brief.mission,
    scope: {
      inScope: [...brief.scope.inScope].sort(compare),
      nonGoals: [...brief.scope.nonGoals].sort(compare),
    },
    ownedNodeIds: [...brief.ownedNodeIds].sort(compare),
    relevantNodeIds: [...brief.relevantNodeIds].sort(compare),
    inputs: by(
      brief.inputs,
      (entry) => `${entry.contractId}\0${entry.nodeId}`,
    ).map((entry) => ({
      ...entry,
      relationshipIds: [...entry.relationshipIds].sort(compare),
    })),
    outputs: by(
      brief.outputs,
      (entry) => `${entry.contractId}\0${entry.nodeId}`,
    ).map((entry) => ({
      ...entry,
      relationshipIds: [...entry.relationshipIds].sort(compare),
    })),
    dependencies: by(brief.dependencies, (entry) => entry.dependencyId).map(
      (entry) => ({
        ...entry,
        relationshipIds: [...entry.relationshipIds].sort(compare),
        contractIds: [...entry.contractIds].sort(compare),
        requiredByMilestoneIds: [...entry.requiredByMilestoneIds].sort(compare),
      }),
    ),
    deliverables: deliverables(brief.deliverables),
    acceptanceCriteria: ordered(brief.acceptanceCriteria),
    constraints: constraints(brief.constraints),
    milestones: [...brief.milestones].sort(compare),
    unresolvedDecisions: decision(brief.unresolvedDecisions),
    changeProtocol: {
      ...brief.changeProtocol,
      instructions: [...brief.changeProtocol.instructions],
    },
  };
}

export function agentBriefSemanticProjection(brief: AgentBriefVersionRecord) {
  return {
    schemaVersion: brief.schemaVersion,
    digestVersion: brief.digestVersion,
    projectId: brief.projectId,
    plannedAgentId: brief.plannedAgentId,
    plan: { planId: brief.plan.planId },
    mission: brief.mission,
    scope: {
      inScope: [...brief.scope.inScope].sort(compare),
      nonGoals: [...brief.scope.nonGoals].sort(compare),
    },
    ownedNodeIds: [...brief.ownedNodeIds].sort(compare),
    relevantNodeIds: [...brief.relevantNodeIds].sort(compare),
    inputs: by(
      brief.inputs,
      (entry) => `${entry.contractId}\0${entry.nodeId}`,
    ).map((entry) => ({
      ...entry,
      relationshipIds: [...entry.relationshipIds].sort(compare),
      ...(entry.executionModes
        ? { executionModes: [...entry.executionModes].sort(compare) }
        : {}),
    })),
    outputs: by(
      brief.outputs,
      (entry) => `${entry.contractId}\0${entry.nodeId}`,
    ).map((entry) => ({
      ...entry,
      relationshipIds: [...entry.relationshipIds].sort(compare),
      ...(entry.executionModes
        ? { executionModes: [...entry.executionModes].sort(compare) }
        : {}),
    })),
    dependencies: by(brief.dependencies, (entry) => entry.dependencyId).map(
      (entry) => ({
        ...entry,
        relationshipIds: [...entry.relationshipIds].sort(compare),
        contractIds: [...entry.contractIds].sort(compare),
        requiredByMilestoneIds: [...entry.requiredByMilestoneIds].sort(compare),
      }),
    ),
    deliverables: deliverables(brief.deliverables),
    acceptanceCriteria: ordered(brief.acceptanceCriteria),
    constraints: constraints(brief.constraints),
    milestones: [...brief.milestones].sort(compare),
    unresolvedDecisions: decision(brief.unresolvedDecisions),
    changeProtocol: {
      ...brief.changeProtocol,
      instructions: [...brief.changeProtocol.instructions],
    },
    compilerVersion: brief.compilerVersion,
    dependencyFingerprints: by(
      brief.dependencyFingerprints,
      (entry) => entry.kind,
    ).map((entry) => ({
      ...entry,
      nodeIds: [...entry.nodeIds].sort(compare),
      relationshipIds: [...entry.relationshipIds].sort(compare),
      contractIds: [...entry.contractIds].sort(compare),
    })),
  };
}

export const computeAgentBriefSemanticDigest = (
  brief: PersistedAgentBriefVersionRecord,
): AgentBriefSemanticDigest => {
  if (brief.schemaVersion === 1)
    return computeCanonicalDigest(
      "sapiom.agent-brief.semantic.v1",
      legacyAgentBriefSemanticProjection(brief),
    ) as AgentBriefSemanticDigest;
  return computeCanonicalDigest(
    "sapiom.agent-brief.semantic.v2",
    agentBriefSemanticProjection(brief),
  ) as AgentBriefSemanticDigest;
};

export const computeAgentBriefRecordDigest = (
  brief: PersistedAgentBriefVersionRecord,
): RecordDigest =>
  computeCanonicalDigest(
    brief.schemaVersion === 1
      ? "sapiom.agent-brief.record.v1"
      : "sapiom.agent-brief.record.v2",
    omit(brief, ["recordDigest"]),
  ) as RecordDigest;

export const computePlanningSubmissionSemanticDigest = (
  submission: BuilderPlanningSubmission,
): PlanningSubmissionDigest => {
  const meaning = omit(submission, [
    "submissionId",
    "sessionId",
    "requestId",
    "requestDigest",
    "submittedAt",
    "supersedesSubmissionId",
    "semanticDigest",
    "recordDigest",
    "source",
  ]);
  return computeCanonicalDigest("sapiom.planning-submission.semantic.v1", {
    ...meaning,
    plan: {
      planId: submission.plan.planId,
      semanticDigest: submission.plan.semanticDigest,
    },
    brief: {
      briefId: submission.brief.briefId,
      semanticDigest: submission.brief.semanticDigest,
    },
    implementationPlan: ordered(submission.implementationPlan),
    risks: by(submission.risks, (entry) => entry.riskId),
    questions: by(submission.questions, (entry) => entry.questionId),
    proposedMapOperationIds: [...submission.proposedMapOperationIds].sort(
      compare,
    ),
  }) as PlanningSubmissionDigest;
};

export const computePlanningSubmissionRecordDigest = (
  submission: BuilderPlanningSubmission,
): RecordDigest =>
  computeCanonicalDigest(
    "sapiom.planning-submission.record.v1",
    omit(submission, ["recordDigest"]),
  ) as RecordDigest;

export const computePlanningAssignmentRecordDigest = (
  assignment: PlanningAssignmentRecord,
): RecordDigest =>
  computeCanonicalDigest(
    "sapiom.planning-assignment.record.v1",
    omit(assignment, ["recordDigest"]),
  ) as RecordDigest;

export const computeArchitectureGraphDigest = (
  graph: AgentMapGraph,
): GraphDigest =>
  computeCanonicalDigest(
    "sapiom.agent-map.graph.v1",
    canonicalizeAgentMapGraph(graph),
  ) as GraphDigest;
