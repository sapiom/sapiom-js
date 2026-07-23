import { describe, it, expect } from "vitest";

import {
  createToolDispatcher,
  createToolRegistry,
  type ToolRegistry,
} from "./tool-dispatcher.js";
import type { SpineClient, SpineRunResult } from "./spine-client.js";
import type { BusMessage, StepView } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects every published BusMessage for order/shape assertions. */
function fakeBus(): { publish: (m: BusMessage) => void; messages: BusMessage[] } {
  const messages: BusMessage[] = [];
  return { publish: (m) => messages.push(m), messages };
}

interface FakeClientScript {
  /** Frames to replay via onFrame before resolving. */
  frames?: StepView[];
  /** The terminal result run() resolves with. */
  result: SpineRunResult;
  /** When set, run() rejects with this instead of resolving. */
  throwWith?: Error;
}

/** A SpineClient that replays a fixed script and records how it was called. */
function fakeClient(
  script: FakeClientScript,
): { client: SpineClient; calls: () => { definitionId: string; input: unknown }[] } {
  const calls: { definitionId: string; input: unknown }[] = [];
  const client: SpineClient = {
    async run(definitionId, input, handlers) {
      calls.push({ definitionId, input });
      if (script.throwWith) throw script.throwWith;
      for (const step of script.frames ?? []) handlers?.onFrame?.({ step });
      return script.result;
    },
  };
  return { client, calls: () => calls };
}

const REGISTRY: ToolRegistry = createToolRegistry([
  { name: "explain-agent", definitionId: "def_explain" },
  { name: "debug-step", definitionId: "def_debug" },
]);

const ids = () => {
  let d = 0;
  let t = 0;
  return {
    generateDispatchId: () => `d${++d}`,
    generateTurnId: () => `t${++t}`,
  };
};

function step(overrides: Partial<StepView> = {}): StepView {
  return { id: "s0", name: "explain", status: "passed", ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolRegistry", () => {
  it("rejects duplicate tool names", () => {
    expect(() =>
      createToolRegistry([
        { name: "dup", definitionId: "a" },
        { name: "dup", definitionId: "b" },
      ]),
    ).toThrow(/duplicate tool name/);
  });
});

describe("createToolDispatcher", () => {
  it("resolves a named tool to its workflow and streams the full exchange", async () => {
    const bus = fakeBus();
    const { client, calls } = fakeClient({
      frames: [step({ name: "explain", status: "running" }), step({ name: "explain", status: "passed" })],
      result: { ok: true, executionId: "exec_1", status: "completed" },
    });

    const dispatcher = createToolDispatcher({
      registry: REGISTRY,
      bus,
      spineClient: client,
      ...ids(),
    });

    const result = await dispatcher.dispatch("explain-agent", { agentId: "a1" });

    // Named tool → the registry's definition id, with input forwarded.
    expect(calls()).toEqual([{ definitionId: "def_explain", input: { agentId: "a1" } }]);
    expect(result).toEqual({
      ok: true,
      dispatchId: "d1",
      executionId: "exec_1",
      status: "completed",
    });

    // Exact wire sequence: call → turn open → one delta per frame → turn close → result.
    expect(bus.messages).toEqual([
      { type: "assistant.tool_call", dispatchId: "d1", tool: "explain-agent", input: { agentId: "a1" } },
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "started", role: "assistant" } },
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "delta", text: "explain: running…\n" } },
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "delta", text: "explain: done\n" } },
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "completed" } },
      { type: "assistant.tool_result", dispatchId: "d1", tool: "explain-agent", ok: true, executionId: "exec_1", status: "completed" },
    ]);
  });

  it("defaults input to an empty object when none is given", async () => {
    const bus = fakeBus();
    const { client, calls } = fakeClient({
      result: { ok: true, executionId: "exec_1", status: "completed" },
    });
    const dispatcher = createToolDispatcher({ registry: REGISTRY, bus, spineClient: client, ...ids() });

    await dispatcher.dispatch("debug-step");

    expect(calls()).toEqual([{ definitionId: "def_debug", input: {} }]);
  });

  it("degrades on an unknown tool without calling the spine", async () => {
    const bus = fakeBus();
    const { client, calls } = fakeClient({
      result: { ok: true, executionId: "exec_1", status: "completed" },
    });
    const dispatcher = createToolDispatcher({ registry: REGISTRY, bus, spineClient: client, ...ids() });

    const result = await dispatcher.dispatch("nope");

    expect(calls()).toEqual([]); // never touched the workflow
    expect(result).toEqual({ ok: false, dispatchId: "d1", error: 'unknown tool: "nope"' });
    // Only an error turn — no tool_call/result for a call that never happened.
    expect(bus.messages).toEqual([
      { type: "assistant.error", dispatchId: "d1", error: 'unknown tool: "nope"' },
    ]);
  });

  it("surfaces a run failure as an error turn and a failed result", async () => {
    const bus = fakeBus();
    const { client } = fakeClient({
      result: { ok: false, status: 502, error: "gateway responded 500" },
    });
    const dispatcher = createToolDispatcher({ registry: REGISTRY, bus, spineClient: client, ...ids() });

    const result = await dispatcher.dispatch("explain-agent");

    expect(result).toEqual({ ok: false, dispatchId: "d1", error: "gateway responded 500" });
    expect(bus.messages).toEqual([
      { type: "assistant.tool_call", dispatchId: "d1", tool: "explain-agent", input: {} },
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "started", role: "assistant" } },
      // The open turn is closed so the pane never hangs on a streaming caret.
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "completed" } },
      { type: "assistant.error", dispatchId: "d1", error: "gateway responded 500" },
      // tool_result omits executionId/status — the run never materialized.
      { type: "assistant.tool_result", dispatchId: "d1", tool: "explain-agent", ok: false },
    ]);
  });

  it("treats a signed-out spine (503) as a graceful error, not a crash", async () => {
    const bus = fakeBus();
    const { client } = fakeClient({
      result: { ok: false, status: 503, error: "harness is not signed in to Sapiom" },
    });
    const dispatcher = createToolDispatcher({ registry: REGISTRY, bus, spineClient: client, ...ids() });

    const result = await dispatcher.dispatch("explain-agent");

    expect(result.ok).toBe(false);
    expect(bus.messages.at(-2)).toEqual({
      type: "assistant.error",
      dispatchId: "d1",
      error: "harness is not signed in to Sapiom",
    });
  });

  it("never throws even if the spine client rejects unexpectedly", async () => {
    const bus = fakeBus();
    const { client } = fakeClient({
      result: { ok: true, executionId: "exec_1", status: "completed" },
      throwWith: new Error("kaboom"),
    });
    const dispatcher = createToolDispatcher({ registry: REGISTRY, bus, spineClient: client, ...ids() });

    const result = await dispatcher.dispatch("explain-agent");

    expect(result).toEqual({ ok: false, dispatchId: "d1", error: "kaboom" });
    expect(bus.messages).toEqual([
      { type: "assistant.tool_call", dispatchId: "d1", tool: "explain-agent", input: {} },
      { type: "assistant.turn", dispatchId: "d1", turnId: "t1", frame: { kind: "started", role: "assistant" } },
      { type: "assistant.error", dispatchId: "d1", error: "kaboom" },
      { type: "assistant.tool_result", dispatchId: "d1", tool: "explain-agent", ok: false },
    ]);
  });

  it("lets a renderFrame override shape the streamed turn text", async () => {
    const bus = fakeBus();
    const { client } = fakeClient({
      frames: [step({ name: "explain", status: "passed" })],
      result: { ok: true, executionId: "exec_1", status: "completed" },
    });
    const dispatcher = createToolDispatcher({
      registry: REGISTRY,
      bus,
      spineClient: client,
      renderFrame: (s) => `<<${s.name}>>`,
      ...ids(),
    });

    await dispatcher.dispatch("explain-agent");

    const deltas = bus.messages.filter(
      (m): m is Extract<BusMessage, { type: "assistant.turn" }> =>
        m.type === "assistant.turn" && m.frame.kind === "delta",
    );
    expect(deltas.map((m) => (m.frame.kind === "delta" ? m.frame.text : ""))).toEqual(["<<explain>>"]);
  });
});
