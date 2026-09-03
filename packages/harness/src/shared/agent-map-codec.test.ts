import { describe, expect, it } from "vitest";

import {
  parseAgentMapRevision,
  parseAgentMapRevisionRef,
  parseAgentMapProposalReceipt,
  parseArchitectureApproval,
  parseConfirmArchitectureRequest,
  parseConfirmArchitectureResult,
  parseMapChangeProposal,
  parsePlannerUserMessageReceipt,
  parseProposalActor,
} from "./agent-map-codec.js";

const nodeId = "node_00000000-0000-7000-8000-000000000001";
const proposalId = "proposal_00000000-0000-7000-8000-000000000002";
const operationId = "operation_00000000-0000-7000-8000-000000000003";
const acceptedAt = "2026-09-02T12:00:00.000Z";
const actor = {
  userId: "user-1",
  sessionId: "session-1",
  role: "map-planner",
  assignment: null,
};
const operation = {
  kind: "add-node",
  node: {
    id: nodeId,
    kind: "agent",
    name: "Research",
    purpose: "Research",
    ownerAgentId: null,
    contractRefs: [],
  },
};
const proposal = {
  schemaVersion: 1,
  id: proposalId,
  projectId: "project_00000000-0000-4000-8000-000000000001",
  baseRevisionId: null,
  version: 1,
  nodes: [operation.node],
  relationships: [],
  history: [
    {
      id: operationId,
      requestId: "request-1",
      acceptedVersion: 1,
      operation,
      actor,
      acceptedAt,
    },
  ],
  createdAt: acceptedAt,
  updatedAt: acceptedAt,
};
const receipt = {
  sessionId: "session-1",
  requestId: "request-1",
  requestDigest: "a".repeat(64),
  version: 1,
  allocatedNodeIds: { research: nodeId },
  allocatedRelationshipIds: {},
};
const revisionId = "revision_018f0000-0000-7000-8000-000000000004";
const digest = `sha256:${"a".repeat(64)}`;
const approval = {
  approvedProposalId: proposalId,
  approvedProposalVersion: 1,
  approvingUserId: actor.userId,
  approvingSessionId: actor.sessionId,
  approvingMessageId: "message-1",
  approvedAt: acceptedAt,
};
const plannerReceipt = {
  messageId: approval.approvingMessageId,
  projectId: proposal.projectId,
  userId: actor.userId,
  sessionId: actor.sessionId,
  origin: "human",
  acceptedAt,
};
const confirmRequest = {
  schemaVersion: 1,
  requestId: "confirm-1",
  proposalId,
  expectedVersion: 1,
  expectedDigest: digest,
  approvingMessageId: approval.approvingMessageId,
};
const revision = {
  schemaVersion: 1,
  id: revisionId,
  projectId: proposal.projectId,
  revisionNumber: 1,
  parentRevisionId: null,
  nodes: proposal.nodes,
  relationships: [],
  digest,
  approval,
  createdAt: acceptedAt,
};

describe("Agent Map persisted/public codecs", () => {
  it("accepts the complete exact nested proposal and receipt", () => {
    expect(parseMapChangeProposal(proposal)).toEqual(proposal);
    expect(parseAgentMapProposalReceipt(receipt)).toEqual(receipt);
  });

  it.each([
    [
      "unknown operation",
      (value: any) => (value.history[0].operation.kind = "execute"),
    ],
    [
      "spoofed assignment",
      (value: any) =>
        (value.history[0].actor.assignment = { kind: "unplanned" }),
    ],
    [
      "nested extra field",
      (value: any) => (value.history[0].operation.node.privatePath = "/secret"),
    ],
  ])("rejects %s in public history", (_name, mutate) => {
    const value = structuredClone(proposal);
    mutate(value);
    expect(() => parseMapChangeProposal(value)).toThrow();
  });

  it("rejects corrupt private receipt allocations", () => {
    const value = structuredClone(receipt) as any;
    value.allocatedNodeIds.research = "foreign";
    expect(() => parseAgentMapProposalReceipt(value)).toThrow();
  });

  it("uses the same DEL-safe actor boundary as proposal requests", () => {
    expect(() =>
      parseProposalActor({ ...actor, sessionId: "session\u007f1" }),
    ).toThrow();
  });

  it("strictly parses content-free approval and confirmation contracts", () => {
    expect(parseArchitectureApproval(approval)).toEqual(approval);
    expect(
      parsePlannerUserMessageReceipt(plannerReceipt, proposal.projectId),
    ).toEqual(plannerReceipt);
    expect(parseConfirmArchitectureRequest(confirmRequest)).toEqual(
      confirmRequest,
    );
    expect(parseAgentMapRevision(revision, proposal.projectId)).toEqual(
      revision,
    );
    expect(
      parseConfirmArchitectureResult({
        schemaVersion: 1,
        outcome: "confirmed",
        approvedProposal: { id: proposalId, version: 1, digest },
        revision: {
          id: revisionId,
          revisionNumber: 1,
          parentRevisionId: null,
          digest,
          createdAt: acceptedAt,
        },
        workspaceRecordVersion: 2,
      }),
    ).toMatchObject({ outcome: "confirmed" });
  });

  it("returns defensive revision and receipt clones", () => {
    const parsedRevision = parseAgentMapRevision(revision, proposal.projectId);
    const parsedReceipt = parsePlannerUserMessageReceipt(
      plannerReceipt,
      proposal.projectId,
    );
    expect(parsedRevision).not.toBe(revision);
    expect(parsedRevision.nodes).not.toBe(revision.nodes);
    expect(parsedRevision.nodes[0]).not.toBe(revision.nodes[0]);
    expect(parsedReceipt).not.toBe(plannerReceipt);
  });

  it.each([
    [
      "authority on model input",
      () =>
        parseConfirmArchitectureRequest({ ...confirmRequest, projectId: "x" }),
    ],
    [
      "unsupported schema",
      () =>
        parseConfirmArchitectureRequest({
          ...confirmRequest,
          schemaVersion: 2,
        }),
    ],
    [
      "unsafe proposal version",
      () =>
        parseConfirmArchitectureRequest({
          ...confirmRequest,
          expectedVersion: Number.MAX_SAFE_INTEGER + 1,
        }),
    ],
    [
      "malformed digest",
      () =>
        parseConfirmArchitectureRequest({
          ...confirmRequest,
          expectedDigest: "A",
        }),
    ],
    [
      "cross-project receipt",
      () => parsePlannerUserMessageReceipt(plannerReceipt, "another-project"),
    ],
    [
      "non-human receipt",
      () =>
        parsePlannerUserMessageReceipt(
          { ...plannerReceipt, origin: "assistant" },
          proposal.projectId,
        ),
    ],
    [
      "future approval",
      () =>
        parseAgentMapRevision(
          {
            ...revision,
            approval: { ...approval, approvedAt: "2026-09-02T12:00:01.000Z" },
          },
          proposal.projectId,
        ),
    ],
    [
      "broken graph reference",
      () =>
        parseAgentMapRevision(
          {
            ...revision,
            relationships: [
              {
                id: "rel_018f0000-0000-7000-8000-000000000001",
                fromNodeId: nodeId,
                toNodeId: "node_018f0000-0000-7000-8000-000000000099",
                kind: "invokes",
                executionMode: null,
                contractRef: null,
                description: "Broken",
              },
            ],
          },
          proposal.projectId,
        ),
    ],
    [
      "malformed revision identity",
      () =>
        parseAgentMapRevision(
          { ...revision, id: "revision_by_name" },
          proposal.projectId,
        ),
    ],
    [
      "control character in approval identity",
      () =>
        parseArchitectureApproval({
          ...approval,
          approvingMessageId: "message\u0000unsafe",
        }),
    ],
    [
      "missing first parent",
      () =>
        parseAgentMapRevisionRef({
          id: revisionId,
          revisionNumber: 2,
          parentRevisionId: null,
          digest,
          createdAt: acceptedAt,
        }),
    ],
    [
      "unknown nested result field",
      () =>
        parseConfirmArchitectureResult({
          schemaVersion: 1,
          outcome: "replayed",
          approvedProposal: {
            id: proposalId,
            version: 1,
            digest,
            path: "/tmp",
          },
          revision: {
            id: revisionId,
            revisionNumber: 1,
            parentRevisionId: null,
            digest,
            createdAt: acceptedAt,
          },
          workspaceRecordVersion: 2,
        }),
    ],
  ])("rejects %s", (_name, parse) => {
    expect(parse).toThrow();
  });
});
