import assert from "node:assert/strict";
import test from "node:test";

import {
  childIdempotencyKey,
  normalizeItems,
  orderResults,
  recordChildResult,
} from "./index.ts";

const at = "2026-09-25T00:00:00.000Z";
const completed = (executionId, output) => ({
  status: "completed",
  executionId,
  definition: "fan-out-and-combine",
  version: "1",
  output,
  startedAt: at,
  finishedAt: at,
});
const failed = (executionId, error) => ({
  status: "failed",
  executionId,
  definition: "fan-out-and-combine",
  version: "1",
  error,
  startedAt: at,
  finishedAt: at,
});

const twoPending = {
  pending: [
    { item: "cost", executionId: "exec-a" },
    { item: "latency", executionId: "exec-b" },
  ],
  results: [],
};

test("a completed child settles its own row and leaves the rest pending", () => {
  const next = recordChildResult(
    twoPending,
    completed("exec-b", { analysis: "  cold starts dominate  " }),
  );
  assert.deepEqual(next.pending, [{ item: "cost", executionId: "exec-a" }]);
  assert.deepEqual(next.results, [
    {
      item: "latency",
      ok: true,
      status: "completed",
      analysis: "cold starts dominate",
      error: null,
    },
  ]);
});

test("a failed child becomes a failed row with its error", () => {
  const next = recordChildResult(
    twoPending,
    failed("exec-a", { message: "boom" }),
  );
  assert.equal(next.pending.length, 1);
  assert.deepEqual(next.results, [
    {
      item: "cost",
      ok: false,
      status: "failed",
      analysis: null,
      error: '{"message":"boom"}',
    },
  ]);
});

test("the loop drains: one result per resume until nothing is pending", () => {
  let state = twoPending;
  state = recordChildResult(state, completed("exec-a", { analysis: "x" }));
  state = recordChildResult(state, completed("exec-b", {}));
  assert.deepEqual(state.pending, []);
  assert.deepEqual(
    state.results.map((r) => [r.item, r.ok, r.analysis]),
    [
      ["cost", true, "x"],
      ["latency", true, null],
    ],
  );
});

test("a resume that is not a pending child's result settles every pending child", () => {
  // run_local resumes a pause with {} when it has no stub result; a result for a
  // child we are not waiting on is equally unusable. Neither may leave the run
  // pausing on a result that will not come.
  for (const input of [{}, completed("exec-zzz", {})]) {
    const next = recordChildResult(twoPending, input);
    assert.deepEqual(next.pending, []);
    assert.deepEqual(
      next.results.map((r) => [r.item, r.ok, r.status]),
      [
        ["cost", false, "unknown"],
        ["latency", false, "unknown"],
      ],
    );
  }
});

test("rows are reported in item order, whatever order the children answered in", () => {
  const row = (item) => ({
    item,
    ok: true,
    status: "completed",
    analysis: null,
    error: null,
  });
  assert.deepEqual(
    orderResults(["a", "b", "c"], [row("c"), row("a"), row("b")]).map(
      (r) => r.item,
    ),
    ["a", "b", "c"],
  );
});

test("items are deduped before launch, so each idempotency key names one child", () => {
  const items = normalizeItems([" cost ", "cost", "", "latency"], ["x"]);
  assert.deepEqual(items, ["cost", "latency"]);
  const keys = items.map((_, i) => childIdempotencyKey("run-1", i));
  assert.equal(new Set(keys).size, items.length);
  assert.deepEqual(keys, ["run-1:item:0", "run-1:item:1"]);
});
