#!/usr/bin/env node
// =============================================================================
// scripts/examples-check.mjs
//
// Validate `examples/registry.json` — the template gallery index the Sapiom
// backend fetches at a pinned ref. The `examples/` tree lives outside the pnpm
// workspace, so this is the one gate that runs against it on every PR.
//
// Checks:
//   1. registry.json validates against examples/registry.schema.json
//      (draft-07, includes the `category` enum).
//   2. `templates` is sorted by `id` ascending  (run `pnpm examples:sort` to fix).
//   3. every `sourcePath` dir exists and contains a `template.json`.
//
// Exits non-zero with a readable report on the first category of failure it
// finds, so a bad registry fails CI before it reaches the backend.
//
// Usage:  node scripts/examples-check.mjs   (or `pnpm examples:check`)
// =============================================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const REGISTRY_PATH = path.join(EXAMPLES_DIR, "registry.json");
const SCHEMA_PATH = path.join(EXAMPLES_DIR, "registry.schema.json");

const errors = [];

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

// 1. Schema validation. The schema carries its own `$schema`/`$id`; strip the
// data's own `$schema` pointer so ajv validates the payload, not the reference.
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const { $schema, ...payload } = registry;
if (!validate(payload)) {
  for (const e of validate.errors ?? []) {
    errors.push(`schema: ${e.instancePath || "/"} ${e.message}`);
  }
}

const templates = Array.isArray(registry.templates) ? registry.templates : [];

// 2. Sorted by id ascending.
const ids = templates.map((t) => String(t.id));
const sorted = [...ids].sort((a, b) => a.localeCompare(b));
for (let i = 0; i < ids.length; i++) {
  if (ids[i] !== sorted[i]) {
    errors.push(
      `sort: templates are not sorted by id ascending (first out of order: "${ids[i]}", expected "${sorted[i]}"). Run \`pnpm examples:sort\`.`,
    );
    break;
  }
}

// 3. Every sourcePath dir exists and has a template.json.
for (const t of templates) {
  if (!t.sourcePath) continue; // required-ness is a schema concern (check 1).
  const dir = path.join(ROOT, t.sourcePath);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    errors.push(
      `sourcePath: "${t.id}" points to "${t.sourcePath}", which is not a directory.`,
    );
    continue;
  }
  if (!existsSync(path.join(dir, "template.json"))) {
    errors.push(`sourcePath: "${t.sourcePath}" is missing a template.json.`);
  }
}

if (errors.length > 0) {
  console.error(
    `examples/registry.json failed validation (${errors.length} problem(s)):\n`,
  );
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `examples/registry.json OK — ${templates.length} templates, sorted, schema-valid, all sourcePaths present.`,
);
