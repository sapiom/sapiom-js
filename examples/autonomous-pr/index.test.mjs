import assert from "node:assert/strict";
import test from "node:test";

import { readReview } from "./index.ts";

const good = {
  verdict: "comment",
  summary: "Does the task, scoped tightly, one naming nit.",
  notes: ["rename `tmp` to `checkoutDir`"],
};

test("reads the forced tool call's self-review", () => {
  assert.deepEqual(readReview(good), good);
});

test("reads an absent notes list as nothing to flag", () => {
  assert.deepEqual(
    readReview({ verdict: "approve", summary: "Clean." }).notes,
    [],
  );
});

// ── SAP-2892: an unusable reply must never become a verdict ─────────────────
//
// The `review` step catches these and reports `review: null` plus the reason —
// it never blocks the push, which already happened — but it must never invent
// an approval either. That is what this pins.

test("throws when the response carried no structured self-review", () => {
  assert.throws(() => readReview(undefined), /no structured self-review/);
  assert.throws(() => readReview(null), /no structured self-review/);
  assert.throws(
    () => readReview("I reviewed my own diff and it looks fine."),
    /no structured self-review/,
  );
});

test("throws rather than defaulting the verdict", () => {
  assert.throws(() => readReview({ summary: "Fine." }), /no usable verdict/);
  assert.throws(
    () => readReview({ ...good, verdict: "ship it" }),
    /no usable verdict/,
  );
});

test("throws rather than substituting a summary", () => {
  assert.throws(
    () => readReview({ ...good, summary: "" }),
    /no self-review summary/,
  );
});
