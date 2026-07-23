import { describe, it, expect } from "vitest";

import {
  describeStep,
  errorMessage,
  toolCall,
  toolResult,
  turnCompleted,
  turnDelta,
  turnStarted,
} from "./assistant-messages.js";
import type { StepView } from "../shared/types.js";

function step(overrides: Partial<StepView> = {}): StepView {
  return { id: "s0", name: "enrich", status: "running", ...overrides };
}

describe("assistant-messages — pure shaping", () => {
  it("toolCall carries the tool name and input verbatim", () => {
    expect(toolCall("d1", "explain-agent", { agentId: "a1" })).toEqual({
      type: "assistant.tool_call",
      dispatchId: "d1",
      tool: "explain-agent",
      input: { agentId: "a1" },
    });
  });

  it("turnStarted omits text when none is given (a streamed turn)", () => {
    expect(turnStarted("d1", "t1", "assistant")).toEqual({
      type: "assistant.turn",
      dispatchId: "d1",
      turnId: "t1",
      frame: { kind: "started", role: "assistant" },
    });
  });

  it("turnStarted seeds text when a whole turn arrives", () => {
    expect(turnStarted("d1", "t1", "user", "hi")).toEqual({
      type: "assistant.turn",
      dispatchId: "d1",
      turnId: "t1",
      frame: { kind: "started", role: "user", text: "hi" },
    });
  });

  it("turnDelta appends text under the same turn id", () => {
    expect(turnDelta("d1", "t1", "more")).toEqual({
      type: "assistant.turn",
      dispatchId: "d1",
      turnId: "t1",
      frame: { kind: "delta", text: "more" },
    });
  });

  it("turnCompleted closes the turn", () => {
    expect(turnCompleted("d1", "t1")).toEqual({
      type: "assistant.turn",
      dispatchId: "d1",
      turnId: "t1",
      frame: { kind: "completed" },
    });
  });

  it("toolResult threads executionId + status when observed", () => {
    expect(
      toolResult("d1", "explain-agent", {
        ok: true,
        executionId: "exec_1",
        status: "completed",
      }),
    ).toEqual({
      type: "assistant.tool_result",
      dispatchId: "d1",
      tool: "explain-agent",
      ok: true,
      executionId: "exec_1",
      status: "completed",
    });
  });

  it("toolResult omits executionId/status on a start failure (honest absence)", () => {
    const message = toolResult("d1", "explain-agent", { ok: false });
    expect(message).toEqual({
      type: "assistant.tool_result",
      dispatchId: "d1",
      tool: "explain-agent",
      ok: false,
    });
    // Not present at all — never a fake id or a null placeholder.
    expect("executionId" in message).toBe(false);
    expect("status" in message).toBe(false);
  });

  it("errorMessage carries the reason", () => {
    expect(errorMessage("d1", "boom")).toEqual({
      type: "assistant.error",
      dispatchId: "d1",
      error: "boom",
    });
  });

  describe("describeStep", () => {
    it("narrates each status honestly from the StepView", () => {
      expect(describeStep(step({ status: "pending" }))).toBe("enrich: queued\n");
      expect(describeStep(step({ status: "running" }))).toBe("enrich: running…\n");
      expect(describeStep(step({ status: "passed" }))).toBe("enrich: done\n");
    });

    it("includes a recorded error on a failed step", () => {
      expect(describeStep(step({ status: "failed", error: "timeout" }))).toBe(
        "enrich: failed — timeout\n",
      );
    });

    it("omits the dash when a failed step recorded no error", () => {
      expect(describeStep(step({ status: "failed" }))).toBe("enrich: failed\n");
    });
  });
});
