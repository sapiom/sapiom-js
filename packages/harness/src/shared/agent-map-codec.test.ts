import { describe, expect, it } from "vitest";

import {
  mapChangeProposalSchema,
  proposalReceiptSchema,
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
const delta = {
  schemaVersion: 1,
  projectId: "project_00000000-0000-4000-8000-000000000001",
  proposalId,
  fromVersion: 0,
  version: 1,
  operationIds: [operationId],
  operations: [operation],
  actor,
  acceptedAt,
};
const proposal = {
  schemaVersion: 1,
  id: proposalId,
  projectId: delta.projectId,
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
  result: {
    schemaVersion: 1,
    proposalId,
    version: 1,
    operationIds: [operationId],
    allocatedNodeIds: { research: nodeId },
    allocatedRelationshipIds: {},
    delta,
  },
  touchSet: { entityKeys: [], semanticRelationshipKeys: [] },
};

describe("Agent Map persisted/public codecs", () => {
  it("accepts the complete exact nested proposal and receipt", () => {
    expect(mapChangeProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposalReceiptSchema.safeParse(receipt).success).toBe(true);
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
    expect(mapChangeProposalSchema.safeParse(value).success).toBe(false);
  });

  it("rejects corrupt private receipt results", () => {
    const value = structuredClone(receipt) as any;
    value.result.delta.operations[0].node.ownerAgentId = "foreign";
    expect(proposalReceiptSchema.safeParse(value).success).toBe(false);
  });
});
