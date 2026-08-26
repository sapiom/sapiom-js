// =============================================================================
// scripts/examples-test.mjs
//
// Run every template's own test suite.
//
// `examples/` sits OUTSIDE the pnpm workspace on purpose — a template has to
// install like a customer's project would, from the published `@sapiom/*`
// ranges its package.json pins. So its tests can't ride the root `pnpm test`:
// each template needs its own `npm install` first. That is what this does.
//
// Only templates that declare a `test` script are run; the rest are reported as
// skipped so adding a suite to one is a visible change here rather than a
// silent no-op. A template whose install or suite fails exits non-zero with the
// child's output already streamed, and every template still runs before the
// exit — one broken suite must not hide the next one.
// =============================================================================
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = path.join(ROOT, "examples");

const only = process.argv.slice(2);

/** Template directories (a dir with a package.json), sorted for stable output. */
function templateDirs() {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(EXAMPLES_DIR, name, "package.json")))
    .filter((name) => only.length === 0 || only.includes(name))
    .sort((a, b) => a.localeCompare(b));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  return result.status === 0;
}

const failed = [];
const passed = [];
const skipped = [];

for (const id of templateDirs()) {
  const dir = path.join(EXAMPLES_DIR, id);
  const packageJson = JSON.parse(
    readFileSync(path.join(dir, "package.json"), "utf8"),
  );
  if (!packageJson.scripts?.test) {
    skipped.push(id);
    continue;
  }

  console.log(`\n── ${id} ──────────────────────────────────────────────────`);
  // Most templates commit no lockfile — a customer's install resolves the
  // published ranges fresh, and that is the resolution we want to test. So
  // install without writing one, and only use `npm ci` where a template does
  // commit a lockfile, so running this never dirties the tree.
  const install = existsSync(path.join(dir, "package-lock.json"))
    ? ["ci", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund", "--no-package-lock"];
  if (!run("npm", install, dir)) {
    console.error(`examples-test: "${id}" failed to install.`);
    failed.push(id);
    continue;
  }
  if (!run("npm", ["test", "--silent"], dir)) {
    failed.push(id);
    continue;
  }
  passed.push(id);
}

console.log(
  `\nexamples-test: ${passed.length} passed, ${failed.length} failed, ` +
    `${skipped.length} without a suite (${skipped.join(", ") || "none"}).`,
);
if (failed.length > 0) {
  console.error(`examples-test: failing template(s): ${failed.join(", ")}`);
  process.exit(1);
}
