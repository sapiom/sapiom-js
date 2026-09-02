import { describe, expect, it } from "vitest";

import { proposalSnapshot, renameDelta } from "./agent-map-test-fixture";
import { shouldCommitAcceptedDelta } from "./use-agent-map-entry";

describe("shouldCommitAcceptedDelta", () => {
  it("rejects a superseded request before either state or telemetry can commit", () => {
    const snapshot = proposalSnapshot();
    const delta = renameDelta();
    const projectId = snapshot.project.projectId;

    expect(
      shouldCommitAcceptedDelta(projectId, projectId, 2, 1, snapshot, delta),
    ).toBe(false);
  });

  it("accepts the owning request once the announced version is visible", () => {
    const snapshot = proposalSnapshot();
    const delta = renameDelta(0);
    const projectId = snapshot.project.projectId;

    expect(
      shouldCommitAcceptedDelta(projectId, projectId, 1, 1, snapshot, delta),
    ).toBe(true);
  });
});
