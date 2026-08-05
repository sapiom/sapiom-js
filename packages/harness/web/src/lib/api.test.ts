import { describe, expect, it } from "vitest";

import {
  parseNdjsonLine,
  progressiveLeasingRun,
  PROGRESSIVE_STEP_MS,
  terminalDeployEvent,
  type DeployStreamEvent,
} from "./api";

describe("progressiveLeasingRun", () => {
  const at = (elapsed: number) => progressiveLeasingRun("exec-mock-prod-1", elapsed);

  it("starts with the first step running, the rest pending, and no latencies", () => {
    const run = at(0);
    expect(run.status).toBe("running");
    expect(run.steps.map((s) => s.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    // Honest-absence: nothing has finished, so no step reports a duration.
    expect(run.steps.every((s) => s.latencyMs === undefined)).toBe(true);
  });

  it("advances monotonically: earlier steps pass before later ones", () => {
    // Two steps in: step 0 passed (with its latency), step 1 running (no latency).
    const run = at(PROGRESSIVE_STEP_MS + 10);
    expect(run.status).toBe("running");
    expect(run.steps[0].status).toBe("passed");
    expect(run.steps[0].latencyMs).toBeGreaterThan(0);
    expect(run.steps[1].status).toBe("running");
    expect(run.steps[1].latencyMs).toBeUndefined();
  });

  it("reports a running step with NO latencyMs, a passed step WITH it", () => {
    const run = at(PROGRESSIVE_STEP_MS * 2 + 10);
    for (const step of run.steps) {
      if (step.status === "running" || step.status === "pending") {
        expect(step.latencyMs).toBeUndefined();
      }
      if (step.status === "passed") expect(step.latencyMs).toBeGreaterThan(0);
    }
  });

  it("terminates as completed with every step passed and no cost fields", () => {
    const run = at(PROGRESSIVE_STEP_MS * 6);
    expect(run.status).toBe("completed");
    expect(run.steps.every((s) => s.status === "passed")).toBe(true);
    expect(JSON.stringify(run)).not.toMatch(/\$|cost/i);
  });
});

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

  it("treats a linking line as non-terminal", async () => {
    // The server emits `linking` before `building` when it has to create the
    // agent; only ready/error may end the stream.
    const events: DeployStreamEvent[] = [
      { phase: "linking", name: "order-triage" },
      { phase: "building", definitionId: "42" },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({ phase: "error", code: "NO_OUTPUT" });
  });

  it("treats a warning line as non-terminal", async () => {
    // `warning` is advisory (the agent was created but its id couldn't be
    // written to sapiom.json) — it never closes the stream on its own.
    const events: DeployStreamEvent[] = [
      { phase: "linking", name: "order-triage" },
      { phase: "warning", message: "Couldn't save the agent id to sapiom.json." },
      { phase: "building", definitionId: "42" },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({ phase: "error", code: "NO_OUTPUT" });
  });
});

describe("parseNdjsonLine (deploy stream)", () => {
  it("parses a well-formed deploy event line", () => {
    expect(parseNdjsonLine<DeployStreamEvent>('{"phase":"building","definitionId":"42"}')).toEqual({
      phase: "building",
      definitionId: "42",
    });
  });

  it("drops a bare `null` line instead of forwarding it", () => {
    // JSON.parse("null") === null: a stray null line must be silently dropped,
    // never handed to the deploy consumer (where it could throw downstream).
    expect(parseNdjsonLine<DeployStreamEvent>("null")).toBeUndefined();
  });

  it("drops blank and non-JSON noise lines", () => {
    expect(parseNdjsonLine<DeployStreamEvent>("   ")).toBeUndefined();
    expect(parseNdjsonLine<DeployStreamEvent>("Build succeeded in 12ms")).toBeUndefined();
  });
});
