import assert from "node:assert/strict";
import { test } from "node:test";
import { measurementFailures } from "./assistant-context-measurements.mjs";

const receipt = {
  sourceReads: 1,
  sources: [{ status: 200, bytes: 7164 }],
  calls: [{ status: "completed", cachedInput: null, cacheWrite: null }],
};

test("unavailable cache fields are valid measured evidence", () => {
  assert.deepEqual(measurementFailures(receipt), []);
});

test("missing or rejected source measurements cannot certify success", () => {
  for (const sources of [[], [{ error: "TypeError" }]]) {
    assert.deepEqual(measurementFailures({ ...receipt, sources }), [
      "source-observations",
    ]);
  }
});

test("provider observation failure remains a failure after a completed event", () => {
  const calls = [{ ...receipt.calls[0], observationError: "SyntaxError" }];
  assert.deepEqual(measurementFailures({ ...receipt, calls }), [
    "provider-observations",
  ]);
});
