import { describe, expect, it } from "vitest";

import {
  parseAgentMapProposalReceipt,
  parseMapChangeProposal,
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
});
