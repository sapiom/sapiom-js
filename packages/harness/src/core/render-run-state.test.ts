import { decodeExecutionProjection } from "@sapiom/agent-core";
import { describe, it, expect } from "vitest";

import type { RunView } from "../shared/types.js";
import { renderRunState } from "./render-run-state.js";

/** Build a decoded projection from a minimal raw body (decode fills the rest) —
 *  exercises the real inspect→decode→render path the poll endpoint uses. */
function render(raw: Record<string, unknown>): RunView {
  return renderRunState(decodeExecutionProjection(raw));
}

/** A single step's raw body, spread over decode's defaults. */
function step(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    stepName: "s",
    stepOrder: 0,
    attempt: 1,
    status: "completed",
    ...raw,
  };
}

describe("renderRunState — run status", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"], // one-L wire spelling normalizes to two-L
  ] as const)("folds terminal %s → %s", (raw, expected) => {
    expect(render({ id: "e1", status: raw }).status).toBe(expected);
  });

  it.each(["running", "paused", "queued", "", "something-new"])(
    "folds non-terminal %s → running",
    (raw) => {
      expect(render({ id: "e1", status: raw }).status).toBe("running");
    },
  );

  it("carries the execution id through", () => {
    expect(render({ id: "exec_42", status: "running" }).executionId).toBe(
      "exec_42",
    );
  });
});

describe("renderRunState — step status folding", () => {
  it.each([
    ["completed", "passed"],
    ["succeeded", "passed"], // real prod engine vocabulary for a passed step
    ["failed", "failed"],
    ["threw", "failed"], // real prod engine vocabulary for an error'd step
    ["cancelled", "failed"], // a cancelled step did not pass
    ["canceled", "failed"],
    ["running", "running"],
    ["", "pending"],
    ["queued", "pending"],
  ] as const)("folds step status %s → %s", (raw, expected) => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [step({ status: raw })],
    });
    expect(view.steps[0].status).toBe(expected);
  });
});

describe("renderRunState — step id + name", () => {
  it("uses the span id as the stable step id when present", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [step({ spanId: "span_9" })],
    });
    expect(view.steps[0].id).toBe("span_9");
  });

  it("falls back to a step-order/attempt key when there is no span id", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [step({ spanId: null, stepOrder: 2, attempt: 3 })],
    });
    expect(view.steps[0].id).toBe("step-2-3");
  });

  it("passes the step name through", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [step({ stepName: "gather" })],
    });
    expect(view.steps[0].name).toBe("gather");
  });
});

describe("renderRunState — latency", () => {
  it("computes finishedAt − startedAt in ms", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:45.000Z",
        }),
      ],
    });
    expect(view.steps[0].latencyMs).toBe(45_000);
  });

  it("keeps a genuine zero-duration step as 0 (not absent)", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    expect(view.steps[0].latencyMs).toBe(0);
  });

  it("omits latency while the step is still running (no finishedAt)", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [
        step({
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
        }),
      ],
    });
    expect(view.steps[0]).not.toHaveProperty("latencyMs");
  });

  it("omits latency on an unparseable timestamp", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({
          startedAt: "not-a-date",
          finishedAt: "2026-01-01T00:00:45.000Z",
        }),
      ],
    });
    expect(view.steps[0]).not.toHaveProperty("latencyMs");
  });

  it("drops a negative delta (clock skew) rather than showing negative latency", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({
          startedAt: "2026-01-01T00:00:45.000Z",
          finishedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    expect(view.steps[0]).not.toHaveProperty("latencyMs");
  });
});

describe("renderRunState — error", () => {
  it("surfaces a failed step's error message", () => {
    const view = render({
      id: "e1",
      status: "failed",
      steps: [step({ status: "failed", error: { message: "boom" } })],
    });
    expect(view.steps[0].error).toBe("boom");
  });

  it("omits error on a step that did not throw", () => {
    const view = render({ id: "e1", status: "completed", steps: [step({})] });
    expect(view.steps[0]).not.toHaveProperty("error");
  });
});

describe("renderRunState — log slice", () => {
  it("formats { ts, level, msg } entries into compact lines", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({
          logs: [
            { ts: "t0", level: "info", msg: "start" },
            { ts: "t1", level: "error", message: "kaboom" },
          ],
        }),
      ],
    });
    expect(view.steps[0].logSlice).toBe("t0 info start\nt1 error kaboom");
  });

  it("formats numeric log fields (e.g. a millisecond ts) into the line", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({ logs: [{ ts: 1700000000000, level: "info", msg: "boot" }] }),
      ],
    });
    // A numeric field (here a ms epoch) is kept and stringified — not dropped —
    // so the whole `{ ts, level, msg }` line survives intact.
    expect(view.steps[0].logSlice).toBe("1700000000000 info boot");
  });

  it("accepts bare-string log entries", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ logs: ["line one", "line two"] })],
    });
    expect(view.steps[0].logSlice).toBe("line one\nline two");
  });

  it("omits logSlice when there are no logs", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ logs: null })],
    });
    expect(view.steps[0]).not.toHaveProperty("logSlice");
  });

  it("omits logSlice for an empty log array", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ logs: [] })],
    });
    expect(view.steps[0]).not.toHaveProperty("logSlice");
  });

  it("keeps the TAIL when the buffer exceeds the cap", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ logs: long })],
    });
    const slice = view.steps[0].logSlice as string;
    expect(slice.length).toBe(4000);
    expect(slice.endsWith("line-499")).toBe(true); // most-recent line survives
    expect(slice.startsWith("line-0")).toBe(false); // oldest lines trimmed off the front
  });
});

describe("renderRunState — per-step input/output", () => {
  it("surfaces a real per-step input", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ input: { topic: "otters" } })],
    });
    expect(view.steps[0].input).toEqual({ topic: "otters" });
  });

  it("surfaces a real per-step output", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ output: { facts: 3 } })],
    });
    expect(view.steps[0].output).toEqual({ facts: 3 });
  });

  it("omits input on honest absence (the read carried none → decoded null)", () => {
    // decodeStep collapses a missing input to null; null is the absence
    // sentinel and must render as ABSENT, not a fabricated `null` payload.
    const view = render({ id: "e1", status: "completed", steps: [step({})] });
    expect(view.steps[0]).not.toHaveProperty("input");
  });

  it("omits output on honest absence (decoded null)", () => {
    const view = render({ id: "e1", status: "completed", steps: [step({})] });
    expect(view.steps[0]).not.toHaveProperty("output");
  });

  it("keeps a falsy-but-real input (0) rather than dropping it", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ input: 0 })],
    });
    expect(view.steps[0].input).toBe(0);
  });

  it("keeps a falsy-but-real output (false) rather than dropping it", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ output: false })],
    });
    expect(view.steps[0].output).toBe(false);
  });
});

describe("renderRunState — calls (prod steps)", () => {
  // The step projection carries `events` (capability execution events forwarded
  // by dispatched capabilities: tool_use/thinking/result from a coding run).
  // These are NOT dotted workflow capability calls (search.webSearch,
  // memory.append, etc.) with args/results in the StepCall format — they are
  // execution-level trace events from the underlying capability engine. Mapping
  // them to StepCall would fabricate structure that isn't there; `calls` is
  // left absent for prod steps until the server-side projection adds explicit
  // per-call records.
  it("omits calls for a prod step with no events (honest absence)", () => {
    const view = render({
      id: "e1",
      status: "completed",
      steps: [step({ events: [] })],
    });
    expect(view.steps[0]).not.toHaveProperty("calls");
  });

  it("omits calls for a prod step even when events are present (events are not capability calls)", () => {
    // Events are execution-level trace events (tool_use, thinking, result) from
    // dispatched capabilities, not dotted capability calls with args/results.
    const view = render({
      id: "e1",
      status: "completed",
      steps: [
        step({
          events: [
            {
              sourceId: "run-123",
              sequence: 1,
              kind: "tool_use",
              payload: { tool: "bash", input: "ls" },
              eventTs: "2026-01-01T00:00:01.000Z",
            },
            {
              sourceId: "run-123",
              sequence: 2,
              kind: "result",
              payload: { content: "file.ts" },
              eventTs: "2026-01-01T00:00:02.000Z",
            },
          ],
        }),
      ],
    });
    expect(view.steps[0]).not.toHaveProperty("calls");
  });
});

describe("renderRunState — whole run", () => {
  it("preserves step order", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [
        step({ stepName: "first", stepOrder: 0, spanId: "a" }),
        step({
          stepName: "second",
          stepOrder: 1,
          spanId: "b",
          status: "running",
        }),
      ],
    });
    expect(view.steps.map((s) => s.name)).toEqual(["first", "second"]);
  });

  it("emits only the derived keys for a minimal step (honest absence everywhere)", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [step({ spanId: "s0" })],
    });
    expect(view.steps[0]).toEqual({ id: "s0", name: "s", status: "passed" });
  });

  it("emits only the derived keys for a minimal RUNNING step too", () => {
    const view = render({
      id: "e1",
      status: "running",
      steps: [step({ spanId: "s1", status: "running" })],
    });
    expect(view.steps[0]).toEqual({ id: "s1", name: "s", status: "running" });
  });

  it("maps a realistic completed run end to end", () => {
    const view = render({
      id: "exec_0001",
      status: "completed",
      steps: [
        {
          stepName: "gather",
          stepOrder: 0,
          attempt: 1,
          status: "completed",
          spanId: "span_0001",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:45.000Z",
        },
      ],
    });
    expect(view).toEqual({
      executionId: "exec_0001",
      status: "completed",
      steps: [
        {
          id: "span_0001",
          name: "gather",
          status: "passed",
          latencyMs: 45_000,
        },
      ],
    });
  });
});
