import assert from "node:assert/strict";
import test from "node:test";

import { readFindings } from "./index.ts";

const ISSUE = {
  url: "https://example.test/pricing",
  issue: "The pricing page still has lorem ipsum in the FAQ.",
  severity: "high",
};

test("reads the forced tool call's findings", () => {
  assert.deepEqual(readFindings({ issues: [ISSUE] }), [ISSUE]);
});

test("keeps an empty list — a clean site is a real answer", () => {
  assert.deepEqual(readFindings({ issues: [] }), []);
});

// ── SAP-2892: an unusable reply must never read as a clean bill of health ───
//
// This is exactly why the empty list has to be a list the model returned: `[]`
// from a failed parse is indistinguishable from "nothing is wrong with your
// site", which is this template's entire output.

test("throws when the response carried no structured findings", () => {
  assert.throws(() => readFindings(undefined), /no structured findings/);
  assert.throws(() => readFindings(null), /no structured findings/);
  assert.throws(
    () => readFindings("I looked at all five pages and found..."),
    /no structured findings/,
  );
});

test("throws rather than reporting the site clean on a missing list", () => {
  assert.throws(() => readFindings({}), /no issue list/);
  assert.throws(() => readFindings({ issues: "none" }), /no issue list/);
});

test("drops an entry with no issue text rather than reporting a blank finding", () => {
  assert.deepEqual(readFindings({ issues: [{ url: "u", issue: "  " }] }), []);
});
