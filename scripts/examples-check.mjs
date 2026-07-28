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
//      (draft-07, includes the `category` and `complexity` enums).
//   2. `templates` is sorted by `id` ascending  (run `pnpm examples:sort` to fix).
//   3. every `sourcePath` dir exists and contains a `template.json`.
//   4. checkpoint discipline (human gates only, at most one per template).
//   5. every template.json validates against examples/template.schema.json,
//      including the declaration surface (requiredSecrets, settings,
//      defaultInput, zeroSetup) — see scripts/examples-manifest-check.mjs.
//   6. house-style copy rules the schemas cannot express — see
//      scripts/examples-copy-check.mjs. (The length caps ARE in the schemas,
//      as `maxLength`, so they surface through checks 1 and 5.)
//   7. the authored `complexity` band against the one DERIVED from the declared
//      shape; a 2+ band gap warns (see the divergence section for why).
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
import {
  complexityBandScore,
  scoreTemplateComplexity,
} from "./lib/template-complexity.mjs";

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

// 5. House-style copy rules the schemas cannot express. The length caps live in
// the schemas as `maxLength` and are reported by check 1/3; these are the two
// rules a `pattern` could reject but could not explain — naming the offending
// word is the whole value of the message. See scripts/examples-copy-check.mjs.
for (const t of templates) {
  errors.push(...checkCopy(t, manifests.get(t.id) ?? null));
}

if (errors.length > 0) {
  console.error(`examples/ failed validation (${errors.length} problem(s)):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// 7. Complexity divergence. The `complexity` enum itself is hard-validated by
// the schema (check 1); this compares the AUTHORED band against the one derived
// from `steps[].kind` / `capabilities` and warns at a 2+ band gap.
//
// The derived score is the guardrail here, not the answer. It is a proxy for
// what the band communicates — how much variation and judgment is in the
// output — and it reads only what the author declared, so a wide gap means one
// of two things, both worth a human look: the label is wrong, or the declared
// shape is wrong. The second case is the valuable one: a step that calls a model
// but says `kind: "compute"` also draws the wrong glyph in the gallery graph, so
// catching it pays for itself beyond this field.
//
// A warning and not an error on purpose. An author who has read the rubric and
// still disagrees with the scorer should be able to land that; a hard gate would
// make the proxy authoritative again, which is exactly what authoring this field
// was meant to stop.
const divergences = [];
for (const t of templates) {
  const authored = complexityBandScore(t.complexity);
  // Unset or unknown: the schema owns invalid values, the nudge below owns absent ones.
  if (authored === null) continue;
  const derived = scoreTemplateComplexity(t);
  const gap = Math.abs(authored - derived.score);
  if (gap > 0)
    divergences.push({ id: t.id, authored: t.complexity, derived, gap });
}

for (const d of divergences.filter((x) => x.gap >= 2)) {
  const { basis, raw, label } = d.derived;
  console.warn(
    `warning: complexity: "${d.id}" declares "${d.authored}" but its declared shape derives ` +
      `"${label}" (raw ${raw}: llm=${basis.llmSteps} chained=${basis.chainedLlmSteps} ` +
      `media=${basis.mediaCapabilities} caps=${basis.capabilityCount} steps=${basis.stepCount} ` +
      `fanOut=${basis.maxFanOut}) — a ${d.gap}-band gap. Either the band is wrong, or a ` +
      `\`steps[].kind\` is (a model step declared "compute" also draws the wrong glyph). ` +
      `See AUTHORING.md §3.`,
  );
}

// One band apart is expected and fine — the rubric's nudge is a whole band wide.
// Reported as a single line so a day-one divergence stays visible without
// becoming noise that trains authors to ignore the warnings above.
const nearMisses = divergences.filter((x) => x.gap === 1);
if (nearMisses.length > 0) {
  console.log(
    `note: ${nearMisses.length} template(s) one band from the derived score (authored → derived): ` +
      nearMisses
        .map((d) => `${d.id} ${d.authored}→${d.derived.label}`)
        .join(", "),
  );
}

const uncategorized = templates.filter((t) => !t.category).map((t) => t.id);
const noCadence = templates.filter((t) => !t.cadence).map((t) => t.id);
const noComplexity = templates.filter((t) => !t.complexity).map((t) => t.id);
for (const [label, ids] of [
  ["category", uncategorized],
  ["cadence", noCadence],
  ["complexity", noComplexity],
]) {
  // Both are optional in the schema, so this is a nudge, not a gate — flip to
  // `errors.push` once every template carries them and the field goes required.
  if (ids.length > 0) {
    console.warn(
      `warning: ${ids.length} template(s) missing \`${label}\`: ${ids.join(", ")}`,
    );
  }
}

console.log(
  `examples/registry.json OK — ${templates.length} templates, sorted, schema-valid, all sourcePaths present; ${manifestsChecked} template.json manifest(s) schema-valid.`,
);
