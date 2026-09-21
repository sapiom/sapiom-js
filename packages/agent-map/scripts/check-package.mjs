import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  assertStandaloneBrowserInputs,
  assertStandaloneDependencies,
} from "./package-boundaries.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
assert(
  pnpm && /pnpm(?:\.c?js)?$/.test(pnpm),
  "Run this check with pnpm test:package",
);
const consumer = await mkdtemp(join(tmpdir(), "agent-map-package-"));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, SAPIOM_TELEMETRY_DISABLED: "1" },
  });
try {
  // Execute pnpm's JS entrypoint directly: Windows cannot exec a .cmd shim.
  run(
    process.execPath,
    [pnpm, "pack", "--pack-destination", consumer],
    packageRoot,
  );
  const tarball = (await readdir(consumer)).find((name) =>
    name.endsWith(".tgz"),
  );
  assert(tarball, "pnpm pack must produce a tarball");
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@sapiom/agent-map": `file:./${tarball}` },
    }),
  );
  run(process.execPath, [pnpm, "install", "--ignore-scripts"], consumer);
  const installed = JSON.parse(
    await readFile(
      join(consumer, "node_modules/@sapiom/agent-map/package.json"),
      "utf8",
    ),
  );
  assertStandaloneDependencies(
    JSON.parse(
      execFileSync(
        process.execPath,
        [pnpm, "list", "--prod", "--depth", "Infinity", "--json"],
        { cwd: consumer, encoding: "utf8", windowsHide: true },
      ),
    ),
  );
  // Import every public browser surface with tree shaking disabled. Node-only
  // transitive imports must fail bundling rather than disappear as unused code.
  const exportPaths = Object.keys(installed.exports).map((key) => key.slice(1));
  for (const target of Object.values(installed.exports)) {
    assert(
      target.types && target.import,
      "Every export needs JS and declarations",
    );
    for (const file of [target.types, target.import])
      await access(join(consumer, "node_modules/@sapiom/agent-map", file));
  }
  const browserExports = exportPaths.filter(
    (subpath) => !subpath.startsWith("/node/"),
  );
  const bundled = await build({
    stdin: {
      contents: browserExports
        .map((subpath) => `export * from "@sapiom/agent-map${subpath}";`)
        .join("\n"),
      resolveDir: consumer,
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    treeShaking: false,
    metafile: true,
  });
  assertStandaloneBrowserInputs(Object.keys(bundled.metafile.inputs));
  await writeFile(
    join(consumer, "check.mjs"),
    `
import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentMapWorkspaceStore } from "@sapiom/agent-map/node/agent-map-workspace-store";
import { AgentMapProposalService } from "@sapiom/agent-map/node/agent-map-proposal-service";
import { StudioProjectCatalog } from "@sapiom/agent-map/node/studio-project-catalog";
import { resolveAgentMapProject } from "@sapiom/agent-map/node/project-resolution";
for (const subpath of ${JSON.stringify(exportPaths)}) await import("@sapiom/agent-map" + subpath);
const stateRoot = join(process.cwd(), "state");
const catalog = new StudioProjectCatalog(join(stateRoot, "studio-projects.json"));
const project = await catalog.create("Package smoke");
await catalog.addRootBinding(project.projectId, process.cwd());
const scope = await resolveAgentMapProject({ kind: "repository", stateRoot, cwd: process.cwd() });
assert.equal(scope.kind, "resolved");
const identity = { projectId: project.projectId, userId: "test-user", sessionId: "test-session" };
const service = new AgentMapProposalService(new AgentMapWorkspaceStore(scope.agentMapRoot));
const request = { schemaVersion: 1, proposalId: null, expectedVersion: 0, requestId: "package-smoke",
  operations: [{ kind: "add-node", draftRef: "agent", node: { kind: "agent", name: "Example",
    purpose: "Exercise packaged authoring", ownerAgent: null, contractRefs: [] } }] };
const result = await service.propose(identity, request);
const restarted = new AgentMapProposalService(new AgentMapWorkspaceStore(scope.agentMapRoot));
assert.deepEqual(await restarted.propose(identity, request), result);
const snapshot = await restarted.read(project.projectId);
assert.equal(snapshot.proposal.version, 1);
assert.equal(snapshot.proposal.history.length, 1);
assert.equal(snapshot.proposal.history[0].actor.sessionId, identity.sessionId);
console.log("Installed Agent Map authoring, restart, replay, and project resolution passed.");
`,
  );
  run(process.execPath, ["check.mjs"], consumer);
  console.log(
    "Installed browser exports bundle without Node or Studio dependencies.",
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
