import assert from "node:assert/strict";
import test from "node:test";

import { applyRanking, readParsed } from "./index.ts";

const CANDIDATES = [
  { id: "a", name: "Vendor A", email: "a@a.test" },
  { id: "b", name: "Vendor B", email: "b@b.test" },
];

test("readParsed reads the forced tool call's intent", () => {
  assert.deepEqual(
    readParsed({ summary: "Need a courier", criteria: ["speed", "cost"] }),
    { summary: "Need a courier", criteria: ["speed", "cost"] },
  );
});

// ── SAP-2892: an unusable reply must never become the ranking criteria ──────
//
// The old fallback used the first 120 characters of the request as the
// "summary" and an EMPTY criteria list — so `rank` graded every candidate
// against nothing and the result was presented to the approver as a considered
// shortlist.

test("readParsed throws when the response carried no structured intent", () => {
  assert.throws(() => readParsed(undefined), /no structured intent/);
  assert.throws(() => readParsed(null), /no structured intent/);
  assert.throws(
    () => readParsed("They want a courier by Friday."),
    /no structured intent/,
  );
});

test("readParsed throws rather than echoing the request back as a summary", () => {
  assert.throws(
    () => readParsed({ criteria: ["speed"] }),
    /no request summary/,
  );
  assert.throws(() => readParsed({ summary: "  " }), /no request summary/);
});

// ── The ranking drives which candidate gets the offer ───────────────────────

test("applyRanking reorders by the model's ranking", () => {
  const ranked = applyRanking(
    {
      ranking: [
        { id: "b", score: 90, rationale: "faster" },
        { id: "a", score: 40, rationale: "cheaper but slow" },
      ],
    },
    CANDIDATES,
  );
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["b", "a"],
  );
  assert.equal(ranked[0].email, "b@b.test", "contact info is preserved");
});

test("applyRanking still appends a candidate the model dropped, marked unranked", () => {
  const ranked = applyRanking(
    { ranking: [{ id: "b", score: 90, rationale: "faster" }] },
    CANDIDATES,
  );
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["b", "a"],
  );
  assert.equal(ranked[1].rationale, "(unranked)");
});

test("applyRanking throws rather than presenting input order as a shortlist", () => {
  // Every candidate at `score: 0, rationale: "(unranked)"` in input order used
  // to be handed to the approver as a ranked shortlist, and the offer went to
  // whoever happened to be listed first.
  assert.throws(() => applyRanking(undefined, CANDIDATES), /no ranking/);
  assert.throws(() => applyRanking(null, CANDIDATES), /no ranking/);
  assert.throws(() => applyRanking({}, CANDIDATES), /no ranking/);
  assert.throws(
    () => applyRanking("Vendor B looks best.", CANDIDATES),
    /no ranking/,
  );
});

test("applyRanking throws when the list is present but ranks nobody", () => {
  // A container with nothing usable in it is not a ranking. Falling through
  // would append every candidate as `(unranked)` in input order and hand that
  // to the approver as the shortlist.
  assert.throws(() => applyRanking({ ranking: [] }, CANDIDATES), /ranked none/);
  assert.throws(
    () =>
      applyRanking(
        { ranking: [{ id: "nobody", score: 90, rationale: "?" }] },
        CANDIDATES,
      ),
    /ranked none/,
  );
});

test("readParsed throws on a missing criteria list, but allows an empty one", () => {
  // Same empty-vs-missing rule: a request may name no criteria, but a reply
  // that carried no list at all must not read as "no criteria apply".
  assert.throws(
    () => readParsed({ summary: "Need a courier" }),
    /no criteria list/,
  );
  assert.deepEqual(readParsed({ summary: "Need a courier", criteria: [] }), {
    summary: "Need a courier",
    criteria: [],
  });
});
