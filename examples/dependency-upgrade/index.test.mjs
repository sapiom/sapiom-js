import assert from "node:assert/strict";
import test from "node:test";

import { readAssessment } from "./index.ts";

const good = {
  risk: "high",
  summary: "A major-version bump across the HTTP layer.",
  notes: ["axios 0.x → 1.x", "12 call sites touched"],
};

test("reads the forced tool call's assessment", () => {
  assert.deepEqual(readAssessment(good), good);
});

test("reads an absent notes list as none given", () => {
  assert.deepEqual(
    readAssessment({ risk: "low", summary: "Patch bumps only." }).notes,
    [],
  );
});

// ── SAP-2892: an unusable reply must never become a risk rating ─────────────
//
// `medium` is not a safe default: under the default `maxAutoRisk: "medium"` bar
// it AUTO-PUBLISHES the upgrade on the strength of an assessment nobody made.

test("throws when the response carried no structured assessment", () => {
  assert.throws(
    () => readAssessment(undefined),
    /no structured risk assessment/,
  );
  assert.throws(() => readAssessment(null), /no structured risk assessment/);
  assert.throws(
    () => readAssessment("This upgrade looks low risk to me."),
    /no structured risk assessment/,
  );
});

test("throws rather than defaulting the rating to medium", () => {
  assert.throws(
    () => readAssessment({ summary: "A major-version bump." }),
    /no usable risk rating/,
  );
  assert.throws(
    () => readAssessment({ ...good, risk: "moderate" }),
    /no usable risk rating/,
  );
});

test("throws rather than substituting a summary", () => {
  assert.throws(
    () => readAssessment({ ...good, summary: "" }),
    /no risk summary/,
  );
});
