import { describe, expect, it } from "vitest";

import { terminalDeployEvent, type DeployStreamEvent } from "./api";

describe("terminalDeployEvent", () => {
  it("returns the terminal ready event", () => {
    const events: DeployStreamEvent[] = [
      { phase: "building", definitionId: "42" },
      { phase: "ready", definitionId: "42", buildRunId: "b1", status: "succeeded" },
    ];
    expect(terminalDeployEvent(events)).toEqual({
      phase: "ready",
      definitionId: "42",
      buildRunId: "b1",
      status: "succeeded",
    });
  });

  it("returns the terminal error event", () => {
    const events: DeployStreamEvent[] = [
      { phase: "building", definitionId: "42" },
      { phase: "error", code: "BUILD_FAILED", message: "boom" },
    ];
    expect(terminalDeployEvent(events)).toEqual({ phase: "error", code: "BUILD_FAILED", message: "boom" });
  });

  it("returns the LAST terminal event when more than one is present", () => {
    // Defensive: pick the final terminal line, not the first.
    const events: DeployStreamEvent[] = [
      { phase: "error", code: "A", message: "first" },
      { phase: "ready", definitionId: "42", buildRunId: "b1", status: "succeeded" },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({ phase: "ready" });
  });

  it("synthesizes an error when the stream carried no terminal line", () => {
    // A stream that only ever said "building" (server died mid-build) still
    // yields a definite failure outcome, never a building line.
    const events: DeployStreamEvent[] = [{ phase: "building", definitionId: "42" }];
    expect(terminalDeployEvent(events)).toEqual({
      phase: "error",
      code: "NO_OUTPUT",
      message: "deploy produced no terminal status",
    });
  });

  it("synthesizes an error for an empty stream", () => {
    expect(terminalDeployEvent([])).toMatchObject({ phase: "error", code: "NO_OUTPUT" });
  });
});
