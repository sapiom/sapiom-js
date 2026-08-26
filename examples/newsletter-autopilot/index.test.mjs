import assert from "node:assert/strict";
import test from "node:test";

import { buildNoSourcesIssue, readIssue, readJudgeReply } from "./index.ts";

const ISSUE = {
  subject: "Stablecoin rails finally got boring",
  body: "# Stablecoin rails\n\nThree things happened. [1] ...\n\n## Sources\n[1] ...",
  imagePrompt: "Editorial illustration of a payment rail. No text.",
};

test("readIssue reads the forced tool call's issue", () => {
  assert.deepEqual(readIssue(ISSUE), ISSUE);
});

// ── SAP-2892: an unusable reply must never become a newsletter ──────────────
//
// The old fallback sent `"<name>: <niche>"` over a bare link list — a
// subscriber received an issue no model wrote, on a run reported as
// `succeeded`.

test("readIssue throws when the response carried no structured issue", () => {
  assert.throws(() => readIssue(undefined), /no structured issue/);
  assert.throws(() => readIssue(null), /no structured issue/);
  assert.throws(
    () => readIssue("Here's this week's issue:\n\n# Stablecoin rails"),
    /no structured issue/,
  );
});

test("readIssue throws rather than substituting any field", () => {
  assert.throws(() => readIssue({ ...ISSUE, subject: "" }), /no subject line/);
  assert.throws(() => readIssue({ ...ISSUE, body: "  " }), /no issue body/);
  assert.throws(
    () => readIssue({ ...ISSUE, imagePrompt: "" }),
    /no header-image prompt/,
  );
});

test("the empty-week issue is still written locally, and says so", () => {
  const issue = buildNoSourcesIssue("stablecoins", "Rails Weekly");
  assert.match(issue.subject, /Rails Weekly/);
  assert.match(issue.body, /No sources were found/);
});

// ── The judge's grade is a judgment too ────────────────────────────────────
//
// A substituted `0` read as "the judge rejected this draft" and drove a real
// revision loop — a second paid model call answering a critique that said only
// "the judge model returned no reply".

test("readJudgeReply reads the grade, clamping a 0-100 answer", () => {
  assert.deepEqual(readJudgeReply({ score: 0.8, critique: "Solid." }), {
    score: 0.8,
    critique: "Solid.",
  });
  assert.equal(readJudgeReply({ score: 80, critique: "" }).score, 0.8);
  assert.equal(readJudgeReply({ score: -3, critique: "" }).score, 0);
});

test("readJudgeReply throws rather than scoring an unanswered draft 0", () => {
  assert.throws(() => readJudgeReply(undefined), /no structured grade/);
  assert.throws(() => readJudgeReply(null), /no structured grade/);
  assert.throws(
    () => readJudgeReply({ critique: "Pretty good." }),
    /no usable score/,
  );
  assert.throws(
    () => readJudgeReply({ score: "high", critique: "" }),
    /no usable score/,
  );
});
