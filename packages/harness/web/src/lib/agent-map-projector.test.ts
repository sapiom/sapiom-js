import { describe, expect, it } from "vitest";
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
    expect(
      latestNodeAttribution(result.snapshot, nodeId, renameDelta())?.actor.role,
    ).toBe("agent-builder");
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
