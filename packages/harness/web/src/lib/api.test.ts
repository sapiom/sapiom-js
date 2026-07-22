import { describe, expect, it } from "vitest";

import { parseNdjsonLine, terminalDeployEvent, type DeployStreamEvent } from "./api";

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

describe("parseNdjsonLine (deploy stream)", () => {
  it("parses a well-formed deploy event line", () => {
    expect(parseNdjsonLine<DeployStreamEvent>('{"phase":"building","definitionId":"42"}')).toEqual({
      phase: "building",
      definitionId: "42",
    });
  });

  it("drops a bare `null` line instead of forwarding it (SAP-1778 review)", () => {
    // JSON.parse("null") === null: a stray null line must be silently dropped,
    // never handed to the deploy consumer (where it could throw downstream).
    expect(parseNdjsonLine<DeployStreamEvent>("null")).toBeUndefined();
  });

  it("drops blank and non-JSON noise lines", () => {
    expect(parseNdjsonLine<DeployStreamEvent>("   ")).toBeUndefined();
    expect(parseNdjsonLine<DeployStreamEvent>("Build succeeded in 12ms")).toBeUndefined();
  });
});
