import { describe, expect, it } from "vitest";

import type { PlanNode, PlanNodeId } from "../shared/agent-map.js";
import {
  computeProjectPlanningAggregateDigest,
  migrateProjectPlanningAggregate,
  parseProjectPlanningAggregate,
} from "./agent-map-aggregate-migration.js";

const projectId = "project_018f0000-0000-4000-8000-000000000001";
const proposalId = "proposal_018f0000-0000-7000-8000-000000000002";
const nodeId = "node_018f0000-0000-7000-8000-000000000010";
const operationOne = "operation_018f0000-0000-7000-8000-000000000020";
const operationTwo = "operation_018f0000-0000-7000-8000-000000000021";
const createdAt = "2026-01-02T03:04:05.000Z";
const updatedAt = "2026-01-02T03:05:05.000Z";

const node: PlanNode = {
  id: nodeId as PlanNodeId,
  kind: "agent",
  name: "Market Research",
  purpose: "Find the top ten stocks trading today.",
  ownerAgentId: null,
  contractRefs: [],
};

function legacyE2() {
  return {
    storageSchemaVersion: 1,
    workspace: {
      projectId,
      schemaVersion: 1,
      recordVersion: 9,
      confirmedRevisionId: null,
      activeProposalId: proposalId,
      projectBuildPlanId: null,
      createdAt,
      updatedAt,
    },
    proposal: {
      schemaVersion: 1,
      id: proposalId,
      projectId,
      baseRevisionId: null,
      version: 2,
      nodes: [node],
      relationships: [],
      history: [
        {
          id: operationOne,
          requestId: "request-one",
          acceptedVersion: 1,
          operation: { kind: "add-node", node },
          actor: { userId: "user-one", sessionId: "session-one", role: "map-planner", assignment: null },
          acceptedAt: createdAt,
        },
        {
          id: operationTwo,
          requestId: "request-two",
          acceptedVersion: 2,
          operation: { kind: "update-node", nodeId, changes: { purpose: node.purpose } },
          actor: {
            userId: "user-two",
            sessionId: "session-two",
            role: "agent-builder",
            assignment: { kind: "unplanned" },
          },
          acceptedAt: updatedAt,
        },
      ],
      createdAt,
      updatedAt,
    },
    receipts: [
      {
        sessionId: "session-two",
        requestId: "request-two",
        requestDigest: "2".repeat(64),
        version: 2,
        allocatedNodeIds: {},
        allocatedRelationshipIds: {},
      },
    ],
  };
}

describe("project planning aggregate migration", () => {
  it("migrates exact empty E1 state without inventing versions or changing record metadata", () => {
    const raw = {
      projectId,
      schemaVersion: 1,
      recordVersion: 7,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt,
      updatedAt,
    };
    const { aggregate, migrated } = migrateProjectPlanningAggregate(raw, projectId);
    expect(migrated).toBe(true);
    expect(aggregate).toMatchObject({
      storageSchemaVersion: 2,
      projectId,
      recordVersion: 7,
      current: { map: null, buildPlan: null, briefsByScope: {} },
      mapVersions: [],
      buildPlanVersions: [],
      briefVersionsById: {},
      createdAt,
      updatedAt,
    });
  });

  it("rejects dangling E1 pointers instead of persisting unreconstructable state", () => {
    expect(() => migrateProjectPlanningAggregate({
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: proposalId,
      projectBuildPlanId: null,
      createdAt,
      updatedAt,
    }, projectId)).toThrowError(expect.objectContaining({ code: "malformed_state" }));
  });

  it("deterministically migrates populated E2 history, neutralizes actors, and preserves no-op provenance", () => {
    const first = migrateProjectPlanningAggregate(legacyE2(), projectId).aggregate;
    const second = migrateProjectPlanningAggregate(legacyE2(), projectId).aggregate;

    expect(first).toEqual(second);
    expect(first.recordVersion).toBe(9);
    expect(first.mapVersions).toHaveLength(1);
    expect(first.mapVersions[0]).toMatchObject({
      version: 1,
      graph: { nodes: [node], relationships: [] },
      authoredBy: { userId: "user-one", sessionId: "session-one" },
      origin: {
        kind: "migration",
        legacyProposalId: proposalId,
        legacyAcceptedVersion: 1,
        operationIds: [operationOne],
      },
    });
    expect(first.mapOperationHistory).toHaveLength(2);
    expect(first.mapOperationHistory.map(({ actor }) => actor)).toEqual([
      { userId: "user-one", sessionId: "session-one" },
      { userId: "user-two", sessionId: "session-two" },
    ]);
    expect(first.requestTombstones).toEqual([
      expect.objectContaining({ userId: "user-one", sessionId: "session-one", requestId: "request-one" }),
    ]);
    expect(first.requestReceipts[0]?.result).toMatchObject({
      schemaVersion: 1,
      proposalId,
      version: 2,
      operationIds: [operationTwo],
      delta: {
        projectId,
        proposalId,
        fromVersion: 1,
        version: 2,
        actor: { userId: "user-two", sessionId: "session-two" },
        operations: [{ kind: "update-node", nodeId, changes: { purpose: node.purpose } }],
      },
    });
    expect(first.buildPlanVersions).toEqual([]);
    expect(first.briefVersionsById).toEqual({});
    expect(first.current.briefsByScope).toEqual({});
  });

  it("rejects an E2 snapshot that does not equal strict operation replay", () => {
    const raw = legacyE2();
    raw.proposal.nodes[0] = { ...node, name: "Tampered" };
    expect(() => migrateProjectPlanningAggregate(raw, projectId)).toThrowError(
      expect.objectContaining({ code: "malformed_state" }),
    );
  });

  it("rejects corrupted final records even when an attacker refreshes the aggregate digest", () => {
    const aggregate = migrateProjectPlanningAggregate(legacyE2(), projectId).aggregate;
    aggregate.mapVersions[0]!.graph.nodes[0]!.purpose = "Tampered";
    aggregate.aggregateDigest = computeProjectPlanningAggregateDigest(aggregate);
    expect(() => parseProjectPlanningAggregate(aggregate, projectId)).toThrowError(
      expect.objectContaining({ code: "malformed_state" }),
    );
  });

  it("rejects future outer schemas without attempting downgrade", () => {
    expect(() => migrateProjectPlanningAggregate({ storageSchemaVersion: 3 }, projectId)).toThrowError(
      expect.objectContaining({ code: "unsupported_schema", schemaVersion: 3 }),
    );
  });

  it("reports future nested immutable record schemas without rewriting them as corruption", () => {
    const aggregate = migrateProjectPlanningAggregate({
      projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
      createdAt,
      updatedAt,
    }, projectId).aggregate as unknown as Record<string, unknown>;
    aggregate.mapVersions = [{ schemaVersion: 2 }];
    aggregate.aggregateDigest = computeProjectPlanningAggregateDigest(aggregate as never);
    expect(() => parseProjectPlanningAggregate(aggregate, projectId)).toThrowError(
      expect.objectContaining({ code: "unsupported_schema", schemaVersion: 2 }),
    );
  });
});
