import { describe, it, expect } from "vitest";
import type { LocalStepTrace } from "@sapiom/agent-core";

import type { RunView } from "../shared/types.js";
import { renderLocalRun } from "./render-local-run.js";
// The cap lives in the shared, dependency-free log module both mappers use.
import { LOG_SLICE_MAX } from "./render-log-slice.js";

/**
 * A single local step-attempt trace over sensible defaults — a `succeeded` step
 * named `s`, attempt 1, with a string input and no output. Tests override only
 * the field under test, so an assertion pins exactly one behavior (mutation
 * tests need each derivation isolated).
 */
function trace(overrides: Partial<LocalStepTrace> = {}): LocalStepTrace {
  return {
    step: "s",
    attempt: 1,
    input: "in",
    status: "succeeded",
    logs: [],
    ...overrides,
  };
}

/** Convenience: render a one-step run with the given trace + options. */
function renderOne(
  overrides: Partial<LocalStepTrace>,
  options?: Parameters<typeof renderLocalRun>[1],
): RunView {
  return renderLocalRun([trace(overrides)], options);
}

describe("renderLocalRun — run status", () => {
  it("folds outcome 'completed' → completed", () => {
    expect(renderLocalRun([], { outcome: "completed" }).status).toBe("completed");
  });

  it("folds outcome 'failed' → failed", () => {
    expect(renderLocalRun([], { outcome: "failed" }).status).toBe("failed");
  });

  it("folds outcome 'paused' → running (a paused run is not terminal)", () => {
    expect(renderLocalRun([], { outcome: "paused" }).status).toBe("running");
  });

  it("folds outcome 'running' → running", () => {
    expect(renderLocalRun([], { outcome: "running" }).status).toBe("running");
  });

  it("reports running when no outcome is supplied yet (stream still open)", () => {
    expect(renderLocalRun([]).status).toBe("running");
    expect(renderLocalRun([], {}).status).toBe("running");
  });
});

describe("renderLocalRun — execution id", () => {
  it("stamps the caller-supplied execution id", () => {
    expect(renderLocalRun([], { executionId: "local-42" }).executionId).toBe("local-42");
  });

  it("defaults to an empty string when the caller has no id yet", () => {
    expect(renderLocalRun([]).executionId).toBe("");
    expect(renderLocalRun([], { outcome: "completed" }).executionId).toBe("");
  });
});

describe("renderLocalRun — step status folding", () => {
  it("folds 'succeeded' → passed", () => {
    expect(renderOne({ status: "succeeded" }).steps[0].status).toBe("passed");
  });

  it("folds 'threw' → failed (a step that threw did not pass)", () => {
    expect(renderOne({ status: "threw" }).steps[0].status).toBe("failed");
  });

  it("folds an unrecognized status → pending (never silently passed)", () => {
    // Defensive: the union is succeeded|threw, but a mutant that widens the
    // fold must not turn an unknown value into a green check.
    const view = renderOne({ status: "weird" as LocalStepTrace["status"] });
    expect(view.steps[0].status).toBe("pending");
  });
});

describe("renderLocalRun — step id + name", () => {
  it("keys the step id by step name and attempt", () => {
    expect(renderOne({ step: "gather", attempt: 2 }).steps[0].id).toBe("gather-2");
  });

  it("distinguishes retries of the same step by attempt in the id", () => {
    const view = renderLocalRun([
      trace({ step: "flaky", attempt: 1, status: "threw" }),
      trace({ step: "flaky", attempt: 2, status: "succeeded" }),
    ]);
    expect(view.steps.map((s) => s.id)).toEqual(["flaky-1", "flaky-2"]);
  });

  it("passes the step name through", () => {
    expect(renderOne({ step: "gather" }).steps[0].name).toBe("gather");
  });
});

describe("renderLocalRun — never fabricates cost or latency", () => {
  it("omits costUsd on every local step (local runs are free)", () => {
    const view = renderOne({ status: "succeeded", output: { total: 5 } });
    expect(view.steps[0]).not.toHaveProperty("costUsd");
  });

  it("omits latencyMs on every local step (a trace carries no timing)", () => {
    const view = renderOne({ status: "succeeded" });
    expect(view.steps[0]).not.toHaveProperty("latencyMs");
  });
});

describe("renderLocalRun — input", () => {
  it("surfaces the input the step ran on", () => {
    expect(renderOne({ input: { topic: "birds" } }).steps[0].input).toEqual({ topic: "birds" });
  });

  it("keeps a falsy-but-real input (0) rather than dropping it", () => {
    expect(renderOne({ input: 0 }).steps[0].input).toBe(0);
  });

  it("keeps a null input as a real value (null is a payload the step received)", () => {
    const view = renderOne({ input: null });
    expect(view.steps[0]).toHaveProperty("input");
    expect(view.steps[0].input).toBeNull();
  });

  it("omits input only when it is undefined", () => {
    const view = renderOne({ input: undefined });
    expect(view.steps[0]).not.toHaveProperty("input");
  });
});

describe("renderLocalRun — output", () => {
  it("surfaces a captured output", () => {
    expect(renderOne({ output: { ok: true } }).steps[0].output).toEqual({ ok: true });
  });

  it("keeps a falsy-but-real output (false) rather than dropping it", () => {
    expect(renderOne({ output: false }).steps[0].output).toBe(false);
  });

  it("keeps an empty-string output as a real value", () => {
    const view = renderOne({ output: "" });
    expect(view.steps[0]).toHaveProperty("output");
    expect(view.steps[0].output).toBe("");
  });

  it("omits output when the step captured none (undefined)", () => {
    const view = renderOne({ status: "succeeded", output: undefined });
    expect(view.steps[0]).not.toHaveProperty("output");
  });

  it("omits output for a step that threw (no value produced)", () => {
    const view = renderOne({ status: "threw", output: undefined, error: { name: "E", message: "x" } });
    expect(view.steps[0]).not.toHaveProperty("output");
  });
});

describe("renderLocalRun — error", () => {
  it("surfaces a threw step's error message", () => {
    const view = renderOne({
      status: "threw",
      error: { name: "TypeError", message: "cannot read x" },
    });
    expect(view.steps[0].error).toBe("cannot read x");
  });

  it("omits error on a step that did not throw", () => {
    expect(renderOne({ status: "succeeded" }).steps[0]).not.toHaveProperty("error");
  });

  it("omits error when the error object carries an empty message", () => {
    const view = renderOne({ status: "threw", error: { name: "E", message: "" } });
    expect(view.steps[0]).not.toHaveProperty("error");
  });
});

describe("renderLocalRun — log slice", () => {
  it("formats { level, msg } entries into compact lines", () => {
    const view = renderOne({
      logs: [
        { level: "info", msg: "start" },
        { level: "error", msg: "kaboom" },
      ],
    });
    expect(view.steps[0].logSlice).toBe("info start\nerror kaboom");
  });

  it("omits logSlice when there are no logs", () => {
    expect(renderOne({ logs: [] }).steps[0]).not.toHaveProperty("logSlice");
  });

  it("keeps the TAIL when the buffer exceeds the cap", () => {
    const logs = Array.from({ length: 800 }, (_, i) => ({
      level: "info" as const,
      msg: `line-${i}`,
    }));
    const slice = renderOne({ logs }).steps[0].logSlice as string;
    expect(slice.length).toBe(LOG_SLICE_MAX);
    expect(slice.endsWith("line-799")).toBe(true); // newest survives
    expect(slice.startsWith("info line-0")).toBe(false); // oldest trimmed off the front
  });
});

describe("renderLocalRun — stub signal (WB15-2)", () => {
  it("marks every local run as stubbed (stub-served by construction)", () => {
    expect(renderLocalRun([]).stubbed).toBe(true);
    expect(renderOne({ status: "succeeded" }).stubbed).toBe(true);
  });

  it("surfaces a non-empty unusedStubs list from the summary", () => {
    const view = renderLocalRun([], {
      outcome: "completed",
      unusedStubs: [{ step: "gather", key: "models.coding.launch" }],
    });
    expect(view.unusedStubs).toEqual([{ step: "gather", key: "models.coding.launch" }]);
  });

  it("surfaces a non-empty stubWarnings list from the summary", () => {
    const view = renderLocalRun([], {
      outcome: "completed",
      stubWarnings: ["'repositories.list' stub must be an array of repositories"],
    });
    expect(view.stubWarnings).toEqual(["'repositories.list' stub must be an array of repositories"]);
  });

  it("omits unusedStubs when the supplied list is empty (honest absence, not [])", () => {
    const view = renderLocalRun([], { outcome: "completed", unusedStubs: [] });
    expect(view).not.toHaveProperty("unusedStubs");
  });

  it("omits stubWarnings when the supplied list is empty (honest absence, not [])", () => {
    const view = renderLocalRun([], { outcome: "completed", stubWarnings: [] });
    expect(view).not.toHaveProperty("stubWarnings");
  });

  it("omits both stub-hygiene fields when none were supplied (stream still open)", () => {
    const view = renderLocalRun([trace({})]);
    expect(view).not.toHaveProperty("unusedStubs");
    expect(view).not.toHaveProperty("stubWarnings");
  });

  it("carries unusedStubs and stubWarnings together when both are present", () => {
    const view = renderLocalRun([], {
      outcome: "failed",
      unusedStubs: [{ step: "s", key: "repository.pushFromSandbox" }],
      stubWarnings: ["'repositories.list'[0] is not a repository shape"],
    });
    expect(view.unusedStubs).toHaveLength(1);
    expect(view.stubWarnings).toHaveLength(1);
  });
});

describe("renderLocalRun — calls", () => {
  it("maps a trace with one call to view.calls with all four fields", () => {
    const view = renderLocalRun([
      trace({
        calls: [
          {
            capability: "search.webSearch",
            stubUsed: true,
            args: [{ query: "otters" }],
            result: { answer: "otters float on backs" },
          },
        ],
      }),
    ]);
    expect(view.steps[0].calls).toEqual([
      {
        capability: "search.webSearch",
        stubUsed: true,
        args: [{ query: "otters" }],
        result: { answer: "otters float on backs" },
      },
    ]);
  });

  it("maps multiple calls in order", () => {
    const view = renderLocalRun([
      trace({
        calls: [
          {
            capability: "memory.append",
            stubUsed: true,
            args: [{ content: "hello" }],
            result: { id: "stub-memory-1" },
          },
          {
            capability: "memory.recall",
            stubUsed: true,
            args: [{ query: "hello" }],
            result: { results: [], count: 0 },
          },
        ],
      }),
    ]);
    expect(view.steps[0].calls).toHaveLength(2);
    expect(view.steps[0].calls![0].capability).toBe("memory.append");
    expect(view.steps[0].calls![1].capability).toBe("memory.recall");
  });

  it("omits calls when the trace has none (honest absence)", () => {
    const view = renderLocalRun([trace({ calls: undefined })]);
    expect(view.steps[0]).not.toHaveProperty("calls");
  });

  it("omits calls when the trace calls array is empty (no calls made)", () => {
    // An empty array on the trace means the stub client was wired but the step
    // made zero calls — that is real evidence and must not fabricate [].
    const view = renderLocalRun([trace({ calls: [] })]);
    expect(view.steps[0]).not.toHaveProperty("calls");
  });

  it("carries a falsy-but-real result (false) rather than dropping it", () => {
    const view = renderLocalRun([
      trace({
        calls: [
          {
            capability: "vault.get",
            stubUsed: true,
            args: ["ref", "key"],
            result: false as unknown,
          },
        ],
      }),
    ]);
    expect(view.steps[0].calls![0].result).toBe(false);
  });

  it("carries a null result as a real value (null is a valid stub return)", () => {
    const view = renderLocalRun([
      trace({
        calls: [
          {
            capability: "vault.get",
            stubUsed: true,
            args: ["ref", "key"],
            result: null,
          },
        ],
      }),
    ]);
    expect(view.steps[0].calls![0]).toHaveProperty("result");
    expect(view.steps[0].calls![0].result).toBeNull();
  });

  it("surfaces calls for a threw step too (calls happened before the throw)", () => {
    const view = renderLocalRun([
      trace({
        status: "threw",
        error: { name: "Error", message: "boom" },
        calls: [
          {
            capability: "search.scrape",
            stubUsed: true,
            args: [{ url: "https://x.test" }],
            result: { markdown: "(stub)" },
          },
        ],
      }),
    ]);
    expect(view.steps[0].calls).toHaveLength(1);
    expect(view.steps[0].calls![0].capability).toBe("search.scrape");
  });
});

describe("renderLocalRun — whole run", () => {
  it("preserves trace order", () => {
    const view = renderLocalRun([
      trace({ step: "first" }),
      trace({ step: "second", status: "threw", error: { name: "E", message: "boom" } }),
    ]);
    expect(view.steps.map((s) => s.name)).toEqual(["first", "second"]);
  });

  it("maps an empty trace list to a run with no steps", () => {
    expect(renderLocalRun([], { executionId: "local-1", outcome: "completed" })).toEqual({
      executionId: "local-1",
      status: "completed",
      steps: [],
      // Every local run is stub-served by construction (see the stub-signal
      // block); no unusedStubs/stubWarnings for a clean run (honest absence).
      stubbed: true,
    });
  });

  it("emits only the derived keys for a minimal succeeded step (honest absence everywhere)", () => {
    // input defaults to "in"; a truly minimal step (no output/error/logs) must
    // carry NO costUsd, latencyMs, output, error, or logSlice.
    const view = renderLocalRun([trace({ step: "s", attempt: 1 })], {
      executionId: "local-9",
      outcome: "completed",
    });
    expect(view.steps[0]).toEqual({ id: "s-1", name: "s", status: "passed", input: "in" });
  });

  it("maps a realistic completed local run end to end", () => {
    const view = renderLocalRun(
      [
        {
          step: "gather",
          attempt: 1,
          input: { topic: "otters" },
          status: "succeeded",
          output: { facts: ["float on backs"] },
          logs: [{ level: "info", msg: "fetched 1 fact" }],
        },
      ],
      { executionId: "local-run-001", outcome: "completed" },
    );
    expect(view).toEqual({
      executionId: "local-run-001",
      status: "completed",
      steps: [
        {
          id: "gather-1",
          name: "gather",
          status: "passed",
          input: { topic: "otters" },
          output: { facts: ["float on backs"] },
          logSlice: "info fetched 1 fact",
        },
      ],
      stubbed: true,
    });
  });

  it("maps a run that threw on its last step (failed outcome, error surfaced)", () => {
    const view = renderLocalRun(
      [
        trace({ step: "gather", status: "succeeded", output: { n: 1 } }),
        {
          step: "summarize",
          attempt: 1,
          input: { n: 1 },
          status: "threw",
          error: { name: "RangeError", message: "empty" },
          logs: [],
        },
      ],
      { executionId: "local-run-002", outcome: "failed" },
    );
    expect(view.status).toBe("failed");
    expect(view.steps[1]).toEqual({
      id: "summarize-1",
      name: "summarize",
      status: "failed",
      input: { n: 1 },
      error: "empty",
    });
  });
});
