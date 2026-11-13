import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(packageRoot, "../..");
const pnpm = process.env.npm_execpath;
assert(pnpm && /pnpm(?:\.c?js)?$/.test(pnpm), "Run with pnpm test:package");
const workspaceVersion = (name) =>
  createRequire(packageRoot)(`${name}/package.json`).version;
const run = (file, args, cwd) =>
  execFileSync(process.execPath, [file, ...args], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    timeout: 300_000,
    env: { ...process.env, SAPIOM_TELEMETRY_DISABLED: "1" },
  });

const scratch = await mkdtemp(join(tmpdir(), "agent-zod-peers-"));
try {
  // Pack the local production closure, so a workspace range never resolves to
  // an older registry package. Declarations are checked with skipLibCheck off,
  // so the consumer also installs each packed package's peers, optional ones
  // included, and Node's types: a missing one would fail the check for an
  // unrelated reason.
  const overrides = {};
  const peers = {};
  const pack = async (name) => {
    if (overrides[name]) return;
    const root = join(repo, "packages", name.slice("@sapiom/".length));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    overrides[name] =
      `file:${join(scratch, `${name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`)}`;
    run(pnpm, ["pack", "--pack-destination", scratch], root);
    Object.assign(peers, pkg.peerDependencies);
    for (const [dependency, range] of Object.entries(pkg.dependencies ?? {})) {
      if (String(range).startsWith("workspace:")) await pack(dependency);
    }
    return pkg;
  };
  const agent = await pack("@sapiom/agent");

  // Every lower bound of the zod peer range, and the zod this build used.
  const zodVersions = new Set([
    ...agent.peerDependencies.zod
      .split("||")
      .map((alternative) => alternative.match(/\d+\.\d+\.\d+/)[0]),
    workspaceVersion("zod"),
  ]);

  for (const zod of zodVersions) {
    const consumer = join(scratch, `zod-${zod}`);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          ...peers,
          "@sapiom/agent": overrides["@sapiom/agent"],
          "@types/node": workspaceVersion("@types/node"),
          typescript: workspaceVersion("typescript"),
          zod,
        },
        pnpm: { overrides },
      }),
    );
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          module: "NodeNext",
          target: "ES2022",
        },
        files: ["consumer.ts"],
      }),
    );
    await writeFile(
      join(consumer, "consumer.ts"),
      `
import { z } from "zod/v4";
import { type AgentManifest, agentManifestSchema, defineAgent, defineStep, terminate } from "@sapiom/agent";

const greet = defineStep({
  name: "greet",
  terminal: true,
  inputSchema: z.object({ name: z.string() }),
  run: async (input: { name: string }) => terminate({ greeting: input.name }),
});
export const agent = defineAgent({ name: "consumer", entry: "greet", steps: { greet } });
export const parseManifest = (value: unknown): AgentManifest => agentManifestSchema.parse(value);
`,
    );
    await writeFile(
      join(consumer, "consumer.mjs"),
      `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { z } from "zod/v4";
import * as esm from "@sapiom/agent";

const require = createRequire(import.meta.url);
assert.equal(require("zod/package.json").version, ${JSON.stringify(zod)});
for (const { buildManifest, defineAgent, defineStep, terminate, agentManifestSchema } of [esm, require("@sapiom/agent")]) {
  const greet = defineStep({
    name: "greet",
    terminal: true,
    inputSchema: z.object({ name: z.string() }),
    run: async (input) => terminate({ greeting: input.name }),
  });
  const agent = defineAgent({ name: "consumer", entry: "greet", steps: { greet } });
  const manifest = agentManifestSchema.parse(
    buildManifest(agent, { sdkVersion: "0.0.0", artifact: { sha256: "0".repeat(64), entryFile: "index.js" } }),
  );
  assert.deepEqual(manifest.steps.greet.transitions, [{ kind: "terminate" }]);
  assert.deepEqual(manifest.steps.greet.inputSchema.required, ["name"]);
}
`,
    );
    run(
      pnpm,
      [
        "install",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-frozen-lockfile",
      ],
      consumer,
    );
    run(join(consumer, "node_modules/typescript/bin/tsc"), [], consumer);
    run(join(consumer, "consumer.mjs"), [], consumer);
    console.log(
      `@sapiom/agent declarations and both entry points pass on zod ${zod}.`,
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
