// =============================================================================
// scripts/examples-copy-check.test.mjs
//
// Fixture tests for the house-style copy rules — the two a JSON Schema
// `pattern` could reject but could not explain. The length caps are schema
// `maxLength` and are covered in examples-manifest-check.test.mjs.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import test from "node:test";
import { MECHANISM_WORDS, checkCopy } from "./examples-copy-check.mjs";

/** A template whose copy is clean, plus whatever the case under test overrides. */
const template = { id: "fixture", name: "Account Research Brief" };
const manifest = {
  whatItDoes:
    "Create a cited account brief, relationship graph, and review-ready next actions from live and internal sources.",
};

const check = (t = {}, m = {}) => checkCopy({ ...template, ...t }, { ...manifest, ...m });

test("copy taken straight from the card passes", () => {
  assert.deepEqual(check(), []);
});

test("an arrow or a slash in a name fails", () => {
  for (const name of ["Scene → Images → Video", "Proposal / Quote Generator"]) {
    const errors = check({ name });
    assert.equal(errors.length, 1, `${name} → ${errors.join("; ")}`);
    assert.match(errors[0], /^copy-name: "fixture" /);
    assert.match(errors[0], /contains an arrow or a slash/);
  }
});

test("a parenthetical fails, and is pointed at tags", () => {
  const errors = check({ name: "Approval Chain (Saga)" });
  // Both rules fire — "Saga" is exactly the case that motivated each of them.
  assert.equal(errors.length, 2);
  assert.match(errors[0], /carries a parenthetical/);
  assert.match(errors[1], /mechanism word "Saga"/);
  for (const e of errors) assert.match(e, /`tags`/);
});

test("every mechanism word is caught, case-insensitively", () => {
  for (const word of MECHANISM_WORDS) {
    const errors = check({ name: `Thing ${word}` });
    assert.equal(errors.length, 1, `${word} → ${errors.join("; ")}`);
    assert.match(errors[0], /is built on the mechanism word/);
  }
});

test("plain-English product words are left alone", () => {
  // The denylist is narrow on purpose: a buyer reads these as English, not as
  // machinery, and over-flagging would just make the gate hated.
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

test('whatItDoes opening with "For" fails', () => {
  const errors = check({}, { whatItDoes: "For turning a noisy error stream into one digest." });
  assert.deepEqual(errors, [
    `copy-what-it-does: "fixture" whatItDoes opens with "For" — lead with the verb ("Create a cited account brief…"), not with who it is for.`,
  ]);
});

test('"Format" is not "For" — the rule is word-boundary aware', () => {
  assert.deepEqual(check({}, { whatItDoes: "Format the digest and email it." }), []);
});

test("whatItDoes is read from the manifest, not the registry entry", () => {
  // It moved out of registry.json in SAP-2076. A stale copy left on the registry
  // entry must not satisfy the rule, or the migration could silently half-apply.
  assert.deepEqual(check({ whatItDoes: "For turning…" }, { whatItDoes: "Create a brief." }), []);
});

test("a missing manifest is tolerated, not a crash", () => {
  assert.deepEqual(checkCopy(template, null), []);
});

test("missing copy fields are tolerated — the schemas own required-ness", () => {
  assert.deepEqual(checkCopy({ id: "bare" }, {}), []);
});
