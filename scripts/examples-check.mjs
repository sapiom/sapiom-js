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
//   4b. `discipline` sits under its row's `category` — a cross-field constraint
//      draft-07 cannot express readably. See scripts/examples-discipline-check.mjs.
//   5. every template.json validates against examples/template.schema.json,
//      including the declaration surface (requiredSecrets, settings,
//      defaultInput, zeroSetup) — see scripts/examples-manifest-check.mjs.
//   5b. the manifest's renderable projection (defaultInput / settings) only
//      names paths the code's entry `inputSchema` declares — a projection onto
//      a field the schema never declares is the drift SAP-2226 exists to catch.
//      See scripts/examples-entry-schema-check.mjs.
//   5c. a resource marked reusable (`resources[].reuse.key`) has that key read
//      via `resolveResourceHandle` in index.ts — so the reuse picker (SAP-2320)
//      can never offer a handle the run ignores. See examples-manifest-check.mjs.
//   6. house-style copy rules the schemas cannot express, including registered
//      clone-facing authoring/source assets — see scripts/examples-copy-check.mjs.
//      (The length caps ARE in the schemas, as `maxLength`, so they surface
//      through checks 1 and 5.)
//   6b. setup.provisions[] matches the kinds derived from the manifest's
//      resources[]; a declared resources[].seed file exists.
//   7. the authored `complexity` band against the one DERIVED from the declared
//      shape; a 2+ band gap warns (see the divergence section for why).
//
// Exits non-zero with a readable report on the first category of failure it
// finds, so a bad registry fails CI before it reaches the backend.
//
// Usage:  node scripts/examples-check.mjs   (or `pnpm examples:check`)
// =============================================================================

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  checkResourceReuse,
  checkResourceSeeds,
  checkSetupSync,
  createManifestChecker,
} from "./examples-manifest-check.mjs";
import {
  checkCopy,
  checkRegisteredProjectCopyAsset,
  isRegisteredProjectCopyAsset,
  isRegisteredProjectCopyPathIgnored,
} from "./examples-copy-check.mjs";
import { checkDiscipline } from "./examples-discipline-check.mjs";
import { checkEntrySchemaCoverage } from "./examples-entry-schema-check.mjs";
import {
  complexityBandScore,
  scoreTemplateComplexity,
} from "./lib/template-complexity.mjs";
import {
  ONE_SHOT_LLM_TEMPLATE_IDS,
  checkLlmCopySurface,
  checkNoSliceParse,
  checkOneShotLlmTemplate,
} from "./lib/examples-llm-surface.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const REGISTRY_PATH = path.join(EXAMPLES_DIR, "registry.json");
const SCHEMA_PATH = path.join(EXAMPLES_DIR, "registry.schema.json");
const MANIFEST_SCHEMA_PATH = path.join(EXAMPLES_DIR, "template.schema.json");

const errors = [];

/**
 * Every source file under `examples/`, skipping `node_modules` and build output.
 *
 * `.mjs` and `.js` are in scope alongside `.ts`: templates ship helper scripts
 * and test suites in plain JS, and a slice-parse hidden in one of those is the
 * same defect. `.d.ts` is excluded — a declaration file has no parse in it, and
 * a generated one shouldn't fail an author's check.
 */
const TEMPLATE_SOURCE_EXTENSIONS = [".ts", ".mjs", ".cjs", ".js"];

function collectTemplateSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTemplateSources(absolutePath));
      continue;
    }
    if (
      entry.isFile() &&
      !entry.name.endsWith(".d.ts") &&
      TEMPLATE_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
    ) {
      files.push(absolutePath);
    }
  }
  return files;
}

function collectRegisteredProjectCopyAssets(sourceDir, currentDir = sourceDir) {
  const assets = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(sourceDir, absolutePath);

    if (entry.isDirectory()) {
      if (isRegisteredProjectCopyPathIgnored(relativePath)) continue;
      assets.push(
        ...collectRegisteredProjectCopyAssets(sourceDir, absolutePath),
      );
      continue;
    }

    if (entry.isFile() && isRegisteredProjectCopyAsset(relativePath)) {
      assets.push(absolutePath);
    }
  }
  return assets;
}

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
const templateById = new Map(
  templates.map((template) => [template.id, template]),
);

// No example may teach that the gateway-native one-shot surface is absent.
// Scan every project, not just gallery-registered templates, because these
// files are also copied or read directly by authors.
for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const name of ["AGENTS.md", "README.md", "index.ts"]) {
    const absolutePath = path.join(EXAMPLES_DIR, entry.name, name);
    if (!existsSync(absolutePath)) continue;
    errors.push(
      ...checkLlmCopySurface({
        path: path.relative(ROOT, absolutePath),
        source: readFileSync(absolutePath, "utf8"),
      }),
    );
  }
}

// Existing one-shot LLM templates must stay on the synchronous gateway surface.
// This is intentionally explicit: `models.run` remains a valid capability for a
// genuinely multi-turn managed loop, so a repo-wide string ban would reject
// future examples that use that different surface correctly.
for (const id of ONE_SHOT_LLM_TEMPLATE_IDS) {
  const dir = path.join(EXAMPLES_DIR, id);
  const indexPath = path.join(dir, "index.ts");
  const packagePath = path.join(dir, "package.json");
  const missingPaths = [indexPath, packagePath].filter(
    (requiredPath) => !existsSync(requiredPath),
  );
  if (missingPaths.length > 0) {
    for (const missingPath of missingPaths) {
      errors.push(
        `llm-surface: "${id}" is listed as a one-shot template but is missing ${path.relative(ROOT, missingPath)}.`,
      );
    }
    continue;
  }

  const indexSource = readFileSync(indexPath, "utf8");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const copySources = ["AGENTS.md", "README.md", "template.json"]
    .map((name) => ({ path: name, absolutePath: path.join(dir, name) }))
    .filter(({ absolutePath }) => existsSync(absolutePath))
    .map(({ path: copyPath, absolutePath }) => ({
      path: copyPath,
      source: readFileSync(absolutePath, "utf8"),
    }));
  copySources.push({ path: "index.ts", source: indexSource });
  errors.push(
    ...checkOneShotLlmTemplate({
      id,
      indexSource,
      copySources,
      packageJson,
      registryTemplate: templateById.get(id),
    }),
  );
}

// No template may slice a model reply from the first "{" to the last "}".
// Deliberately repo-wide over `examples/`, not scoped to a template list: the
// parse used to live in `lib/` helpers and sibling modules as well as
// `index.ts`, and the whole point is that a NEW template can't reintroduce it
// (SAP-2892).
for (const sourcePath of collectTemplateSources(EXAMPLES_DIR)) {
  errors.push(
    ...checkNoSliceParse({
      path: path.relative(ROOT, sourcePath).split(path.sep).join("/"),
      source: readFileSync(sourcePath, "utf8"),
    }),
  );
}

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
let projectCopyAssetsChecked = 0;
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

  errors.push(
    ...checkResourceSeeds(t.id, manifest, (seed) =>
      existsSync(path.join(dir, seed)),
    ),
  );

  // 5b. The manifest's renderable projection (defaultInput / settings) may only
  // name paths the code's entry `inputSchema` declares — otherwise the shelf
  // paints a field the run drops. The entry schema is read statically from
  // index.ts; a template without one is read as `null` (source absent) below.
  const indexPath = path.join(dir, "index.ts");
  const indexSource = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : null;
  errors.push(...checkEntrySchemaCoverage(t.id, manifest, indexSource));

  // 5c. A resource marked reusable (`reuse.key`) must have its handle read from
  // the entry input via `resolveResourceHandle` in the same index.ts — otherwise
  // the picker offers a control the next run silently ignores (design-v2
  // § Landmines). Reuses the index source read just above.
  errors.push(...checkResourceReuse(t.id, manifest, indexSource));

  for (const assetPath of collectRegisteredProjectCopyAssets(dir)) {
    const repositoryPath = path
      .relative(ROOT, assetPath)
      .split(path.sep)
      .join("/");
    errors.push(
      ...checkRegisteredProjectCopyAsset(
        t,
        repositoryPath,
        readFileSync(assetPath, "utf8"),
      ),
    );
    projectCopyAssetsChecked++;
  }

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

// 4c. Onboarding-shelf discipline. `onboarding.eligible` is the STRICTER-than-gallery
// first-impression bar the app renders as its onboarding suggestion shelf. The schema
// gives it structure; these two rules give it integrity: (1) a template can only be a
// good first impression if it runs with zero setup at all, so eligibility requires
// `setup.runsWithNoSetup`; (2) `order` is the deterministic shelf sequence, so two
// eligible templates must not claim the same slot.
const shelfOrders = new Map();
for (const t of templates) {
  const ob = t.onboarding;
  if (!ob || ob.eligible !== true) continue;
  if (t.setup?.runsWithNoSetup !== true) {
    errors.push(
      `onboarding: "${t.id}" is onboarding.eligible but setup.runsWithNoSetup is not true — the shelf is a fresh-tenant first impression, so it must run with zero setup. Verify it, or drop the eligible flag.`,
    );
  }
  if (typeof ob.order === "number") {
    const prev = shelfOrders.get(ob.order);
    if (prev) {
      errors.push(
        `onboarding: "${t.id}" and "${prev}" both declare onboarding.order ${ob.order} — the shelf order must be unique so the sequence is deterministic.`,
      );
    } else {
      shelfOrders.set(ob.order, t.id);
    }
  }
}

// 4b. `discipline` agrees with `category`. A hard error, not a warning like the
// complexity divergence below: that one compares an author's judgment against a
// proxy and the author can be right, whereas a discipline outside its category's
// set is not a judgment call — one of the two fields is simply wrong, and the
// gallery would file the card in one group while badging it as another.
for (const t of templates) {
  errors.push(...checkDiscipline(t));
}

// 5. House-style copy rules the schemas cannot express. The length caps live in
// the schemas as `maxLength` and are reported by check 1/3; these are the rules
// a `pattern` could reject but could not explain — naming the offending
// word is the whole value of the message. See scripts/examples-copy-check.mjs.
for (const t of templates) {
  errors.push(...checkCopy(t, manifests.get(t.id) ?? null));
}

// 6b. The whole `registry.setup` block is DERIVED from the manifest (secrets,
// settings, resources, zeroSetup) by `pnpm examples:sync-setup`, so it gets
// verified rather than trusted — the drift that let `capabilities[]` fill up
// with SDK method paths, applied to the entire denormalised block. Only checked
// for templates that have a manifest (others are already flagged above).
for (const t of templates) {
  const manifest = manifests.get(t.id);
  if (manifest) errors.push(...checkSetupSync(t, manifest));
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
const noDiscipline = templates.filter((t) => !t.discipline).map((t) => t.id);
for (const [label, ids] of [
  ["category", uncategorized],
  ["cadence", noCadence],
  ["complexity", noComplexity],
  ["discipline", noDiscipline],
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
  `examples/registry.json OK — ${templates.length} templates, sorted, schema-valid, all sourcePaths present; ${manifestsChecked} template.json manifest(s) schema-valid; ${projectCopyAssetsChecked} registered project authoring/source asset(s) terminology-checked.`,
);
