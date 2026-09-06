import { describe, expect, it } from "vitest";
import type {
  AcceptedProposalDelta,
  PlanNodeId,
  ProposalOperationId,
} from "@shared/agent-map";
import {
  applyAcceptedProposalDelta,
  latestNodeAttribution,
} from "./agent-map-projector";
import {
  proposalNodeId as nodeId,
  proposalSnapshot,
  renameDelta,
} from "./agent-map-test-fixture";

describe("applyAcceptedProposalDelta", () => {
  it("bootstraps the first proposal atomically from an all-add version-zero delta", () => {
    const source = proposalSnapshot();
    const firstOperation = source.proposal!.history[0]!;
    expect(firstOperation.operation.kind).toBe("add-node");
    if (firstOperation.operation.kind !== "add-node") return;
    const snapshot = structuredClone(source);
    snapshot.workspace.recordVersion = 1;
    snapshot.workspace.activeProposalId = null;
    snapshot.proposal = null;
    const delta: AcceptedProposalDelta = {
      schemaVersion: 1,
      projectId: source.project.projectId,
      proposalId: source.proposal!.id,
      fromVersion: 0,
      version: 1,
      operationIds: [firstOperation.id],
      operations: [firstOperation.operation],
      actor: firstOperation.actor,
      acceptedAt: firstOperation.acceptedAt,
    };

    const result = applyAcceptedProposalDelta(snapshot, delta);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.snapshot.workspace).toMatchObject({
      recordVersion: 2,
      activeProposalId: delta.proposalId,
    });
    expect(result.snapshot.proposal).toMatchObject({
      id: delta.proposalId,
      version: 1,
      nodes: [firstOperation.operation.node],
      history: [{ id: firstOperation.id, acceptedVersion: 1 }],
    });
    expect(
      latestNodeAttribution(result.snapshot, firstOperation.operation.node.id)
        ?.actor,
    ).toEqual({ userId: "user", sessionId: "planner" });
  });

  it("refetches rather than bootstrapping an empty proposal with a mutation", () => {
    const source = proposalSnapshot();
    const snapshot = structuredClone(source);
    snapshot.workspace.activeProposalId = null;
    snapshot.proposal = null;
    const delta = renameDelta(0);

    expect(applyAcceptedProposalDelta(snapshot, delta)).toEqual({
      status: "needs-refetch",
      snapshot,
    });
  });

  it("refetches rather than truncating a confirmed base during bootstrap", () => {
    const source = proposalSnapshot();
    const firstOperation = source.proposal!.history[0]!;
    const snapshot = structuredClone(source);
    snapshot.workspace.confirmedRevisionId = "revision-confirmed";
    snapshot.workspace.activeProposalId = null;
    snapshot.proposal = null;
    const delta: AcceptedProposalDelta = {
      schemaVersion: 1,
      projectId: source.project.projectId,
      proposalId: source.proposal!.id,
      fromVersion: 0,
      version: 1,
      operationIds: [firstOperation.id],
      operations: [firstOperation.operation],
      actor: firstOperation.actor,
      acceptedAt: firstOperation.acceptedAt,
    };

    expect(applyAcceptedProposalDelta(snapshot, delta)).toEqual({
      status: "needs-refetch",
      snapshot,
    });
  });

  it("applies one complete contiguous batch and preserves stable selection", () => {
    const result = applyAcceptedProposalDelta(
      proposalSnapshot(),
      renameDelta(),
      nodeId,
    );
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.snapshot.proposal?.version).toBe(2);
    expect(result.snapshot.proposal?.nodes[0]?.name).toBe("Market Research");
    expect(result.selection).toBe(nodeId);
    expect(latestNodeAttribution(result.snapshot, nodeId)?.actor).toEqual({
      userId: "user",
      sessionId: "builder",
    });
  });

  it("retains earlier node attribution after a later delta touches another node", () => {
    const first = applyAcceptedProposalDelta(proposalSnapshot(), renameDelta());
    expect(first.status).toBe("applied");
    if (first.status !== "applied") return;
    const second: AcceptedProposalDelta = {
      ...renameDelta(2),
      operationIds: [
        "operation_00000000-0000-7000-8000-000000000005" as ProposalOperationId,
      ],
      operations: [
        {
          kind: "add-node",
          node: {
            id: "node_00000000-0000-7000-8000-000000000006" as PlanNodeId,
            kind: "artifact",
            name: "Brief",
            purpose: "Carry a later result",
            ownerAgentId: null,
            contractRefs: [],
          },
        },
      ],
      actor: {
        userId: "user",
        sessionId: "planner",
      },
      acceptedAt: "2026-09-02T10:00:02.000Z",
    };
    const projected = applyAcceptedProposalDelta(first.snapshot, second);
    expect(projected.status).toBe("applied");
    if (projected.status !== "applied") return;
    expect(projected.snapshot.proposal?.history).toHaveLength(3);
    expect(latestNodeAttribution(projected.snapshot, nodeId)?.actor).toEqual({
      userId: "user",
      sessionId: "builder",
    });
  });

  it("rejects gaps atomically without changing the prior snapshot", () => {
    const snapshot = proposalSnapshot();
    const result = applyAcceptedProposalDelta(snapshot, renameDelta(3), nodeId);
    expect(result).toEqual({ status: "needs-refetch", snapshot });
    expect(snapshot.proposal?.nodes[0]?.name).toBe("Research");
  });

  it("ignores a foreign project instead of contaminating this projection", () => {
    const snapshot = proposalSnapshot();
    expect(
      applyAcceptedProposalDelta(snapshot, {
        ...renameDelta(),
        projectId: "project_00000000-0000-4000-8000-000000000002",
      }).status,
    ).toBe("ignored");
  });
});
