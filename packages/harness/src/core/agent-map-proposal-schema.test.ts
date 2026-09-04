import { describe, expect, it } from "vitest";

import type {
  AcceptedProposalDelta,
  AgentMapReadSnapshot,
  MapChangeProposal,
  MapProposalId,
  ProposalOperationId,
  ProposalBatchResult,
} from "../shared/agent-map.js";
import {
  parseProposalBatchRequest,
  proposalBatchRequestSchema,
} from "./agent-map-proposal-schema.js";

const nodeId = "node_018f0000-0000-7000-8000-000000000001";
const relationshipId = "rel_018f0000-0000-7000-8000-000000000001";
const proposalId =
  "proposal_018f0000-0000-7000-8000-000000000001" as MapProposalId;
const operationId =
  "operation_018f0000-0000-7000-8000-000000000001" as ProposalOperationId;

const allOperations = {
  schemaVersion: 1,
  proposalId,
  expectedVersion: 4,
  requestId: "request_4",
  operations: [
    {
      kind: "add-node",
      draftRef: "new_agent",
      node: {
        kind: "agent",
        name: "Research",
        purpose: "Find market signals",
        ownerAgent: null,
        contractRefs: ["contract/research-v1"],
      },
    },
    {
      kind: "update-node",
      nodeId,
      changes: { name: "Market Research", contractRefs: [] },
    },
    { kind: "remove-node", nodeId },
    {
      kind: "add-relationship",
      draftRef: "new_edge",
      relationship: {
        from: { draftRef: "new_agent" },
        to: { nodeId },
        kind: "invokes",
        executionMode: "asynchronous",
        contractRef: null,
        description: "Delegates publishing",
      },
    },
    {
      kind: "update-relationship",
      relationshipId,
      changes: { description: "Updated", executionMode: null },
    },
    { kind: "remove-relationship", relationshipId },
  ],
};

describe("Agent Map proposal caller schema", () => {
  it("strictly parses every operation variant", () => {
    const parsed = parseProposalBatchRequest(allOperations);
    expect(parsed).toEqual({ ok: true, value: allOperations });
    expect(proposalBatchRequestSchema.safeParse(allOperations).success).toBe(
      true,
    );
  });

  it("returns a bounded unsupported-version issue", () => {
    expect(
      parseProposalBatchRequest({ ...allOperations, schemaVersion: 2 }),
    ).toEqual({
      ok: false,
      issues: [
        {
          code: "unsupported_schema",
          operationIndex: null,
          path: ["schemaVersion"],
          recovery: "correct",
        },
      ],
    });
  });

  it.each([
    ["project authority", { projectId: "project_1" }, "immutable_field"],
    ["actor authority", { actor: { authority: "forged" } }, "immutable_field"],
    ["unknown root field", { unexpected: true }, "malformed_input"],
  ])("rejects %s rather than stripping it", (_name, extra, code) => {
    const parsed = parseProposalBatchRequest({ ...allOperations, ...extra });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.code).toBe(code);
  });

  it("rejects immutable structural patches with an operation path", () => {
    const parsed = parseProposalBatchRequest({
      ...allOperations,
      operations: [
        {
          kind: "update-node",
          nodeId,
          changes: { ownerAgentId: nodeId },
        },
      ],
    });
    expect(parsed).toEqual({
      ok: false,
      issues: [
        {
          code: "immutable_field",
          operationIndex: 0,
          path: ["operations", 0, "changes", "ownerAgentId"],
          recovery: "correct",
        },
      ],
    });
  });

  it("drops explicit undefined patch fields before accepting updates", () => {
    const parsed = parseProposalBatchRequest({
      ...allOperations,
      operations: [
        {
          kind: "update-node",
          nodeId,
          changes: { name: undefined, purpose: "Defined purpose" },
        },
        {
          kind: "update-relationship",
          relationshipId,
          changes: { description: undefined, executionMode: null },
        },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        ...allOperations,
        operations: [
          {
            kind: "update-node",
            nodeId,
            changes: { purpose: "Defined purpose" },
          },
          {
            kind: "update-relationship",
            relationshipId,
            changes: { executionMode: null },
          },
        ],
      },
    });
  });

  it("rejects a patch containing only explicit undefined values", () => {
    const parsed = parseProposalBatchRequest({
      ...allOperations,
      operations: [
        {
          kind: "update-node",
          nodeId,
          changes: { name: undefined },
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual([
        {
          code: "malformed_input",
          operationIndex: 0,
          path: ["operations", 0, "changes"],
          recovery: "correct",
        },
      ]);
    }
  });

  it.each([
    ["empty batch", { ...allOperations, operations: [] }, "empty_batch"],
    [
      "derived id",
      { ...allOperations, proposalId: "proposal_by_name" },
      "malformed_input",
    ],
    [
      "whitespace",
      { ...allOperations, requestId: " request_4" },
      "malformed_input",
    ],
    [
      "control text",
      {
        ...allOperations,
        operations: [
          {
            ...(allOperations.operations[0] as Record<string, unknown>),
            node: {
              ...(allOperations.operations[0] as { node: object }).node,
              purpose: "unsafe\u0000text",
            },
          },
        ],
      },
      "malformed_input",
    ],
    [
      "capability nodes",
      {
        ...allOperations,
        operations: [
          {
            ...(allOperations.operations[0] as Record<string, unknown>),
            node: {
              ...(allOperations.operations[0] as { node: object }).node,
              kind: "capability",
            },
          },
        ],
      },
      "malformed_input",
    ],
  ])("rejects %s without echoing input", (_name, input, code) => {
    const parsed = parseProposalBatchRequest(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]?.code).toBe(code);
      expect(JSON.stringify(parsed.issues)).not.toContain("unsafe");
    }
  });

  it("keeps public result, delta, proposal, and snapshot contracts path-free", () => {
    const delta = {
      schemaVersion: 1,
      projectId: "project_1",
      proposalId,
      fromVersion: 0,
      version: 1,
      operationIds: [operationId],
      operations: [],
      actor: {
        userId: "user_1",
        sessionId: "session_1",
      },
      acceptedAt: "2026-09-02T00:00:00.000Z",
    } satisfies AcceptedProposalDelta;
    const proposal = {
      schemaVersion: 1,
      id: proposalId,
      projectId: "project_1",
      baseRevisionId: null,
      version: 1,
      nodes: [],
      relationships: [],
      history: [],
      createdAt: delta.acceptedAt,
      updatedAt: delta.acceptedAt,
    } satisfies MapChangeProposal;
    const result = {
      schemaVersion: 1,
      proposalId,
      version: 1,
      operationIds: delta.operationIds,
      allocatedNodeIds: {},
      allocatedRelationshipIds: {},
      delta,
    } satisfies ProposalBatchResult;
    const snapshot = {
      schemaVersion: 1,
      project: {
        projectId: "project_1",
        identityVersion: 1,
        displayName: "Project",
        bindings: [],
        createdAt: delta.acceptedAt,
        updatedAt: delta.acceptedAt,
      },
      workspace: {
        projectId: "project_1",
        schemaVersion: 1,
        recordVersion: 2,
        confirmedRevisionId: null,
        activeProposalId: proposalId,
        projectBuildPlanId: null,
        createdAt: delta.acceptedAt,
        updatedAt: delta.acceptedAt,
      },
      proposal,
    } satisfies AgentMapReadSnapshot;

    expect(JSON.stringify({ result, snapshot })).not.toMatch(
      /(?:localRoot|repositoryUrl|filesystem|sourcePath|cwd)/iu,
    );
  });
});
