import { describe, expect, it } from "vitest";

import type {
  AgentMapGraph,
  AgentMapGraphDigest,
  AgentMapRevision,
  AgentMapRevisionId,
  ConfirmArchitectureRequest,
  MapChangeProposal,
  MapProposalId,
  PlanNodeId,
  PlanRelationshipId,
  PlannerUserMessageReceipt,
  ProposalOperationId,
} from "../shared/agent-map.js";
import {
  AgentMapRevisionContractError,
  classifyAgentMapConfirmationBoundary,
  digestAgentMapArchitecture,
  digestConfirmArchitectureRequest,
  materializeAgentMapRevision,
  validateAgentMapRevision,
  validateAgentMapRevisionChain,
  type MaterializeAgentMapRevisionInput,
} from "./agent-map-revision.js";

const projectId = "project-stock-research";
const acceptedAt = "2026-09-03T12:00:00.000Z";
const createdAt = "2026-09-03T12:00:01.000Z";
const researchId = "node_018f0000-0000-7000-8000-000000000001" as PlanNodeId;
const marketingId = "node_018f0000-0000-7000-8000-000000000002" as PlanNodeId;
const analystId = "node_018f0000-0000-7000-8000-000000000003" as PlanNodeId;
const reportId = "node_018f0000-0000-7000-8000-000000000004" as PlanNodeId;
const invokesId =
  "rel_018f0000-0000-7000-8000-000000000001" as PlanRelationshipId;
const writesId =
  "rel_018f0000-0000-7000-8000-000000000002" as PlanRelationshipId;
const readsId =
  "rel_018f0000-0000-7000-8000-000000000003" as PlanRelationshipId;
const proposalId =
  "proposal_018f0000-0000-7000-8000-000000000001" as MapProposalId;
const revisionId =
  "revision_018f0000-0000-7000-8000-000000000001" as AgentMapRevisionId;

const stockResearchGraph = (): AgentMapGraph => ({
  nodes: [
    {
      id: reportId,
      kind: "resource",
      name: "Shared report",
      purpose: "Carry approved research into marketing",
      ownerAgentId: null,
      contractRefs: ["report/market-v1"],
    },
    {
      id: analystId,
      kind: "subagent",
      name: "Research analyst",
      purpose: "Collect market evidence",
      ownerAgentId: researchId,
      contractRefs: ["evidence/v1", "query/v1"],
    },
    {
      id: marketingId,
      kind: "agent",
      name: "Marketing",
      purpose: "Turn findings into campaigns",
      ownerAgentId: null,
      contractRefs: ["campaign/v1"],
    },
    {
      id: researchId,
      kind: "agent",
      name: "Research",
      purpose: "Own market research",
      ownerAgentId: null,
      contractRefs: ["research/v1"],
    },
  ],
  relationships: [
    {
      id: readsId,
      fromNodeId: marketingId,
      toNodeId: reportId,
      kind: "reads",
      executionMode: "asynchronous",
      contractRef: "report/market-v1",
      description: "Consumes approved findings",
    },
    {
      id: writesId,
      fromNodeId: analystId,
      toNodeId: reportId,
      kind: "writes",
      executionMode: "asynchronous",
      contractRef: "report/market-v1",
      description: "Publishes findings",
    },
    {
      id: invokesId,
      fromNodeId: researchId,
      toNodeId: analystId,
      kind: "invokes",
      executionMode: "synchronous",
      contractRef: "query/v1",
      description: "Delegates evidence collection",
    },
  ],
});

const proposalFor = (
  id = proposalId,
  graph = stockResearchGraph(),
): MapChangeProposal => ({
  schemaVersion: 1,
  id,
  projectId,
  baseRevisionId: null,
  version: 1,
  ...graph,
  history: [
    {
      id: "operation_018f0000-0000-7000-8000-000000000001" as ProposalOperationId,
      requestId: "proposal-request-1",
      acceptedVersion: 1,
      operation: { kind: "add-node", node: graph.nodes[0]! },
      actor: {
        userId: "user-1",
        sessionId: "planner-session-1",
        role: "map-planner",
        assignment: null,
      },
      acceptedAt,
    },
  ],
  createdAt: acceptedAt,
  updatedAt: acceptedAt,
});

const receiptFor = (
  messageId = "message-approval-1",
): PlannerUserMessageReceipt => ({
  messageId,
  projectId,
  userId: "user-1",
  sessionId: "planner-session-1",
  origin: "human",
  acceptedAt,
});

const requestFor = (
  digest: AgentMapGraphDigest,
  sourceId = proposalId,
  messageId = "message-approval-1",
): ConfirmArchitectureRequest => ({
  schemaVersion: 1,
  requestId: "confirm-request-1",
  proposalId: sourceId,
  expectedVersion: 1,
  expectedDigest: digest,
  approvingMessageId: messageId,
});

const materializationInput = (): MaterializeAgentMapRevisionInput => {
  const proposal = proposalFor();
  const digest = digestAgentMapArchitecture(projectId, proposal);
  return {
    proposal,
    request: requestFor(digest),
    receipt: receiptFor(),
    principal: {
      role: "map-planner",
      projectId,
      userId: "user-1",
      sessionId: "planner-session-1",
    },
    revisionId,
    revisionNumber: 1,
    parentRevisionId: null,
    createdAt,
  };
};

const mutateGraph = (mutate: (graph: AgentMapGraph) => void): AgentMapGraph => {
  const graph = structuredClone(stockResearchGraph());
  mutate(graph);
  return graph;
};

describe("Agent Map architecture digest", () => {
  it("handles empty and single-node architectures", () => {
    expect(
      digestAgentMapArchitecture(projectId, { nodes: [], relationships: [] }),
    ).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(
      digestAgentMapArchitecture(projectId, {
        nodes: [stockResearchGraph().nodes[0]!],
        relationships: [],
      }),
    ).not.toBe(
      digestAgentMapArchitecture(projectId, { nodes: [], relationships: [] }),
    );
  });

  it("is stable across graph and contract-reference ordering", () => {
    const graph = stockResearchGraph();
    const before = JSON.stringify(graph);
    const reordered = structuredClone(graph);
    reordered.nodes.reverse();
    reordered.relationships.reverse();
    reordered.nodes.find(({ id }) => id === analystId)?.contractRefs.reverse();

    expect(digestAgentMapArchitecture(projectId, reordered)).toBe(
      digestAgentMapArchitecture(projectId, graph),
    );
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("pins the stock-research protocol digest", () => {
    expect(digestAgentMapArchitecture(projectId, stockResearchGraph())).toBe(
      "sha256:e62c2ca18e1ddc05f7cfbe610eff8e876fb5d7a5afcd31d0d232adee31cd2b0f",
    );
  });

  it.each([
    [
      "node ID",
      (graph: AgentMapGraph) => {
        const replacement =
          "node_018f0000-0000-7000-8000-000000000099" as PlanNodeId;
        graph.nodes.find(({ id }) => id === researchId)!.id = replacement;
        graph.nodes.find(({ id }) => id === analystId)!.ownerAgentId =
          replacement;
        graph.relationships.find(({ id }) => id === invokesId)!.fromNodeId =
          replacement;
      },
    ],
    [
      "node kind",
      (graph: AgentMapGraph) => {
        graph.nodes.find(({ id }) => id === reportId)!.kind = "artifact";
      },
    ],
    [
      "node name",
      (graph: AgentMapGraph) => {
        graph.nodes.find(({ id }) => id === researchId)!.name = "Research 2";
      },
    ],
    [
      "node purpose",
      (graph: AgentMapGraph) => {
        graph.nodes.find(({ id }) => id === researchId)!.purpose =
          "New purpose";
      },
    ],
    [
      "node owner",
      (graph: AgentMapGraph) => {
        graph.nodes.find(({ id }) => id === analystId)!.ownerAgentId =
          marketingId;
      },
    ],
    [
      "node contract reference",
      (graph: AgentMapGraph) => {
        graph.nodes.find(({ id }) => id === researchId)!.contractRefs = [
          "research/v2",
        ];
      },
    ],
    [
      "relationship ID",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.id =
          "rel_018f0000-0000-7000-8000-000000000099" as PlanRelationshipId;
      },
    ],
    [
      "relationship source",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.fromNodeId =
          marketingId;
      },
    ],
    [
      "relationship target",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.toNodeId =
          marketingId;
      },
    ],
    [
      "relationship kind",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.kind =
          "triggers";
      },
    ],
    [
      "relationship execution mode",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.executionMode =
          "scheduled";
      },
    ],
    [
      "relationship contract",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.contractRef =
          "query/v2";
      },
    ],
    [
      "relationship description",
      (graph: AgentMapGraph) => {
        graph.relationships.find(({ id }) => id === invokesId)!.description =
          "Changed";
      },
    ],
  ])("changes when the %s changes", (_name, mutate) => {
    expect(digestAgentMapArchitecture(projectId, mutateGraph(mutate))).not.toBe(
      digestAgentMapArchitecture(projectId, stockResearchGraph()),
    );
  });

  it("separates identical-looking graphs by project", () => {
    expect(
      digestAgentMapArchitecture("project-other", stockResearchGraph()),
    ).not.toBe(digestAgentMapArchitecture(projectId, stockResearchGraph()));
  });
});

describe("Agent Map revision materialization", () => {
  it("preserves graph identity and binds trusted content-free approval", () => {
    const input = materializationInput();
    const before = JSON.stringify(input);
    const revision = materializeAgentMapRevision(input);

    expect(revision.digest).toBe(input.request.expectedDigest);
    expect(revision.nodes.map(({ id }) => id).sort()).toEqual(
      input.proposal.nodes.map(({ id }) => id).sort(),
    );
    expect(revision.relationships.map(({ id }) => id).sort()).toEqual(
      input.proposal.relationships.map(({ id }) => id).sort(),
    );
    expect(
      revision.nodes.find(({ id }) => id === analystId)?.ownerAgentId,
    ).toBe(researchId);
    expect(revision.approval).toEqual({
      approvedProposalId: proposalId,
      approvedProposalVersion: 1,
      approvingUserId: "user-1",
      approvingSessionId: "planner-session-1",
      approvingMessageId: "message-approval-1",
      approvedAt: acceptedAt,
    });
    expect(JSON.stringify(revision)).not.toMatch(
      /(?:messageText|prompt|transcript|sourcePath|secret|providerPayload)/iu,
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps runtime mechanics out of the project architecture", () => {
    const revision = materializeAgentMapRevision(materializationInput());
    expect(revision.nodes.map(({ name }) => name)).toEqual([
      "Research",
      "Marketing",
      "Research analyst",
      "Shared report",
    ]);
    expect(JSON.stringify(revision.nodes)).not.toMatch(
      /(?:LLM call|MCP invocation|workflow step)/iu,
    );
  });

  it("excludes proposal identity, history, and timestamps", () => {
    const proposal = proposalFor();
    const changedMetadata = {
      ...proposal,
      id: "proposal_018f0000-0000-7000-8000-000000000099" as MapProposalId,
      baseRevisionId: revisionId,
      version: 99,
      history: [],
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    expect(digestAgentMapArchitecture(projectId, changedMetadata)).toBe(
      digestAgentMapArchitecture(projectId, proposal),
    );
  });

  it.each([
    [
      "stale source",
      (input: MaterializeAgentMapRevisionInput) => {
        input.request = { ...input.request, expectedVersion: 2 };
      },
      "stale_proposal",
    ],
    [
      "digest mismatch",
      (input: MaterializeAgentMapRevisionInput) => {
        input.request = {
          ...input.request,
          expectedDigest: `sha256:${"f".repeat(64)}` as AgentMapGraphDigest,
        };
      },
      "proposal_digest_mismatch",
    ],
    [
      "wrong user",
      (input: MaterializeAgentMapRevisionInput) => {
        input.receipt = { ...input.receipt, userId: "user-2" };
      },
      "approval_message_invalid",
    ],
    [
      "wrong message",
      (input: MaterializeAgentMapRevisionInput) => {
        input.receipt = { ...input.receipt, messageId: "message-other" };
      },
      "approval_message_invalid",
    ],
    [
      "cross-project receipt",
      (input: MaterializeAgentMapRevisionInput) => {
        input.receipt = { ...input.receipt, projectId: "project-other" };
      },
      "cross_project",
    ],
    [
      "approval after commit",
      (input: MaterializeAgentMapRevisionInput) => {
        input.receipt = {
          ...input.receipt,
          acceptedAt: "2026-09-03T12:00:02.000Z",
        };
      },
      "approval_message_invalid",
    ],
    [
      "approval before the proposal source",
      (input: MaterializeAgentMapRevisionInput) => {
        input.receipt = {
          ...input.receipt,
          acceptedAt: "2026-09-03T11:59:59.000Z",
        };
      },
      "approval_message_invalid",
    ],
    [
      "non-human approval",
      (input: MaterializeAgentMapRevisionInput) => {
        input.receipt = { ...input.receipt, origin: "assistant" as "human" };
      },
      "approval_message_invalid",
    ],
  ])("rejects %s with a bounded failure", (_name, mutate, code) => {
    const input = materializationInput();
    mutate(input);
    try {
      materializeAgentMapRevision(input);
      expect.fail("expected materialization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMapRevisionContractError);
      expect(error).toMatchObject({ code });
      expect(JSON.stringify(error)).not.toContain(input.receipt.messageId);
    }
  });
});

describe("Agent Map revision chain", () => {
  const twoRevisions = (): [AgentMapRevision, AgentMapRevision] => {
    const first = materializeAgentMapRevision(materializationInput());
    const secondInput = materializationInput();
    const secondProposalId =
      "proposal_018f0000-0000-7000-8000-000000000002" as MapProposalId;
    secondInput.proposal = {
      ...proposalFor(secondProposalId),
      baseRevisionId: first.id,
    };
    secondInput.receipt = {
      ...receiptFor("message-approval-2"),
      acceptedAt: "2026-09-03T12:00:01.000Z",
    };
    secondInput.request = {
      ...requestFor(first.digest, secondProposalId, "message-approval-2"),
      requestId: "confirm-request-2",
    };
    secondInput.revisionId =
      "revision_018f0000-0000-7000-8000-000000000002" as AgentMapRevisionId;
    secondInput.revisionNumber = 2;
    secondInput.parentRevisionId = first.id;
    secondInput.createdAt = "2026-09-03T12:00:02.000Z";
    return [first, materializeAgentMapRevision(secondInput)];
  };

  it("validates revision one and exact contiguous ancestry", () => {
    const revisions = twoRevisions();
    expect(validateAgentMapRevision(revisions[0], projectId)).toEqual(
      revisions[0],
    );
    expect(validateAgentMapRevisionChain(revisions, projectId)).toEqual(
      revisions,
    );
    expect(revisions[1].digest).toBe(revisions[0].digest);
    expect(revisions[1].id).not.toBe(revisions[0].id);
  });

  it.each([
    [
      "rewritten parent",
      (revisions: AgentMapRevision[]) =>
        (revisions[1]!.parentRevisionId =
          "revision_018f0000-0000-7000-8000-000000000099" as AgentMapRevisionId),
    ],
    [
      "skipped number",
      (revisions: AgentMapRevision[]) => (revisions[1]!.revisionNumber = 3),
    ],
    [
      "duplicate number",
      (revisions: AgentMapRevision[]) => (revisions[1]!.revisionNumber = 1),
    ],
    [
      "duplicate ID",
      (revisions: AgentMapRevision[]) => (revisions[1]!.id = revisions[0]!.id),
    ],
    [
      "wrong digest",
      (revisions: AgentMapRevision[]) =>
        (revisions[1]!.digest =
          `sha256:${"0".repeat(64)}` as AgentMapGraphDigest),
    ],
    [
      "cross-project substitution",
      (revisions: AgentMapRevision[]) =>
        (revisions[1]!.projectId = "project-other"),
    ],
    [
      "reused approval message",
      (revisions: AgentMapRevision[]) =>
        (revisions[1]!.approval.approvingMessageId =
          revisions[0]!.approval.approvingMessageId),
    ],
    [
      "reconfirmed proposal source",
      (revisions: AgentMapRevision[]) => {
        revisions[1]!.approval.approvedProposalId =
          revisions[0]!.approval.approvedProposalId;
        revisions[1]!.approval.approvedProposalVersion =
          revisions[0]!.approval.approvedProposalVersion;
      },
    ],
  ])("rejects a chain with %s", (_name, mutate) => {
    const revisions = twoRevisions();
    mutate(revisions);
    try {
      validateAgentMapRevisionChain(revisions, projectId);
      expect.fail("expected chain validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMapRevisionContractError);
      expect(error).toMatchObject({
        code: "invalid_revision_chain",
        recovery: "reread",
      });
    }
  });
});

describe("Agent Map confirmation retry boundary", () => {
  it("distinguishes replay-equivalent requests from changed bodies", () => {
    const digest = digestAgentMapArchitecture(projectId, stockResearchGraph());
    const request = requestFor(digest);
    expect(digestConfirmArchitectureRequest(structuredClone(request))).toBe(
      digestConfirmArchitectureRequest(request),
    );
    for (const changed of [
      { ...request, requestId: "confirm-request-2" },
      {
        ...request,
        proposalId:
          "proposal_018f0000-0000-7000-8000-000000000002" as MapProposalId,
      },
      { ...request, expectedVersion: 2 },
      {
        ...request,
        expectedDigest: `sha256:${"e".repeat(64)}` as AgentMapGraphDigest,
      },
      { ...request, approvingMessageId: "message-approval-2" },
    ]) {
      expect(digestConfirmArchitectureRequest(changed)).not.toBe(
        digestConfirmArchitectureRequest(request),
      );
    }
  });

  it.each([
    [
      "the current proposal operation commits first",
      { committedFirst: "proposal-operation" } as const,
      {
        confirmation: {
          outcome: "failed",
          failure: { code: "stale_proposal", recovery: "reread" },
        },
        proposalOperation: "committed",
      },
    ],
    [
      "confirmation commits before an exact-source operation",
      {
        committedFirst: "confirmation",
        confirmedSource: { proposalId, version: 1 },
        operationSource: { proposalId, version: 1 },
      } as const,
      {
        confirmation: { outcome: "confirmed" },
        proposalOperation: "rebase-eligible",
      },
    ],
    [
      "confirmation commits before an older-source operation",
      {
        committedFirst: "confirmation",
        confirmedSource: { proposalId, version: 1 },
        operationSource: {
          proposalId:
            "proposal_018f0000-0000-7000-8000-000000000099" as MapProposalId,
          version: 1,
        },
      } as const,
      {
        confirmation: { outcome: "confirmed" },
        proposalOperation: "stale",
      },
    ],
  ])("classifies when %s", (_name, input, expected) => {
    expect(classifyAgentMapConfirmationBoundary(input)).toEqual(expected);
  });
});
