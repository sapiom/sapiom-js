import assert from "node:assert/strict";
import test from "node:test";

import { readDecision } from "./index.ts";

const good = {
  decision: "accept",
  summary: "The job finished and the payload carries the expected artifact.",
  reasons: ['status="succeeded"'],
};

test("reads the forced tool call's decision", () => {
  assert.deepEqual(readDecision(good), good);
});

test("reads an absent reasons list as none given", () => {
  assert.deepEqual(
    readDecision({ decision: "reject", summary: "The job failed." }).reasons,
    [],
  );
});

// ── SAP-2892: an unusable reply must never become an accept/reject ──────────
//
// This decision picks the run's terminal, and the old code guessed it from
// `payload.status` — reporting the guess as the model's own decision.

test("throws when the response carried no structured decision", () => {
  assert.throws(() => readDecision(undefined), /no structured decision/);
  assert.throws(() => readDecision(null), /no structured decision/);
  assert.throws(
    () => readDecision("The callback looks like it succeeded."),
    /no structured decision/,
  );
});

test("throws rather than inferring the decision from the payload", () => {
  assert.throws(
    () => readDecision({ summary: "The job finished." }),
    /no usable decision/,
  );
  assert.throws(
    () => readDecision({ ...good, decision: "maybe" }),
    /no usable decision/,
  );
});

test("throws rather than substituting a summary", () => {
  assert.throws(
    () => readDecision({ ...good, summary: " " }),
    /no decision summary/,
  );
});
