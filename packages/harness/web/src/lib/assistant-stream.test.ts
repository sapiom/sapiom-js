/**
 * Unit tests for the assistant turn reducer.
 *
 * Pure, DOM-free — runs under vitest node (the same tier as the SPA's other
 * logic tests). Covers the turn-rendering fold the pane relies on: opening
 * turns, accumulating deltas, completion, ordering, and the honest-by-omission
 * handling of frames that arrive out of order or twice.
 */
import { describe, expect, it } from "vitest";

import {
  mockConversationScript,
  reduceTurns,
  reduceTurnSequence,
  type AssistantStreamEvent,
  type AssistantTurn,
} from "./assistant-stream";

describe("reduceTurns", () => {
  it("opens a streaming turn on turn.started", () => {
    const turns = reduceTurns([], {
      type: "turn.started",
      id: "a1",
      role: "assistant",
    });
    expect(turns).toEqual<AssistantTurn[]>([
      { id: "a1", role: "assistant", text: "", status: "streaming" },
    ]);
  });

  it("seeds text from turn.started (a whole-turn arrival, e.g. the user prompt)", () => {
    const turns = reduceTurns([], {
      type: "turn.started",
      id: "u1",
      role: "user",
      text: "hello",
    });
    expect(turns[0]).toMatchObject({
      role: "user",
      text: "hello",
      status: "streaming",
    });
  });

  it("appends deltas in arrival order", () => {
    const events: AssistantStreamEvent[] = [
      { type: "turn.started", id: "a1", role: "assistant" },
      { type: "turn.delta", id: "a1", text: "Hel" },
      { type: "turn.delta", id: "a1", text: "lo" },
    ];
    expect(reduceTurnSequence(events)[0].text).toBe("Hello");
  });

  it("marks a turn complete on turn.completed without touching its text", () => {
    const events: AssistantStreamEvent[] = [
      { type: "turn.started", id: "a1", role: "assistant" },
      { type: "turn.delta", id: "a1", text: "done" },
      { type: "turn.completed", id: "a1" },
    ];
    expect(reduceTurnSequence(events)[0]).toMatchObject({
      text: "done",
      status: "complete",
    });
  });

  it("preserves first-seen order across interleaved turns", () => {
    const events: AssistantStreamEvent[] = [
      { type: "turn.started", id: "u1", role: "user", text: "q" },
      { type: "turn.started", id: "a1", role: "assistant" },
      { type: "turn.delta", id: "a1", text: "answer" },
    ];
    const turns = reduceTurnSequence(events);
    expect(turns.map((t) => t.id)).toEqual(["u1", "a1"]);
  });

  it("ignores a delta for an unknown turn (never conjures one from a partial frame)", () => {
    const turns = reduceTurns([], {
      type: "turn.delta",
      id: "ghost",
      text: "x",
    });
    expect(turns).toEqual([]);
  });

  it("ignores a completion for an unknown turn", () => {
    const turns = reduceTurns([], { type: "turn.completed", id: "ghost" });
    expect(turns).toEqual([]);
  });

  it("treats a repeated turn.started as a no-op (a replayed opening frame can't duplicate)", () => {
    const once = reduceTurns([], {
      type: "turn.started",
      id: "a1",
      role: "assistant",
    });
    const twice = reduceTurns(once, {
      type: "turn.started",
      id: "a1",
      role: "assistant",
    });
    expect(twice).toHaveLength(1);
  });

  it("does not mutate the input array", () => {
    const before: AssistantTurn[] = [
      { id: "a1", role: "assistant", text: "a", status: "streaming" },
    ];
    const snapshot = structuredClone(before);
    reduceTurns(before, { type: "turn.delta", id: "a1", text: "b" });
    expect(before).toEqual(snapshot);
  });
});

describe("mockConversationScript", () => {
  it("folds into a completed user turn followed by a completed assistant turn", () => {
    const turns = reduceTurnSequence(
      mockConversationScript().map((frame) => frame.event),
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", status: "complete" });
    expect(turns[1]).toMatchObject({ role: "assistant", status: "complete" });
    // The assistant turn accumulated real content from its deltas.
    expect(turns[1].text.length).toBeGreaterThan(20);
  });
});
