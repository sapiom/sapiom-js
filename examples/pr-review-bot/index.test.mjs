import assert from "node:assert/strict";
import test from "node:test";

import { readReview } from "./index.ts";

const good = {
  verdict: "request_changes",
  summary: "Two behaviors changed without tests.",
  missingTests: ["retry backoff", "empty-batch path"],
  comments: ["the log line duplicates the error"],
};

test("reads the forced tool call's review", () => {
  assert.deepEqual(readReview(good), good);
});

test("reads absent detail lists as nothing to report", () => {
  const rev = readReview({ verdict: "approve", summary: "Clean." });
  assert.deepEqual(rev.missingTests, []);
  assert.deepEqual(rev.comments, []);
});

// ── SAP-2892: an unusable reply must never become a verdict ─────────────────

test("throws when the response carried no structured review", () => {
  // What `structuredOf` returns when the model answered in prose instead.
  assert.throws(() => readReview(undefined), /no structured review/);
  assert.throws(() => readReview(null), /no structured review/);
  assert.throws(
    () => readReview("Looks good to me! I'd approve this."),
    /no structured review/,
  );
});

test("throws rather than defaulting the verdict", () => {
  assert.throws(
    () => readReview({ summary: "Two behaviors changed without tests." }),
    /no usable verdict/,
  );
  assert.throws(
    () => readReview({ ...good, verdict: "lgtm" }),
    /no usable verdict/,
  );
});

test("throws rather than substituting a summary", () => {
  assert.throws(
    () => readReview({ ...good, summary: "   " }),
    /no review summary/,
  );
});

test("never returns the old canned review", () => {
  // The exact shape that used to ship: `comment` plus "see the raw findings".
  for (const unusable of [undefined, null, {}, { verdict: "comment" }]) {
    assert.throws(() => readReview(unusable));
  }
});
