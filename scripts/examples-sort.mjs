#!/usr/bin/env node
// =============================================================================
// scripts/examples-sort.mjs
//
// Reorder `examples/registry.json` `templates` by `id` ascending, in place.
//
// Two PRs that each add a template edit the same `templates` array. Keeping the
// array sorted by `id` means adds land in different regions of the file, which
// narrows (does not eliminate) merge conflicts. Authors run this before pushing;
// `pnpm examples:check` fails CI if the committed file is out of order.
//
// Usage:  node scripts/examples-sort.mjs   (or `pnpm examples:sort`)
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(ROOT, "examples", "registry.json");

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));

if (!Array.isArray(registry.templates)) {
  console.error("registry.json has no `templates` array — nothing to sort.");
  process.exit(1);
}

registry.templates.sort((a, b) => String(a.id).localeCompare(String(b.id)));

// Emit prettier-formatted JSON (picks up the repo .prettierrc) so the file on
// disk always matches the formatter — a re-sort is a pure reorder with no
// formatting churn, which is the whole point of keeping conflicts small.
const config = await prettier.resolveConfig(REGISTRY_PATH);
const formatted = await prettier.format(JSON.stringify(registry), {
  ...config,
  parser: "json",
});
writeFileSync(REGISTRY_PATH, formatted);

console.log(
  `Sorted ${registry.templates.length} templates by id in examples/registry.json`,
);
