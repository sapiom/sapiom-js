import type {
  AgentMapGraph,
  MapProposalId,
  PlanNodeId,
  PlanRelationshipId,
} from "../shared/agent-map.js";
import type {
  AcceptanceCriterionId,
  AgentBriefId,
  BuildPlanId,
  DeliverableId,
  MilestoneId,
  PlanningAssignmentId,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import {
  computeArchitectureGraphDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";

export const STOCK_PROJECT_ID = "project_10000000-0000-4000-8000-000000000001";
export const RESEARCH_ID =
  "node_10000000-0000-7000-8000-000000000001" as PlanNodeId;
export const MARKETING_ID =
  "node_10000000-0000-7000-8000-000000000002" as PlanNodeId;
export const ANALYST_ID =
  "node_10000000-0000-7000-8000-000000000003" as PlanNodeId;
export const REPORT_ID =
  "node_10000000-0000-7000-8000-000000000004" as PlanNodeId;
export const DATA_ID =
  "node_10000000-0000-7000-8000-000000000005" as PlanNodeId;
export const CHANNEL_ID =
  "node_10000000-0000-7000-8000-000000000006" as PlanNodeId;
export const RELAY_ID =
  "node_10000000-0000-7000-8000-000000000009" as PlanNodeId;
export const REPORT_CONTRACT = "contract-research-report";

export const stockResearchGraph = (): AgentMapGraph => ({
  nodes: [
    {
      id: RESEARCH_ID,
      kind: "agent",
      name: "Research",
      purpose: "Produce defensible stock research",
      ownerAgentId: null,
      contractRefs: [],
    },
    {
      id: MARKETING_ID,
      kind: "agent",
      name: "Marketing",
      purpose: "Publish investor-ready findings",
      ownerAgentId: null,
      contractRefs: [],
    },
    {
      id: ANALYST_ID,
      kind: "subagent",
      name: "Equity analyst",
      purpose: "Analyze company fundamentals",
      ownerAgentId: RESEARCH_ID,
      contractRefs: [REPORT_CONTRACT],
    },
    {
      id: REPORT_ID,
      kind: "artifact",
      name: "ResearchReport",
      purpose: "Carry cited analysis into publication",
      ownerAgentId: null,
      contractRefs: [REPORT_CONTRACT],
    },
    {
      id: DATA_ID,
      kind: "resource",
      name: "Market data",
      purpose: "Shared market facts",
      ownerAgentId: null,
      contractRefs: [],
    },
    {
      id: CHANNEL_ID,
      kind: "connector",
      name: "Publishing channel",
      purpose: "Deliver approved content",
      ownerAgentId: null,
      contractRefs: [],
    },
  ],
  relationships: [
    {
      id: "rel_10000000-0000-7000-8000-000000000001" as PlanRelationshipId,
      fromNodeId: ANALYST_ID,
      toNodeId: REPORT_ID,
      kind: "writes",
      executionMode: "asynchronous",
      contractRef: REPORT_CONTRACT,
      description: "Write the cited ResearchReport",
    },
    {
      id: "rel_10000000-0000-7000-8000-000000000002" as PlanRelationshipId,
      fromNodeId: MARKETING_ID,
      toNodeId: REPORT_ID,
      kind: "reads",
      executionMode: "asynchronous",
      contractRef: REPORT_CONTRACT,
      description: "Read the approved ResearchReport",
    },
    {
      id: "rel_10000000-0000-7000-8000-000000000003" as PlanRelationshipId,
      fromNodeId: RESEARCH_ID,
      toNodeId: DATA_ID,
      kind: "uses",
      executionMode: "synchronous",
      contractRef: null,
      description: "Use shared market data",
    },
    {
      id: "rel_10000000-0000-7000-8000-000000000004" as PlanRelationshipId,
      fromNodeId: MARKETING_ID,
      toNodeId: DATA_ID,
      kind: "uses",
      executionMode: "synchronous",
      contractRef: null,
      description: "Use shared market data",
    },
    {
      id: "rel_10000000-0000-7000-8000-000000000005" as PlanRelationshipId,
      fromNodeId: MARKETING_ID,
      toNodeId: CHANNEL_ID,
      kind: "uses",
      executionMode: "human-triggered",
      contractRef: null,
      description: "Publish through the approved channel",
    },
  ],
});

export function stockResearchPlan(
  graph = stockResearchGraph(),
  overrides: Partial<ProjectBuildPlanVersion> = {},
): ProjectBuildPlanVersion {
  const source = {
    kind: "proposal" as const,
    proposalId:
      "proposal_10000000-0000-7000-8000-000000000001" as MapProposalId,
    version: 1,
    graphDigest: computeArchitectureGraphDigest(graph),
  };
  const draft = {
    schemaVersion: 1 as const,
    projectId: STOCK_PROJECT_ID,
    planId: "build-plan_10000000-0000-7000-8000-000000000001" as BuildPlanId,
    version: 1 as ProjectBuildPlanVersion["version"],
    parentVersion: null,
    changeKind: "created" as const,
    source,
    outcome: { summary: "Publish a defensible stock research campaign" },
    milestones: [
      {
        milestoneId:
          "milestone_10000000-0000-7000-8000-000000000001" as MilestoneId,
        ordinal: 1,
        title: "Research ready",
        outcome: "Cited analysis is ready for publication",
        dependsOn: [],
      },
    ],
    sharedConstraints: [
      {
        constraintId: "citations-required",
        description: "Every claim must be cited",
        required: true,
      },
    ],
    repositoryIntents: [],
    integrationCriteria: [
      {
        criterionId:
          "criterion_10000000-0000-7000-8000-000000000003" as AcceptanceCriterionId,
        ordinal: 1,
        description: "Research reaches Marketing through the typed report",
        verification: "Verify the shared contract identity",
      },
    ],
    assignments: [
      {
        plannedAgentId: RESEARCH_ID,
        mission: "Produce a cited report that supports the campaign outcome",
        scope: {
          inScope: ["Source and analyze company evidence"],
          nonGoals: ["Publishing campaign copy"],
        },
        deliverables: [
          {
            deliverableId:
              "deliverable_10000000-0000-7000-8000-000000000001" as DeliverableId,
            description: "A cited ResearchReport",
            artifactNodeIds: [REPORT_ID],
            acceptanceCriterionIds: [
              "criterion_10000000-0000-7000-8000-000000000001" as AcceptanceCriterionId,
            ],
          },
        ],
        constraints: [],
        acceptanceCriteria: [
          {
            criterionId:
              "criterion_10000000-0000-7000-8000-000000000001" as AcceptanceCriterionId,
            ordinal: 1,
            description: "Report contains cited findings",
            verification: "Review citations and source links",
          },
        ],
        milestoneIds: [
          "milestone_10000000-0000-7000-8000-000000000001" as MilestoneId,
        ],
        unresolvedDecisions: [],
      },
      {
        plannedAgentId: MARKETING_ID,
        mission: "Turn approved research into investor-ready campaign content",
        scope: {
          inScope: ["Create campaign content from approved research"],
          nonGoals: ["Changing research conclusions"],
        },
        deliverables: [
          {
            deliverableId:
              "deliverable_10000000-0000-7000-8000-000000000002" as DeliverableId,
            description: "Publication-ready campaign content",
            artifactNodeIds: [],
            acceptanceCriterionIds: [
              "criterion_10000000-0000-7000-8000-000000000002" as AcceptanceCriterionId,
            ],
          },
        ],
        constraints: [],
        acceptanceCriteria: [
          {
            criterionId:
              "criterion_10000000-0000-7000-8000-000000000002" as AcceptanceCriterionId,
            ordinal: 1,
            description: "Campaign uses only approved report claims",
            verification: "Trace every claim to ResearchReport",
          },
        ],
        milestoneIds: [
          "milestone_10000000-0000-7000-8000-000000000001" as MilestoneId,
        ],
        unresolvedDecisions: [],
      },
    ],
    unresolvedDecisions: [],
    semanticDigest: "",
    recordDigest: "",
    authoredBy: {
      userId: "planner-1",
      sessionId: "session-1",
      role: "map-planner" as const,
    },
    createdAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  } as ProjectBuildPlanVersion;
  draft.semanticDigest = computeBuildPlanSemanticDigest(draft);
  draft.recordDigest = computeBuildPlanRecordDigest(draft);
  return draft;
}

export const stockAssignments = () => [
  {
    assignmentId:
      "assignment_10000000-0000-7000-8000-000000000001" as PlanningAssignmentId,
    briefId: "brief_10000000-0000-7000-8000-000000000001" as AgentBriefId,
    plannedAgentId: RESEARCH_ID,
  },
  {
    assignmentId:
      "assignment_10000000-0000-7000-8000-000000000002" as PlanningAssignmentId,
    briefId: "brief_10000000-0000-7000-8000-000000000002" as AgentBriefId,
    plannedAgentId: MARKETING_ID,
  },
];

export function stockResearchRelayFixture() {
  const graph = stockResearchGraph();
  graph.nodes.push({
    id: RELAY_ID,
    kind: "agent",
    name: "Report Relay",
    purpose: "Relay the typed report without changing its contract",
    ownerAgentId: null,
    contractRefs: [REPORT_CONTRACT],
  });
  graph.nodes.find((node) => node.id === REPORT_ID)!.ownerAgentId = RELAY_ID;
  const base = stockResearchPlan(graph);
  const relayCriterionId =
    "criterion_10000000-0000-7000-8000-000000000009" as AcceptanceCriterionId;
  const plan = stockResearchPlan(graph, {
    assignments: [
      ...base.assignments.map((assignment) =>
        assignment.plannedAgentId === RESEARCH_ID
          ? {
              ...assignment,
              deliverables: assignment.deliverables.map((deliverable) => ({
                ...deliverable,
                artifactNodeIds: [],
              })),
            }
          : assignment,
      ),
      {
        plannedAgentId: RELAY_ID,
        mission: "Relay the research report to Marketing",
        scope: {
          inScope: ["Typed report relay"],
          nonGoals: ["Research and campaign creation"],
        },
        deliverables: [
          {
            deliverableId:
              "deliverable_10000000-0000-7000-8000-000000000009" as DeliverableId,
            description: "A relayed research report",
            artifactNodeIds: [REPORT_ID],
            acceptanceCriterionIds: [relayCriterionId],
          },
        ],
        constraints: [],
        acceptanceCriteria: [
          {
            criterionId: relayCriterionId,
            ordinal: 1,
            description: "The report reaches Marketing unchanged",
            verification: "Match the shared contract reference",
          },
        ],
        milestoneIds: [],
        unresolvedDecisions: [],
      },
    ],
  });
  return {
    graph,
    plan,
    assignments: [
      ...stockAssignments(),
      {
        plannedAgentId: RELAY_ID,
        assignmentId:
          "assignment_10000000-0000-7000-8000-000000000009" as PlanningAssignmentId,
        briefId: "brief_10000000-0000-7000-8000-000000000009" as AgentBriefId,
      },
    ],
  };
}

export function reviseStockPlan(
  previous: ProjectBuildPlanVersion,
  graph: AgentMapGraph,
  overrides: Partial<ProjectBuildPlanVersion> = {},
): ProjectBuildPlanVersion {
  return stockResearchPlan(graph, {
    ...previous,
    version: (previous.version + 1) as ProjectBuildPlanVersion["version"],
    parentVersion: previous.version,
    changeKind: "edited",
    source: {
      ...previous.source,
      version:
        previous.source.kind === "proposal"
          ? previous.source.version + 1
          : undefined,
      graphDigest: computeArchitectureGraphDigest(graph),
    } as ProjectBuildPlanVersion["source"],
    createdAt: "2026-09-03T11:00:00.000Z",
    ...overrides,
  });
}
