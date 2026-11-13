// =============================================================================
// scripts/zod-floor.test.mjs
//
// The pnpm catalog (pnpm-workspace.yaml) is the one place the zod version is set.
// Workspace dependencies must reference it (peer ranges are excluded). Examples
// install with npm outside the workspace and the scaffold pin is generated, so both
// must match the catalog minimum. The catalog and every lockfile resolution must
// meet FLOOR.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = "4.6.6";
const DEP_FIELDS = ["dependencies", "devDependencies"];

// A Windows checkout can turn LF into CRLF, which the line patterns below would
// not match.
const read = (file) =>
  readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const readJson = (file) => JSON.parse(read(file));

const compare = (left, right) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const minimumOf = (range) => /^[\^~]?(\d+\.\d+\.\d+)$/.exec(range)?.[1] ?? null;

// The zod value under a top-level YAML key, read line by line: the root has no
// YAML parser, and the blocks are flat `name: value`.
function zodUnder(key, yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break;
    const value = /^[ \t]+["']?zod["']?:[ \t]*["']?([^"'\s#]+)/.exec(line)?.[1];
    if (value) return value;
  }
  return undefined;
}

const catalogRange = (yaml = read("pnpm-workspace.yaml")) =>
  zodUnder("catalog", yaml);

function packageJsons(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...packageJsons(rel));
    else if (entry.name === "package.json") found.push(rel);
  }
  return found;
}

const zodDeclarations = (manifest) =>
  DEP_FIELDS.filter((field) => manifest[field]?.zod !== undefined).map(
    (field) => [field, manifest[field].zod],
  );

const catalog = catalogRange();
const catalogMinimum = catalog && minimumOf(catalog);

test("the pnpm catalog sets one zod at or above the floor, enforced by an override", () => {
  assert.ok(
    catalogMinimum,
    `pnpm-workspace.yaml catalog zod is not a plain range: ${catalog}`,
  );
  assert.ok(
    compare(catalogMinimum, FLOOR) >= 0,
    `pnpm-workspace.yaml catalog zod ${catalog} is below ${FLOOR}`,
  );
  assert.equal(
    zodUnder("overrides", read("pnpm-workspace.yaml")),
    "catalog:",
    "pnpm-workspace.yaml overrides must force zod to catalog:",
  );
});

test("a CRLF checkout yields the same catalog zod, here and in the scaffold generator", () => {
  const crlf = read("pnpm-workspace.yaml").replace(/\n/g, "\r\n");
  assert.equal(catalogRange(crlf), catalog);

  const tree = mkdtempSync(path.join(tmpdir(), "zod-floor-crlf-"));
  try {
    writeFileSync(path.join(tree, "pnpm-workspace.yaml"), crlf);
    for (const pkg of ["agent", "tools"]) {
      mkdirSync(path.join(tree, "packages", pkg), { recursive: true });
      copyFileSync(
        path.join(ROOT, "packages", pkg, "package.json"),
        path.join(tree, "packages", pkg, "package.json"),
      );
    }
    mkdirSync(path.join(tree, "packages/agent-core/scripts"), {
      recursive: true,
    });
    mkdirSync(path.join(tree, "packages/agent-core/src"));
    const script = "packages/agent-core/scripts/gen-version-fallback.mjs";
    copyFileSync(path.join(ROOT, script), path.join(tree, script));
    execFileSync(process.execPath, [path.join(tree, script)], {
      stdio: "ignore",
    });
    const generated = readFileSync(
      path.join(tree, "packages/agent-core/src/version-fallback.generated.ts"),
      "utf8",
    );
    assert.equal(/\bzod:\s*"([^"]+)"/.exec(generated)?.[1], catalogMinimum);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("workspace packages take zod from the catalog", () => {
  const packages = readdirSync(path.join(ROOT, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "package.json"))
    .filter((file) => {
      try {
        read(file);
        return true;
      } catch {
        return false;
      }
    });
  const offenders = packages.flatMap((file) =>
    zodDeclarations(readJson(file))
      .filter(([, range]) => range !== "catalog:")
      .map(([field, range]) => `${file} ${field}.zod = ${range}`),
  );
  assert.deepEqual(offenders, []);
});

test("examples declare the catalog's zod", () => {
  const offenders = [];
  for (const file of packageJsons("examples")) {
    const manifest = readJson(file);
    for (const [field, range] of zodDeclarations(manifest)) {
      if (range === "__ZOD_VERSION__") continue;
      if (minimumOf(range) !== catalogMinimum)
        offenders.push(`${file} ${field}.zod = ${range}`);
    }
    const override = manifest.overrides?.zod;
    if (
      override !== undefined &&
      override !== "$zod" &&
      minimumOf(override) !== catalogMinimum
    ) {
      offenders.push(`${file} overrides.zod = ${override}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("lockfiles resolve no zod below the floor", () => {
  const offenders = [];
  for (const match of read("pnpm-lock.yaml").matchAll(
    /(?<![\w/@.-])zod@(\d+\.\d+\.\d+)/g,
  )) {
    if (compare(match[1], FLOOR) < 0)
      offenders.push(`pnpm-lock.yaml zod@${match[1]}`);
  }
  const npmLocks = packageJsons("examples").map((file) =>
    path.join(path.dirname(file), "package-lock.json"),
  );
  for (const file of npmLocks) {
    let lock;
    try {
      lock = readJson(file);
    } catch {
      continue;
    }
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (
        /(?:^|\/)node_modules\/zod$/.test(key) &&
        compare(entry.version, FLOOR) < 0
      ) {
        offenders.push(`${file} ${key}@${entry.version}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the scaffold fallback pins the catalog's zod", () => {
  const generated = read(
    "packages/agent-core/src/version-fallback.generated.ts",
  );
  const zod = /\bzod:\s*"([^"]+)"/.exec(generated)?.[1];
  assert.equal(
    zod,
    catalogMinimum,
    "packages/agent-core/src/version-fallback.generated.ts: run the agent-core prebuild",
  );
});
