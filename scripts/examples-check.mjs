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
//   4. checkpoint discipline (human gates only, at most one per template).
//   5. every template.json validates against examples/template.schema.json,
//      including the declaration surface (requiredSecrets, settings,
//      defaultInput, zeroSetup) — see scripts/examples-manifest-check.mjs.
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
import { createManifestChecker } from "./examples-manifest-check.mjs";
import { checkCopy } from "./examples-copy-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const REGISTRY_PATH = path.join(EXAMPLES_DIR, "registry.json");
const SCHEMA_PATH = path.join(EXAMPLES_DIR, "registry.schema.json");
const MANIFEST_SCHEMA_PATH = path.join(EXAMPLES_DIR, "template.schema.json");

const errors = [];

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const manifestSchema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf8"));

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

// 3. Every sourcePath dir exists and has a template.json, and 5. that manifest
// validates against template.schema.json. Folded into one pass because the
// manifest check needs the same resolved path — and because a manifest that only
// had to *exist* is how `repoSlug: "my-app"` shipped.
const checkManifest = createManifestChecker(ajv, manifestSchema);
const manifests = new Map(); // id -> parsed manifest, reused by the copy check
let manifestsChecked = 0;
for (const t of templates) {
  if (!t.sourcePath) continue; // required-ness is a schema concern (check 1).
  const dir = path.join(ROOT, t.sourcePath);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    errors.push(
      `sourcePath: "${t.id}" points to "${t.sourcePath}", which is not a directory.`,
    );
    continue;
  }
  const manifestPath = path.join(dir, "template.json");
  if (!existsSync(manifestPath)) {
    errors.push(`sourcePath: "${t.sourcePath}" is missing a template.json.`);
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    errors.push(
      `manifest-parse: "${t.id}" template.json is not valid JSON: ${e.message}`,
    );
    continue;
  }
  errors.push(...checkManifest(t.id, manifest));
  manifests.set(t.id, manifest);
  manifestsChecked++;
}

// 4. Checkpoint discipline. `checkpoint` marks a HUMAN approval gate and the
// gallery renders it as the template's approval boundary, so a checkpoint on a
// machine wait (a render job, a webhook callback) would advertise a boundary that
// doesn't exist. The schema can express "boolean" but not these two rules.
for (const t of templates) {
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const gates = steps.filter((s) => s.checkpoint === true);
  for (const s of gates) {
    if (s.kind !== "pause") {
      errors.push(
        `checkpoint: "${t.id}" step "${s.name}" is checkpoint:true but kind:"${s.kind ?? "unset"}" — a human gate must also be kind:"pause".`,
      );
    }
  }
  if (gates.length > 1) {
    errors.push(
      `checkpoint: "${t.id}" declares ${gates.length} checkpoints (${gates.map((s) => `"${s.name}"`).join(", ")}) — at most one per template; mark only the gate the gallery should show.`,
    );
  }
}

if (errors.length > 0) {
  console.error(`examples/ failed validation (${errors.length} problem(s)):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const uncategorized = templates.filter((t) => !t.category).map((t) => t.id);
const noCadence = templates.filter((t) => !t.cadence).map((t) => t.id);
for (const [label, ids] of [
  ["category", uncategorized],
  ["cadence", noCadence],
]) {
  // Both are optional in the schema, so this is a nudge, not a gate — flip to
  // `errors.push` once every template carries them and the field goes required.
  if (ids.length > 0) {
    console.warn(
      `warning: ${ids.length} template(s) missing \`${label}\`: ${ids.join(", ")}`,
    );
  }
}

// 6. House-style copy rules. Warnings on purpose — every limit fails every
// template today, so a gate would block every PR. The count below is the
// burn-down; when it hits zero, move the caps into the schemas as `maxLength`
// and flip these to `errors.push`. See scripts/examples-copy-check.mjs.
const copyWarnings = templates.flatMap((t) =>
  checkCopy(t, manifests.get(t.id) ?? null),
);
if (copyWarnings.length > 0) {
  const affected = new Set(
    copyWarnings.map((w) => w.slice(w.indexOf('"') + 1, w.indexOf('" '))),
  );
  console.warn(
    `\ncopy style: ${copyWarnings.length} warning(s) across ${affected.size} of ${templates.length} template(s) — not a gate yet:\n`,
  );
  for (const w of copyWarnings) console.warn(`  - ${w}`);
  console.warn("");
}

console.log(
  `examples/registry.json OK — ${templates.length} templates, sorted, schema-valid, all sourcePaths present; ${manifestsChecked} template.json manifest(s) schema-valid.`,
);
