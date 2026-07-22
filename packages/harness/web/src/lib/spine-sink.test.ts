/**
 * Unit tests for the spine sink reducer (SAP-1804 spike) — the "test SPA sink"
 * the spine streams into. DOM-free; just folds bus messages.
 */
import { describe, expect, it } from "vitest";
import type { BusMessage } from "@shared/types";

import {
  emptySpineSink,
  foldSpineMessage,
  spineRuns,
  type SpineSinkState,
} from "./spine-sink";

/** Fold a whole sequence of messages from empty. */
function foldAll(messages: BusMessage[]): SpineSinkState {
  return messages.reduce(foldSpineMessage, emptySpineSink());
}

describe("foldSpineMessage", () => {
  it("accumulates a full run: started → frames → finished", () => {
    const state = foldAll([
      { type: "spine.started", spineRunId: "r1", executionId: "exec_1" },
      {
        type: "spine.frame",
        spineRunId: "r1",
        executionId: "exec_1",
        frame: { step: { id: "s1", name: "explain", status: "running" } },
      },
      {
        type: "spine.frame",
        spineRunId: "r1",
        executionId: "exec_1",
        frame: { step: { id: "s1", name: "explain", status: "passed" } },
      },
      {
        type: "spine.finished",
        spineRunId: "r1",
        executionId: "exec_1",
        status: "completed",
      },
    ]);

    const run = state.get("r1");
    expect(run).toBeDefined();
    expect(run?.executionId).toBe("exec_1");
    expect(run?.status).toBe("completed");
    expect(run?.frames.map((f) => f.step.status)).toEqual([
      "running",
      "passed",
    ]);
  });

  it("records an error, keeping any frames already seen", () => {
    const state = foldAll([
      { type: "spine.started", spineRunId: "r1", executionId: "exec_1" },
      {
        type: "spine.frame",
        spineRunId: "r1",
        executionId: "exec_1",
        frame: { step: { id: "s1", name: "explain", status: "running" } },
      },
      { type: "spine.error", spineRunId: "r1", error: "gateway responded 500" },
    ]);

    const run = state.get("r1");
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("gateway responded 500");
    expect(run?.frames).toHaveLength(1);
  });

  it("handles a start-failure error with no prior frames (executionId null)", () => {
    const state = foldAll([
      { type: "spine.error", spineRunId: "r1", error: "not signed in" },
    ]);

    const run = state.get("r1");
    expect(run?.status).toBe("error");
    expect(run?.executionId).toBeNull();
    expect(run?.frames).toEqual([]);
  });

  it("keeps runs separate by spineRunId", () => {
    const state = foldAll([
      { type: "spine.started", spineRunId: "r1", executionId: "e1" },
      { type: "spine.started", spineRunId: "r2", executionId: "e2" },
      {
        type: "spine.frame",
        spineRunId: "r2",
        executionId: "e2",
        frame: { step: { id: "s1", name: "debug", status: "running" } },
      },
    ]);

    expect(spineRuns(state)).toHaveLength(2);
    expect(state.get("r1")?.frames).toEqual([]);
    expect(state.get("r2")?.frames).toHaveLength(1);
  });

  it("returns the SAME reference for a non-spine message", () => {
    const before = foldAll([
      { type: "spine.started", spineRunId: "r1", executionId: "e1" },
    ]);
    const after = foldSpineMessage(before, {
      type: "workflows.changed",
    });
    expect(after).toBe(before);
  });
});
