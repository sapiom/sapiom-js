// =============================================================================
// scripts/examples-registry-schema.test.mjs
//
// Fixture tests for the registry `setup` block (SAP-2076) — the runnability
// summary the gallery shelf renders from `listTemplates`, which never fetches a
// manifest. Denormalised on purpose, so the shape has to be pinned here rather
// than trusted to whoever next hand-edits registry.json.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv from "ajv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "examples", "registry.schema.json"), "utf8"),
);

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

/** Validate a registry containing one template with the given setup block. */
const check = (setup) => {
  const ok = validate({
    version: 1,
    templates: [
      {
        id: "fixture",
        name: "Fixture",
        description: "One line.",
        sourcePath: "examples/fixture",
        ...(setup === undefined ? {} : { setup }),
      },
    ],
  });
  return ok
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

test("setup is optional", () => {
  assert.deepEqual(check(undefined), []);
});

test("a fully declared setup block is valid", () => {
  assert.deepEqual(
    check({
      runsWithNoSetup: true,
      connectionCount: 0,
      settingCount: 2,
      provisions: ["postgres", "sandbox"],
      degradedWithoutSetup:
        "Produces the report and attaches it to the run; sends nothing.",
    }),
    [],
  );
});

test("setup requires runsWithNoSetup — it is never implied", () => {
  const errors = check({ connectionCount: 1 });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\/templates\/0\/setup must have required property 'runsWithNoSetup'/,
  );
});

test("a typo'd setup field fails rather than being silently ignored", () => {
  const errors = check({ runsWithNoSetup: false, connectionsCount: 1 });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\/templates\/0\/setup must NOT have additional properties/,
  );
});

test("a provision kind outside the closed vocabulary fails", () => {
  const errors = check({ runsWithNoSetup: false, provisions: ["kafka"] });
  assert.ok(
    errors.some((e) => e.startsWith("/templates/0/setup/provisions/0")),
    errors.join("; "),
  );
});

test("a negative count fails", () => {
  const errors = check({ runsWithNoSetup: false, settingCount: -1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/templates\/0\/setup\/settingCount must be >= 0/);
});

test("setup carries no 'pauses' flag — approval comes from steps[].checkpoint", () => {
  const setup = schema.definitions.template.properties.setup;
  assert.equal(setup.additionalProperties, false);
  for (const forbidden of ["pauses", "pausesForApproval", "checkpoint"]) {
    assert.ok(
      !(forbidden in setup.properties),
      `${forbidden} must not exist: the shelf's approval state is already derivable from steps[].checkpoint, which examples-check.mjs enforces.`,
    );
  }
  assert.ok("checkpoint" in schema.definitions.step.properties);
});
