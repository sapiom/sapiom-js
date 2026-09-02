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
    expect(latestNodeAttribution(result.snapshot, nodeId)?.actor.role).toBe(
      "agent-builder",
    );
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
        role: "map-planner",
        assignment: null,
      },
      acceptedAt: "2026-09-02T10:00:02.000Z",
    };
    const projected = applyAcceptedProposalDelta(first.snapshot, second);
    expect(projected.status).toBe("applied");
    if (projected.status !== "applied") return;
    expect(projected.snapshot.proposal?.history).toHaveLength(3);
    expect(latestNodeAttribution(projected.snapshot, nodeId)?.actor.role).toBe(
      "agent-builder",
    );
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
