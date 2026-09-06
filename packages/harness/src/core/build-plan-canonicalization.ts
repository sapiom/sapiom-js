import type {
  AgentBriefSemanticDigest,
  AgentBriefVersion,
  BuildPlanSemanticDigest,
  ProjectBuildPlanContent,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import type { RecordDigest } from "../shared/agent-map.js";
import {
  canonicalDigest,
  canonicalJson,
  compareCanonicalStrings,
} from "../shared/agent-map-canonical.js";

export { canonicalJson };

const strings = <T extends string>(values: readonly T[]): T[] =>
  [...values].sort(compareCanonicalStrings);
const byId = <T extends { id: string }>(values: readonly T[]): T[] =>
  [...values].sort((left, right) => compareCanonicalStrings(left.id, right.id));
const ordered = <T extends { id: string; ordinal: number }>(
  values: readonly T[],
): T[] =>
  [...values].sort(
    (left, right) =>
      left.ordinal - right.ordinal || compareCanonicalStrings(left.id, right.id),
  );

function assertDistinctOrdinals(
  values: readonly { ordinal: number }[],
  field: string,
): void {
  if (new Set(values.map(({ ordinal }) => ordinal)).size !== values.length)
    throw new TypeError(`duplicate ${field} ordinal`);
}

export function canonicalizeProjectBuildPlanContent(
  content: ProjectBuildPlanContent,
): ProjectBuildPlanContent {
  assertDistinctOrdinals(content.milestones, "milestone");
  assertDistinctOrdinals(content.sequenceGates, "sequence gate");
  return {
    outcome: content.outcome,
    nonGoals: strings(content.nonGoals),
    milestones: ordered(content.milestones).map((milestone) => ({
      ...milestone,
      dependsOn: strings(milestone.dependsOn),
    })),
    sequenceGates: ordered(content.sequenceGates).map((gate) => ({
      ...gate,
      milestoneIds: strings(gate.milestoneIds),
    })),
    sharedConstraints: strings(content.sharedConstraints),
    repositoryIntents: byId(content.repositoryIntents).map((intent) => ({
      ...intent,
      packages: strings(intent.packages),
      ownershipBoundaries: strings(intent.ownershipBoundaries),
    })),
    integrationCriteria: strings(content.integrationCriteria),
    acceptanceCriteria: strings(content.acceptanceCriteria),
    decisions: byId(content.decisions),
    assignments: byId(content.assignments).map((assignment) => ({
      ...assignment,
      scope: strings(assignment.scope),
      nonGoals: strings(assignment.nonGoals),
      dependencies: byId(assignment.dependencies).map((dependency) => ({
        ...dependency,
        relationshipIds: strings(dependency.relationshipIds),
      })),
    })),
    unresolvedDecisions: byId(content.unresolvedDecisions),
    risks: byId(content.risks),
  };
}

export const buildPlanSemanticProjection = (
  plan: ProjectBuildPlanContent | Pick<ProjectBuildPlanVersion, "content">,
): ProjectBuildPlanContent =>
  canonicalizeProjectBuildPlanContent("content" in plan ? plan.content : plan);

export const computeBuildPlanSemanticDigest = (
  plan: ProjectBuildPlanContent | Pick<ProjectBuildPlanVersion, "content">,
): BuildPlanSemanticDigest =>
  canonicalDigest(
    "sapiom.build-plan.semantic.v1",
    buildPlanSemanticProjection(plan),
  ) as BuildPlanSemanticDigest;

export const computeBuildPlanRecordDigest = (
  plan: Omit<ProjectBuildPlanVersion, "recordDigest"> | ProjectBuildPlanVersion,
): RecordDigest => {
  const record = Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== "recordDigest"),
  );
  return canonicalDigest(
    "sapiom.build-plan.version-record.v1",
    record,
  ) as RecordDigest;
};

const briefStrings = (content: AgentBriefVersion["content"]) => ({
  ...content,
  scope: strings(content.scope),
  nonGoals: strings(content.nonGoals),
  ownedNodeIds: strings(content.ownedNodeIds),
  relevantNodeIds: strings(content.relevantNodeIds),
  inputs: strings(content.inputs),
  outputs: strings(content.outputs),
  dependencies: strings(content.dependencies),
  sharedResourceNodeIds: strings(content.sharedResourceNodeIds),
  sequenceGateIds: strings(content.sequenceGateIds),
  deliverables: strings(content.deliverables),
  acceptanceCriteria: strings(content.acceptanceCriteria),
  constraints: strings(content.constraints),
  milestoneIds: strings(content.milestoneIds),
  unresolvedDecisionIds: strings(content.unresolvedDecisionIds),
});

export type AgentBriefSemanticInput = Pick<
  AgentBriefVersion,
  | "scopeKey"
  | "focusScope"
  | "assignmentId"
  | "plannedAgentId"
  | "content"
  | "compilerInputFingerprint"
>;

export const agentBriefSemanticProjection = (brief: AgentBriefSemanticInput) => ({
  scopeKey: brief.scopeKey,
  focusScope: brief.focusScope,
  assignmentId: brief.assignmentId,
  plannedAgentId: brief.plannedAgentId,
  content: briefStrings(brief.content),
  compilerInputFingerprint: brief.compilerInputFingerprint,
});

export const computeAgentBriefSemanticDigest = (
  brief: AgentBriefSemanticInput,
): AgentBriefSemanticDigest =>
  canonicalDigest(
    "sapiom.agent-brief.semantic.v2",
    agentBriefSemanticProjection(brief),
  ) as AgentBriefSemanticDigest;

export const computeAgentBriefRecordDigest = (
  brief: Omit<AgentBriefVersion, "recordDigest"> | AgentBriefVersion,
): RecordDigest => {
  const record = Object.fromEntries(
    Object.entries(brief).filter(([key]) => key !== "recordDigest"),
  );
  return canonicalDigest(
    "sapiom.agent-brief.version-record.v1",
    record,
  ) as RecordDigest;
};

export const computeBuildPlanRequestDigest = (request: unknown): string =>
  canonicalDigest("sapiom.build-plan.request.v1", request);
