import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pendingPackages } from "./release-pending.mjs";

async function packageRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "release-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests = {
    core: { name: "@sapiom/core", version: "1.0.0" },
    cli: { name: "@sapiom/cli", version: "2.0.0" },
    desktop: { name: "@sapiom/desktop", version: "3.0.0", private: true },
  };
  for (const [dir, manifest] of Object.entries(manifests)) {
    await mkdir(join(root, "packages", dir), { recursive: true });
    await writeFile(
      join(root, "packages", dir, "package.json"),
      JSON.stringify(manifest),
    );
  }
  return root;
}

function registry(answers) {
  const requested = [];
  const inits = [];
  const fetchImpl = async (url, init) => {
    requested.push(url);
    inits.push(init);
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    const { status = 200, versions = {} } = answer ?? { status: 404 };
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => ({ versions }),
    };
  };
  return { fetchImpl, requested, inits };
}

const CORE = "https://registry.npmjs.org/@sapiom%2fcore?write=true";
const CLI = "https://registry.npmjs.org/@sapiom%2fcli?write=true";

test("nothing is pending when every public version is on npm", async (t) => {
  const root = await packageRoot(t);
  const { fetchImpl, requested } = registry({
    [CORE]: { versions: { "1.0.0": {} } },
    [CLI]: { versions: { "2.0.0": {} } },
  });
  assert.deepEqual(await pendingPackages({ root, fetchImpl }), []);
  assert.deepEqual(requested.sort(), [CLI, CORE]);
});

test("a missing version or an unknown package is pending", async (t) => {
  const root = await packageRoot(t);
  const { fetchImpl } = registry({
    [CORE]: { versions: { "0.9.0": {} } },
    [CLI]: { status: 404 },
  });
  const pending = await pendingPackages({ root, fetchImpl });
  assert.deepEqual(
    pending.map((pkg) => `${pkg.name}@${pkg.version}`),
    ["@sapiom/cli@2.0.0", "@sapiom/core@1.0.0"],
  );
});

test("registry errors count as pending and are reported", async (t) => {
  const root = await packageRoot(t);
  const warnings = [];
  const { fetchImpl } = registry({
    [CORE]: { status: 500 },
    [CLI]: new Error("socket hang up"),
  });
  const pending = await pendingPackages({
    root,
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  assert.equal(pending.length, 2);
  assert.deepEqual(warnings.sort(), [
    "@sapiom/cli: registry lookup failed (socket hang up)",
    "@sapiom/core: registry answered HTTP 500",
  ]);
});

test("private packages are never looked up", async (t) => {
  const root = await packageRoot(t);
  const { fetchImpl, requested } = registry({});
  await pendingPackages({ root, fetchImpl });
  assert.ok(requested.every((url) => !url.includes("desktop")));
});

test("lookups bypass the registry CDN cache and carry a timeout", async (t) => {
  const root = await packageRoot(t);
  const { fetchImpl, requested, inits } = registry({});
  await pendingPackages({ root, fetchImpl });
  assert.ok(requested.every((url) => url.endsWith("?write=true")));
  for (const init of inits) {
    assert.equal(init.headers.accept, "application/json");
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("a stalled lookup times out and counts as pending", async (t) => {
  const root = await packageRoot(t);
  const warnings = [];
  // A real stalled socket keeps the process alive; AbortSignal.timeout's own
  // timer does not, so hold the loop open until the abort fires.
  const stalled = (url, init) =>
    new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 10_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      });
    });
  const pending = await pendingPackages({
    root,
    fetchImpl: stalled,
    warn: (message) => warnings.push(message),
    timeoutMs: 20,
  });
  assert.equal(pending.length, 2);
  assert.equal(warnings.length, 2);
  assert.ok(
    warnings.every((message) => /registry lookup failed/.test(message)),
  );
});

test("the CLI writes the step output and warns on registry errors", async (t) => {
  const root = await packageRoot(t);
  await mkdir(join(root, "scripts"));
  await cp(
    fileURLToPath(new URL("./release-pending.mjs", import.meta.url)),
    join(root, "scripts", "release-pending.mjs"),
  );
  // An unreachable registry drives the "treat as pending" path offline.
  await writeFile(
    join(root, "preload.mjs"),
    "globalThis.fetch = async () => { throw new Error('offline'); };\n",
  );
  const output = join(root, "github-output");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      join(root, "preload.mjs"),
      join(root, "scripts", "release-pending.mjs"),
    ],
    { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /::warning::@sapiom\/core: registry lookup failed \(offline\)/,
  );
  assert.match(result.stdout, /@sapiom\/cli@2\.0\.0/);
  assert.equal(await readFile(output, "utf8"), "pending=true\n");
});
