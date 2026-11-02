// =============================================================================
// scripts/zod-floor.test.mjs
//
// Keeps every zod this repository declares or resolves on the version set once in
// the pnpm catalog (pnpm-workspace.yaml), and that version at or above the floor.
// Workspace packages reference the catalog; examples install with npm outside the
// workspace and the scaffold fallback is generated, so both are compared to it here.
//
// Run:  pnpm examples:check:test   (node --test)
// =============================================================================

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = "4.6.6";
const DEP_FIELDS = ["dependencies", "devDependencies"];

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const readJson = (file) => JSON.parse(read(file));

const compare = (left, right) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const minimumOf = (range) => /^[\^~]?(\d+\.\d+\.\d+)$/.exec(range)?.[1] ?? null;

function catalogRange() {
  const block =
    /^catalog:\n((?:[ \t]+.*\n?)*)/m.exec(read("pnpm-workspace.yaml"))?.[1] ??
    "";
  return /^[ \t]+["']?zod["']?:[ \t]*["']?([^"'\s#]+)/m.exec(block)?.[1];
}

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
  assert.match(
    read("pnpm-workspace.yaml"),
    /^overrides:\n(?:[ \t]+.*\n|[ \t]*#.*\n)*?[ \t]+["']?zod["']?:[ \t]*["']catalog:["']/m,
    "pnpm-workspace.yaml overrides must force zod to catalog:",
  );
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
