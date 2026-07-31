#!/usr/bin/env node
// =============================================================================
// scripts/examples-sync-setup.mjs
//
// Regenerate every registry template's `setup` block from its co-located
// `template.json` (the manifest), in place.
//
// The gallery shelf renders `setup` from the thin registry index (listTemplates
// never fetches manifests — that would be an N+1), so the block is denormalised
// here from the manifest's requiredSecrets / settings / resources[] / zeroSetup.
// It is GENERATED, never hand-maintained: `pnpm examples:check` (checkSetupSync)
// fails CI if the committed block drifts from what the manifest implies.
//
// Usage:  node scripts/examples-sync-setup.mjs   (or `pnpm examples:sync-setup`)
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { deriveSetup } from "./examples-manifest-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(ROOT, "examples", "registry.json");

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
if (!Array.isArray(registry.templates)) {
  console.error("registry.json has no `templates` array — nothing to sync.");
  process.exit(1);
}

let changed = 0;
const missing = [];
for (const t of registry.templates) {
  const dir = path.join(ROOT, t.sourcePath ?? path.join("examples", t.id));
  const manifestPath = path.join(dir, "template.json");
  if (!existsSync(manifestPath)) {
    // No manifest ⇒ nothing to derive from; leave any existing setup untouched
    // and let examples:check report the missing manifest itself.
    missing.push(t.id);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const setup = deriveSetup(manifest);
  if (JSON.stringify(t.setup) !== JSON.stringify(setup)) changed++;
  t.setup = setup;
}

// Emit prettier-formatted JSON (repo .prettierrc) so the file on disk always
// matches the formatter — same approach as examples:sort, so a sync is a pure
// content change with no formatting churn.
const config = await prettier.resolveConfig(REGISTRY_PATH);
const formatted = await prettier.format(JSON.stringify(registry), {
  ...config,
  parser: "json",
});
writeFileSync(REGISTRY_PATH, formatted);

console.log(
  `Synced setup on ${registry.templates.length - missing.length} template(s) (${changed} changed)` +
    (missing.length
      ? `; skipped ${missing.length} with no manifest: ${missing.join(", ")}`
      : "") +
    ".",
);
