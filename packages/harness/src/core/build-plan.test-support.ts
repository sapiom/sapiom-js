import type {
  AgentMapGraph,
  MapProposalId,
  PlanNodeId,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  AgentBriefId,
  AgentBriefVersionRecord,
  ArchitectureSourceRef,
  BuildPlanId,
  LegacyAgentBriefVersionRecord,
  PlanningAssignmentId,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import {
  AGENT_BRIEF_DIGEST_VERSION,
  AGENT_BRIEF_SCHEMA_VERSION,
} from "../shared/build-plan.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeArchitectureGraphDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";

export const PROJECT_ID =
  "project_00000000-0000-4000-8000-000000000001" as StudioProjectId;
export const AGENT_ID =
  "node_00000000-0000-7000-8000-000000000001" as PlanNodeId;
export const PLAN_ID =
  "build-plan_00000000-0000-7000-8000-000000000002" as BuildPlanId;
export const BRIEF_ID =
  "brief_00000000-0000-7000-8000-000000000003" as AgentBriefId;
export const ASSIGNMENT_ID =
  "assignment_00000000-0000-7000-8000-000000000004" as PlanningAssignmentId;

export const graph: AgentMapGraph = {
  nodes: [
    {
      id: AGENT_ID,
      kind: "agent",
      name: "Builder",
      purpose: "Build the system",
      ownerAgentId: null,
      contractRefs: [],
    },
  ],
  relationships: [],
};

export const proposalSource = (): Extract<
  ArchitectureSourceRef,
  { kind: "proposal" }
> => ({
  kind: "proposal",
  proposalId: "proposal_00000000-0000-7000-8000-000000000005" as MapProposalId,
  version: 1,
  graphDigest: computeArchitectureGraphDigest(graph),
});

export function makePlan(
  overrides: Partial<ProjectBuildPlanVersion> = {},
): ProjectBuildPlanVersion {
  const draft = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    planId: PLAN_ID,
    version: 1,
    parentVersion: null,
    changeKind: "created",
    source: proposalSource(),
    outcome: { summary: "Ship a durable product" },
    milestones: [],
    sharedConstraints: [],
    repositoryIntents: [],
    integrationCriteria: [],
    assignments: [
      {
        plannedAgentId: AGENT_ID,
        mission: "Implement the product",
        scope: { inScope: ["Core"], nonGoals: ["Deployment"] },
        deliverables: [],
        constraints: [],
        acceptanceCriteria: [],
        milestoneIds: [],
        unresolvedDecisions: [],
      },
    ],
    unresolvedDecisions: [],
    semanticDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    recordDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    authoredBy: {
      userId: "user-1",
      sessionId: "session-1",
      role: "map-planner",
    },
    createdAt: "2026-09-03T09:00:00.000Z",
    ...overrides,
  } as ProjectBuildPlanVersion;
  draft.semanticDigest = computeBuildPlanSemanticDigest(draft);
  draft.recordDigest = computeBuildPlanRecordDigest(draft);
  return draft;
}

export function makeBrief(
  plan: ProjectBuildPlanVersion,
  overrides: Partial<AgentBriefVersionRecord> = {},
): AgentBriefVersionRecord {
  const draft = {
    schemaVersion: AGENT_BRIEF_SCHEMA_VERSION,
    digestVersion: AGENT_BRIEF_DIGEST_VERSION,
    projectId: PROJECT_ID,
    briefId: BRIEF_ID,
    version: 1,
    parentVersion: null,
    plannedAgentId: AGENT_ID,
    assignmentId: ASSIGNMENT_ID,
    plan: {
      planId: plan.planId,
      version: plan.version,
      semanticDigest: plan.semanticDigest,
    },
    source: plan.source,
    mission: "Implement the product",
    scope: { inScope: ["Core"], nonGoals: ["Deployment"] },
    ownedNodeIds: [AGENT_ID],
    relevantNodeIds: [AGENT_ID],
    inputs: [],
    outputs: [],
    dependencies: [],
    deliverables: [],
    acceptanceCriteria: [],
    constraints: [],
    milestones: [],
    unresolvedDecisions: [],
    changeProtocol: {
      proposeArchitectureChanges: true,
      instructions: ["Propose boundary changes"],
    },
    compilerVersion: "1.0.0",
    dependencyFingerprints: [],
    semanticDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    recordDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    authoredBy: {
      userId: "user-1",
      sessionId: "session-1",
      role: "map-planner",
    },
    createdAt: "2026-09-03T09:00:00.000Z",
    ...overrides,
  } as AgentBriefVersionRecord;
  draft.semanticDigest = computeAgentBriefSemanticDigest(draft);
  draft.recordDigest = computeAgentBriefRecordDigest(draft);
  return draft;
}

export function makeLegacyBrief(
  plan: ProjectBuildPlanVersion,
  overrides: Partial<LegacyAgentBriefVersionRecord> = {},
): LegacyAgentBriefVersionRecord {
  const current = makeBrief(plan);
  const common: Partial<AgentBriefVersionRecord> = { ...current };
  delete common.digestVersion;
  const withoutExecutionModes = (ports: typeof current.inputs) =>
    ports.map(({ executionModes: _executionModes, ...port }) => port);
  const draft = {
    ...common,
    schemaVersion: 1 as const,
    inputs: withoutExecutionModes(current.inputs),
    outputs: withoutExecutionModes(current.outputs),
    compilerVersion: "legacy-compiler-v1",
    dependencyFingerprints: [
      {
        kind: "node" as const,
        id: AGENT_ID,
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
    ...overrides,
  } as LegacyAgentBriefVersionRecord;
  draft.semanticDigest = computeAgentBriefSemanticDigest(draft);
  draft.recordDigest = computeAgentBriefRecordDigest(draft);
  return draft;
}
