#!/usr/bin/env node
// =============================================================================
// scripts/publish-local.mjs
//
// Publish all public @sapiom/* packages to the LOCAL Verdaccio registry
// (http://localhost:4873) so the Sapiom monorepo + a customer-like MCP session
// can consume local SDK edits without a real npm publish. See
// docs/guides/workflows-authoring-quickstart.md §4.
//
// Each run stamps a FRESH version (patch-bump beyond whatever the local registry
// already has, and beyond the source version so it never collides with real npm):
//   - a REAL patch (not a prerelease) so the monorepo's `^0.5.0`-style ranges
//     still match it, AND it becomes the `latest` tag the scaffold exact-pins.
//   - a new version each run → cache-safe (no pnpm integrity collisions).
// Internal `workspace:^` deps are rewritten to the stamped versions by pnpm at
// publish time. Source package.json version bumps are REVERTED at the end so git
// stays clean — the registry, not the working tree, tracks the local version.
//
// Usage:  node scripts/publish-local.mjs [--skip-build]
// Prereq: the registry must be running — `pnpm registry:local` in another shell.
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "http://localhost:4873";

// Publish set in dependency (topological) order. Skips the quarantined langchain*.
const PACKAGES = [
  "core",
  "fetch",
  "tools",
  "agent",
  "agent-runtime",
  "agent-core",
  "sandbox",
  "sandbox-preview",
  "cli",
  "mcp",
];

function pkgJsonPath(dir) {
  return path.join(ROOT, "packages", dir, "package.json");
}
function readPkg(dir) {
  return JSON.parse(readFileSync(pkgJsonPath(dir), "utf8"));
}

/** Bump the patch of an x.y.z version, stripping any prerelease/build suffix. */
function bumpPatch(version) {
  const [core] = version.split(/[-+]/);
  const [major, minor, patch] = core.split(".").map((n) => parseInt(n, 10));
  return `${major}.${minor}.${patch + 1}`;
}

/** Highest version currently on the local registry, or null if never published. */
function localRegistryVersion(name) {
  try {
    return (
      execFileSync("npm", ["view", name, "version", "--registry", REGISTRY], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

// A Verdaccio-scoped userconfig: anonymous publish still needs *a* token line, and
// the registry pointer. Gitignored (.verdaccio/.npmrc) — never the real npm config.
function writeAuthNpmrc() {
  const npmrc = path.join(ROOT, ".verdaccio", ".npmrc");
  mkdirSync(path.dirname(npmrc), { recursive: true });
  writeFileSync(
    npmrc,
    `registry=${REGISTRY}/\n//localhost:4873/:_authToken=local-dev\n`,
  );
  return npmrc;
}

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

// --- preflight: registry reachable? ---
try {
  execFileSync("curl", ["-sf", "-o", "/dev/null", `${REGISTRY}/-/ping`], {
    stdio: "ignore",
  });
} catch {
  console.error(
    `\n✗ Local registry not reachable at ${REGISTRY}.\n  Start it first:  pnpm registry:local\n`,
  );
  process.exit(1);
}

const skipBuild = process.argv.includes("--skip-build");
if (!skipBuild) {
  // tsc leaves orphaned outputs after a source file/dir rename (e.g. tools/agent →
  // tools/models), which then get published as dead files under the old name. Clean first.
  // Remove dist AND *.tsbuildinfo — else tsc --incremental sees stale buildinfo, thinks
  // outputs are current, and emits NOTHING (buildinfo can live at pkg root, not in dist).
  console.log("• Cleaning stale dist + tsbuildinfo…");
  run("pnpm", ["-r", "--filter=./packages/*", "exec", "sh", "-c", "rm -rf dist *.tsbuildinfo"]);
  console.log("• Building all packages…");
  run("pnpm", ["-r", "--filter=./packages/*", "build"]);
}

// 1. Compute the next version for each package (bump beyond source AND registry).
const versions = {};
const originals = {};
for (const dir of PACKAGES) {
  const pkg = readPkg(dir);
  originals[dir] = pkg.version;
  const local = localRegistryVersion(pkg.name);
  // Take the higher of source/local as the floor, then patch-bump it.
  const floor = local && cmp(local, pkg.version) >= 0 ? local : pkg.version;
  versions[dir] = bumpPatch(floor);
}

// 2. Write the stamped versions (so pnpm rewrites workspace:^ → ^<new version>).
for (const dir of PACKAGES) {
  const pkg = readPkg(dir);
  pkg.version = versions[dir];
  writeFileSync(pkgJsonPath(dir), JSON.stringify(pkg, null, 2) + "\n");
}

const authNpmrc = writeAuthNpmrc();
const failed = [];
try {
  for (const dir of PACKAGES) {
    const { name } = readPkg(dir);
    console.log(`• Publishing ${name}@${versions[dir]} → ${REGISTRY}`);
    try {
      run(
        "pnpm",
        [
          "--filter",
          name,
          "publish",
          "--registry",
          REGISTRY,
          "--no-git-checks",
          "--tag",
          "latest",
        ],
        {
          npm_config_userconfig: authNpmrc,
        },
      );
    } catch {
      failed.push(name);
    }
  }
} finally {
  // 3. Revert source version bumps so the working tree stays clean. Restore ONLY the
  //    `version` field (from the pre-bump originals) — a `git checkout` of the whole
  //    file would also clobber legitimate uncommitted edits (e.g. a new dependency).
  for (const dir of PACKAGES) {
    const pkg = readPkg(dir);
    if (pkg.version !== originals[dir]) {
      pkg.version = originals[dir];
      writeFileSync(pkgJsonPath(dir), JSON.stringify(pkg, null, 2) + "\n");
    }
  }
}

if (failed.length) {
  console.error(`\n✗ Failed to publish: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(
  `\n✓ Published ${PACKAGES.length} @sapiom/* packages to ${REGISTRY} (latest patch stamped).`,
);
console.log(
  "  Monorepo:  pnpm install --registry http://localhost:4873  (then restart pnpm dev)",
);
console.log(
  "  Author session / MCP:  npm install / npx with npm_config_registry=http://localhost:4873",
);

/** Compare two x.y.z versions (ignoring prerelease): -1 / 0 / 1. */
function cmp(a, b) {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0))
      return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}
