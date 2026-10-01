import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(packageRoot, "../..");
const pnpm = process.env.npm_execpath;
assert(pnpm && /pnpm(?:\.c?js)?$/.test(pnpm), "Run with pnpm test:package");
const consumer = await mkdtemp(join(tmpdir(), "mcp-installed-contract-"));
const run = (args, cwd, options = {}) =>
  execFileSync(process.execPath, [pnpm, ...args], {
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SAPIOM_TELEMETRY_DISABLED: "1" },
    ...options,
  });
try {
  // Pack the actual local production closure; workspace ranges must never
  // silently resolve to an older registry package during this proof.
  const overrides = {};
  const pack = async (name) => {
    if (overrides[name]) return;
    const root = join(repo, "packages", name.slice("@sapiom/".length));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    overrides[name] =
      `file:${join(consumer, `${name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`)}`;
    run(["pack", "--pack-destination", consumer], root);
    for (const [dependency, range] of Object.entries({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      if (String(range).startsWith("workspace:")) await pack(dependency);
    }
  };
  await pack("@sapiom/mcp");
  assert.equal(
    (await readdir(consumer)).filter((file) => file.endsWith(".tgz")).length,
    Object.keys(overrides).length,
  );
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@sapiom/mcp": overrides["@sapiom/mcp"],
        "@sapiom/agent-map": overrides["@sapiom/agent-map"],
      },
      pnpm: { overrides },
    }),
  );
  run(
    ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"],
    consumer,
    { timeout: 300_000, stdio: "inherit" },
  );
  const runner = join(consumer, "installed-contract.mjs");
  await writeFile(
    runner,
    await readFile(new URL("./installed-contract.mjs", import.meta.url)),
  );
  execFileSync(process.execPath, [runner], {
    cwd: consumer,
    stdio: "inherit",
    windowsHide: true,
    timeout: 45_000,
    env: { ...process.env, SAPIOM_TELEMETRY_DISABLED: "1" },
  });
  console.log(
    `Installed MCP contract passed outside the workspace (${Object.keys(overrides).length} local packages).`,
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
