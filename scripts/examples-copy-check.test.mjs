// =============================================================================
// scripts/examples-copy-check.test.mjs
//
// Fixture tests for the house-style copy rules. Every rule here fires on real
// templates today — these pin the rule so the burn-down can't silently reverse.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import test from "node:test";
import { COPY_LIMITS, MECHANISM_WORDS, checkCopy } from "./examples-copy-check.mjs";

/** A template whose copy is clean, plus whatever the case under test overrides. */
const clean = {
  id: "fixture",
  name: "Account Research Brief",
  description: "Create a cited account brief and review-ready next actions.",
  whatItDoes:
    "Create a cited account brief, relationship graph, and review-ready next actions from live and internal sources.",
};
const cleanManifest = {
  useCases: ["Exact source links", "Relationship graph", "Approval before CRM write"],
};

const check = (template = {}, manifest = {}) =>
  checkCopy({ ...clean, ...template }, { ...cleanManifest, ...manifest });

test("copy taken straight from the card passes every rule", () => {
  assert.deepEqual(check(), []);
});

test("the card's own use cases fit the cap", () => {
  for (const useCase of cleanManifest.useCases) {
    assert.ok(
      useCase.length <= COPY_LIMITS.useCase,
      `"${useCase}" is ${useCase.length}, cap is ${COPY_LIMITS.useCase}`,
    );
  }
});

test("an over-long name is flagged with its actual length", () => {
  const warnings = check({ name: "Scheduled Compliance Audit + Attestation" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^copy-name: "fixture" name is 40 chars \(max 32\)/);
});

test("an arrow or a slash in a name is flagged", () => {
  for (const name of ["Scene → Images → Video", "Proposal / Quote Generator"]) {
    const warnings = check({ name });
    assert.equal(warnings.length, 1, `${name} → ${warnings.join("; ")}`);
    assert.match(warnings[0], /contains an arrow or a slash/);
  }
});

test("a parenthetical in a name is flagged and pointed at tags", () => {
  const warnings = check({ name: "Approval Chain (Saga)" });
  // Both the parenthetical rule and the mechanism rule fire — "Saga" is
  // exactly the case that motivated each of them.
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /carries a parenthetical/);
  assert.match(warnings[1], /mechanism word "Saga"/);
  for (const w of warnings) assert.match(w, /`tags`/);
});

test("every mechanism word is caught, case-insensitively", () => {
  for (const word of MECHANISM_WORDS) {
    const warnings = check({ name: `Thing ${word}` });
    assert.equal(warnings.length, 1, `${word} → ${warnings.join("; ")}`);
    assert.match(warnings[0], /is built on the mechanism word/);
  }
});

test("plain-English product words are left alone", () => {
  // The denylist is narrow on purpose: a buyer reads these as English, not as
  // machinery, and over-flagging would make the burn-down noise.
  for (const name of ["PR Review Bot", "Newsletter Autopilot", "Company News Roundup"]) {
    assert.deepEqual(check({ name }), [], name);
  }
});

test("a mechanism word inside a longer word is not a match", () => {
  // "Engine" must not fire on "Engineering", nor "gate" on "Aggregate".
  for (const name of ["Engineering Digest", "Aggregate Report"]) {
    assert.deepEqual(check({ name }), [], name);
  }
});

test("a two-sentence description is flagged", () => {
  const warnings = check({
    name: "Scene to Video",
    description:
      "Turn one scene description into a short stitched video: an LLM plans the shots, each shot gets a keyframe image, each keyframe is animated into a clip, and the clips are joined into one video.",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^copy-description: "fixture" description is 192 chars \(max 160\)/);
});

test("whatItDoes opening with \"For\" is flagged", () => {
  const warnings = check({
    whatItDoes: "For turning a noisy error stream into one digest.",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /opens with "For" — lead with the verb/);
});

test("\"Format\" is not \"For\" — the rule is word-boundary aware", () => {
  assert.deepEqual(check({ whatItDoes: "Format the digest and email it." }), []);
});

test("an over-long whatItDoes is flagged", () => {
  const warnings = check({ whatItDoes: "Create ".repeat(60) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /whatItDoes is 420 chars \(max 320\)/);
});

test("each over-long use case is flagged by index", () => {
  const warnings = check(
    {},
    {
      useCases: [
        "Relationship graph",
        "Wake up to a sourced brief on a topic you track — a competitor, a research area, a market.",
      ],
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^copy-use-case: "fixture" useCases\[1\] is 90 chars \(max 40\)/);
});

test("a missing manifest is tolerated, not a crash", () => {
  assert.deepEqual(checkCopy(clean, null), []);
});

test("missing copy fields are tolerated — the schema owns required-ness", () => {
  assert.deepEqual(checkCopy({ id: "bare" }, {}), []);
});

test("the rules are warnings only — checkCopy never throws or exits", () => {
  // Guard against someone promoting these to errors before the burn-down is
  // done: the contract is "returns strings", nothing more.
  const warnings = checkCopy(
    { id: "worst", name: "Durable Backfill / Long-Job Runner (Saga)", whatItDoes: "For x." },
    { useCases: ["x".repeat(100)] },
  );
  assert.ok(Array.isArray(warnings));
  assert.ok(warnings.length >= 4);
  for (const w of warnings) assert.equal(typeof w, "string");
});
