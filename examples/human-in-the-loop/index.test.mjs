import assert from "node:assert/strict";
import test from "node:test";

import { applyRanking, buildRankSchema, readParsed } from "./index.ts";

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

// ── The `rank` schema must survive `run_local` ──────────────────────────────
//
// `applyRanking` throwing on an unmatched ranking is correct, but a bare
// `id: { type: "string" }` put the local stub on a collision course with it:
// the stub builds its placeholder from the declared schema, so it yielded
// `"(stub) id"`, which matches no candidate — the run then died at `rank`,
// before the two pauses, contradicting what this template promises about
// `run_local` tracing the whole graph.
//
// The fix is the schema, not a fallback: `id` is an `enum` of this run's
// candidate ids, so the model can't name a candidate outside the pool and the
// stub has a real one to pick. Pinned here as the schema property; that the
// stub honors a nested `enum` is pinned in
// `packages/tools/src/stub/llm-structured-output.test.ts`, which runs against
// the workspace build (this template installs the published `@sapiom/tools`).

test("buildRankSchema bounds the id to this run's candidates", () => {
  const schema = buildRankSchema(CANDIDATES);
  assert.deepEqual(
    schema.properties.ranking.items.properties.id.enum,
    CANDIDATES.map((c) => c.id),
    "an unbounded id lets the model — and the local stub — name a candidate that isn't in the pool",
  );
  assert.equal(schema.properties.ranking.maxItems, CANDIDATES.length);
});

test("applyRanking accepts a ranking built from the schema's first allowed id", () => {
  // Exactly what the stub produces from `buildRankSchema`: the first enum
  // member. If this ever stops matching a candidate, `run_local` dies at `rank`.
  const schema = buildRankSchema(CANDIDATES);
  const firstAllowedId = schema.properties.ranking.items.properties.id.enum[0];

  const ranked = applyRanking(
    { ranking: [{ id: firstAllowedId, score: 0, rationale: "(stub)" }] },
    CANDIDATES,
  );
  assert.equal(ranked.length, CANDIDATES.length, "every candidate comes back");
  assert.equal(ranked[0].id, firstAllowedId);
});
