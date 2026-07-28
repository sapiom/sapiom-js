// =============================================================================
// scripts/examples-complexity.test.mjs
//
// Fixture tests for the authored `complexity` band (SAP-2086) — the enum in
// registry.schema.json, and the DERIVED scorer that guards it.
//
// Two things are worth pinning here. The enum, because a band that doesn't
// validate is a band the gallery can't render. And the scorer's ORDERING,
// because the whole point of the field is that complexity means variance and
// judgment rather than graph size — an accidental reweighting that made a
// deterministic saga outrank a two-model pipeline would flip the axis with no
// other test noticing.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv from "ajv";
import {
  COMPLEXITY_BANDS,
  complexityBandScore,
  scoreTemplateComplexity,
} from "./lib/template-complexity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "examples", "registry.schema.json"), "utf8"),
);
const registry = JSON.parse(
  readFileSync(path.join(ROOT, "examples", "registry.json"), "utf8"),
);

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

/** Validate a registry containing one template with the given complexity. */
const check = (complexity) =>
  validate({
    version: 1,
    templates: [
      {
        id: "fixture",
        name: "Fixture",
        description: "One line.",
        sourcePath: "examples/fixture",
        ...(complexity === undefined ? {} : { complexity }),
      },
    ],
  });

test("every band in the enum validates", () => {
  for (const band of COMPLEXITY_BANDS) {
    assert.equal(check(band), true, `${band} should be a valid complexity`);
  }
});

test("a band outside the enum fails rather than reaching the gallery", () => {
  assert.equal(check("trivial"), false);
  assert.equal(check("Simple"), false, "the enum is lowercase");
  assert.equal(check(3), false, "a numeric score is not the authored shape");
});

test("complexity stays optional — absent is valid, the check nudges instead", () => {
  assert.equal(check(undefined), true);
});

test("band scores are 1-5 ascending, and unknown labels score null", () => {
  assert.deepEqual(
    COMPLEXITY_BANDS.map(complexityBandScore),
    [1, 2, 3, 4, 5],
    "the divergence gap is arithmetic on these, so the order is load-bearing",
  );
  assert.equal(complexityBandScore("trivial"), null);
  assert.equal(complexityBandScore(undefined), null);
});

test("all 26 templates declare a band the enum accepts", () => {
  const undeclared = registry.templates.filter((t) => !t.complexity);
  assert.deepEqual(undeclared, [], "every template should carry a complexity");
  for (const t of registry.templates) {
    assert.ok(
      COMPLEXITY_BANDS.includes(t.complexity),
      `${t.id} declares "${t.complexity}", which is not a band`,
    );
  }
});

test("no template diverges 2+ bands from its derived score", () => {
  // The same threshold examples-check.mjs warns on. Asserted here so a future
  // registry edit that breaks the authored/declared agreement fails a test
  // rather than only printing a warning nobody reads in CI output.
  const wide = registry.templates
    .map((t) => ({
      id: t.id,
      authored: t.complexity,
      derived: scoreTemplateComplexity(t),
    }))
    .filter(
      (r) => Math.abs(complexityBandScore(r.authored) - r.derived.score) >= 2,
    )
    .map((r) => `${r.id}: authored ${r.authored}, derived ${r.derived.label}`);
  assert.deepEqual(wide, []);
});

test("judgment outranks graph size — the axis the rubric leads with", () => {
  // approval-chain's real shape: seven steps, a fan-out of five, two pauses, a
  // compensation branch — and every branch a state check.
  const saga = scoreTemplateComplexity({
    capabilities: ["email.send", "database.create"],
    steps: [
      { name: "start", kind: "capability", next: ["present", "escalate"] },
      { name: "present", kind: "pause", next: ["decide"] },
      {
        name: "decide",
        kind: "compute",
        next: ["present", "remind", "finalize", "compensate", "escalate"],
      },
      { name: "remind", kind: "pause", next: ["decide"] },
      { name: "finalize", kind: "capability" },
      { name: "compensate", kind: "capability" },
      { name: "escalate", kind: "capability" },
    ],
  });
  // Two chained model steps in a graph less than half the size.
  const chained = scoreTemplateComplexity({
    capabilities: ["models.run"],
    steps: [
      { name: "parse", kind: "llm", next: ["rank"] },
      { name: "rank", kind: "llm", next: [] },
    ],
  });

  assert.ok(
    chained.score > saga.score,
    `a two-model chain (${chained.label}, raw ${chained.raw}) must outrank a ` +
      `seven-step deterministic saga (${saga.label}, raw ${saga.raw})`,
  );
  assert.equal(saga.label, "simple");
});

test("the scorer is total — an empty template scores minimal, not a throw", () => {
  assert.equal(scoreTemplateComplexity({ capabilities: [] }).label, "minimal");
  assert.equal(scoreTemplateComplexity({}).label, "minimal");
});

test("both media capability spellings count, so the pending id fix can't silently drop a band", () => {
  const dotted = scoreTemplateComplexity({
    capabilities: ["content.generation.images"],
  });
  const camel = scoreTemplateComplexity({
    capabilities: ["contentGeneration.images"],
  });
  assert.equal(dotted.raw, camel.raw);
  assert.ok(dotted.basis.mediaCapabilities === 1);
});
