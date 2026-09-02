import type {
  AcceptedProposalDelta,
  AgentMapWorkspaceResponse,
  MapProposalId,
  PlanNodeId,
  ProposalOperationId,
} from "@shared/agent-map";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const proposalId =
  "proposal_00000000-0000-7000-8000-000000000001" as MapProposalId;
export const proposalNodeId =
  "node_00000000-0000-7000-8000-000000000002" as PlanNodeId;
const operationId =
  "operation_00000000-0000-7000-8000-000000000003" as ProposalOperationId;
const at = "2026-09-02T10:00:00.000Z";

export function proposalSnapshot(): AgentMapWorkspaceResponse {
  const node = {
    id: proposalNodeId,
    kind: "agent" as const,
    name: "Research",
    purpose: "Research sources",
    ownerAgentId: null,
    contractRefs: [],
  };
  return {
    schemaVersion: 1,
    project: {
      projectId,
      identityVersion: 1,
      displayName: "Stock Research",
      bindings: [],
      createdAt: at,
      updatedAt: at,
    },
    workspace: {
      projectId,
      schemaVersion: 1,
      recordVersion: 2,
      confirmedRevisionId: null,
      activeProposalId: proposalId,
      projectBuildPlanId: null,
      createdAt: at,
      updatedAt: at,
    },
    proposal: {
      schemaVersion: 1,
      id: proposalId,
      projectId,
      baseRevisionId: null,
      version: 1,
      nodes: [node],
      relationships: [],
      history: [
        {
          id: operationId,
          requestId: "initial",
          acceptedVersion: 1,
          operation: { kind: "add-node", node },
          actor: {
            userId: "user",
            sessionId: "planner",
            role: "map-planner",
            assignment: null,
          },
          acceptedAt: at,
        },
      ],
      createdAt: at,
      updatedAt: at,
    },
  };
}

export function renameDelta(fromVersion = 1): AcceptedProposalDelta {
  return {
    schemaVersion: 1,
    projectId,
    proposalId,
    fromVersion,
    version: fromVersion + 1,
    operationIds: [
      "operation_00000000-0000-7000-8000-000000000004" as ProposalOperationId,
    ],
    operations: [
      {
        kind: "update-node",
        nodeId: proposalNodeId,
        changes: { name: "Market Research" },
      },
    ],
    actor: {
      userId: "user",
      sessionId: "builder",
      role: "agent-builder",
      assignment: { kind: "unplanned" },
    },
    acceptedAt: "2026-09-02T10:00:01.000Z",
  };
}
