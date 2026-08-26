import assert from "node:assert/strict";
import test from "node:test";

import { JUDGE_SCHEMA, buildJudgePrompt, readScore } from "./judge.js";

test("reads the forced tool call's grade", () => {
  assert.deepEqual(readScore({ score: 0.75, rationale: "Nearly there." }), {
    score: 0.75,
    rationale: "Nearly there.",
  });
});

test("clamps a score the judge did give, and reads a 0-100 answer as a fraction", () => {
  assert.equal(readScore({ score: 82, rationale: "" }).score, 0.82);
  assert.equal(readScore({ score: 100, rationale: "" }).score, 1);
  assert.equal(readScore({ score: -2, rationale: "" }).score, 0);
});

// ── SAP-2892: no score is an error, not a number found in the prose ─────────
//
// The regex this replaced fell back to the first bare number anywhere in the
// reply — so a figure quoted inside the model's reasoning could become the
// grade the draft was gated on.

test("throws when the response carried no structured grade", () => {
  assert.throws(() => readScore(undefined), /no structured score/);
  assert.throws(() => readScore(null), /no structured score/);
  assert.throws(
    () => readScore("I'd say this clears the bar — maybe 3 small nits."),
    /no structured score/,
  );
});

test("throws rather than grading on a non-number", () => {
  assert.throws(() => readScore({ rationale: "Good." }), /no usable score/);
  assert.throws(
    () => readScore({ score: "high", rationale: "" }),
    /no usable score/,
  );
});

test("the judge prompt no longer dictates a reply format — the schema does", () => {
  const prompt = buildJudgePrompt({
    input: "brief",
    output: "draft",
    rubric: "must be concrete",
  });
  assert.doesNotMatch(prompt, /ONLY a JSON object/i);
  assert.match(prompt, /must be concrete/);
  assert.deepEqual(JUDGE_SCHEMA.required, ["score", "rationale"]);
});
