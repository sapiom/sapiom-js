// =============================================================================
// scripts/examples-discipline-check.test.mjs
//
// Fixture tests for the discipline↔category cross-field rule, plus the two
// invariants that keep the rule honest: the map and the schema enum must agree,
// and the schema enum must be the UNION (so the schema alone cannot catch a
// mismatch and this check is load-bearing).
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DISCIPLINE_BY_CATEGORY,
  checkDiscipline,
} from "./examples-discipline-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "examples", "registry.schema.json"), "utf8"),
);
const registry = JSON.parse(
  readFileSync(path.join(ROOT, "examples", "registry.json"), "utf8"),
);

const properties = schema.definitions.template.properties;

test("every allowed pair passes", () => {
  for (const [category, disciplines] of Object.entries(DISCIPLINE_BY_CATEGORY)) {
    for (const discipline of disciplines) {
      assert.deepEqual(
        checkDiscipline({ id: "fixture", category, discipline }),
        [],
        `${category} / ${discipline}`,
      );
    }
  }
});

test("a discipline from another category fails, and the message names the allowed set", () => {
  const errors = checkDiscipline({
    id: "scheduled-compliance-audit",
    category: "finance-legal-people",
    discipline: "Support",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^discipline: "scheduled-compliance-audit" /);
  assert.match(errors[0], /Allowed under "finance-legal-people": Finance, Legal, People, Operations/);
});

test("an unknown discipline fails", () => {
  const errors = checkDiscipline({
    id: "fixture",
    category: "starter",
    discipline: "Vibes",
  });
  assert.equal(errors.length, 1);
});

test("an absent field is silent — both are optional", () => {
  assert.deepEqual(checkDiscipline({ id: "a", category: "starter" }), []);
  assert.deepEqual(checkDiscipline({ id: "b", discipline: "Starter" }), []);
  assert.deepEqual(checkDiscipline({ id: "c" }), []);
  assert.deepEqual(checkDiscipline(null), []);
});

test("an unknown category is silent — schema validation owns that error", () => {
  // Reporting it here too would bury the real problem under a consequence of it.
  assert.deepEqual(
    checkDiscipline({ id: "x", category: "not-a-category", discipline: "Data" }),
    [],
  );
});

test("a non-string value is silent rather than a crash", () => {
  assert.deepEqual(checkDiscipline({ id: "x", category: "starter", discipline: 7 }), []);
});

test("the map's categories are exactly the schema's category enum", () => {
  assert.deepEqual(
    Object.keys(DISCIPLINE_BY_CATEGORY).sort(),
    [...properties.category.enum].sort(),
  );
});

test("the schema's discipline enum is exactly the union of the map's values", () => {
  // Not a subset either way: a value in the map but not the enum is rejected by
  // check 1 with a confusing message, and one in the enum but not the map can
  // never be used by any category.
  const union = [...new Set(Object.values(DISCIPLINE_BY_CATEGORY).flat())].sort();
  assert.deepEqual([...properties.discipline.enum].sort(), union);
});

test("the schema enum is the union, not any single category's set", () => {
  // This is what makes the cross-field check load-bearing: if the enum happened
  // to equal one category's list, the schema would already reject mismatches and
  // a future author might delete this check as redundant.
  for (const disciplines of Object.values(DISCIPLINE_BY_CATEGORY)) {
    assert.notEqual(disciplines.length, properties.discipline.enum.length);
  }
});

test("the shipped registry has no mismatched pair", () => {
  const errors = registry.templates.flatMap((t) => checkDiscipline(t));
  assert.deepEqual(errors, []);
});
