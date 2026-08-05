import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentDepsInstalled, agentDepsInstalledSync } from "./agent-deps.js";

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Simulate a package landing in `<root>/node_modules/<pkg>` — with the
 *  package.json esbuild reads, not just an empty directory. */
async function installPkg(root: string, pkg: string): Promise<void> {
  const dir = path.join(root, "node_modules", pkg);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: pkg }));
}

/** Write a project package.json declaring the given runtime dependencies. */
async function writeManifest(projectDir: string, deps: string[]): Promise<void> {
  await fs.writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "agent", dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) }),
  );
}

describe("agentDepsInstalled", () => {
  it("is false for a fresh project with no SDK anywhere up the tree", async () => {
    const project = await tmp("agent-deps-none-");
    expect(await agentDepsInstalled(project)).toBe(false);
    expect(agentDepsInstalledSync(project)).toBe(false);
  });

  it("is true once the SDK is installed (no package.json → SDK fallback)", async () => {
    const project = await tmp("agent-deps-own-");
    await installPkg(project, "@sapiom/agent");
    expect(await agentDepsInstalled(project)).toBe(true);
    expect(agentDepsInstalledSync(project)).toBe(true);
  });

  it("resolves deps hoisted to an ANCESTOR node_modules (monorepo / repo fixtures)", async () => {
    const root = await tmp("agent-deps-hoist-");
    await installPkg(root, "@sapiom/agent");
    const nested = path.join(root, "packages", "app", "agents", "leads");
    await fs.mkdir(nested, { recursive: true });
    expect(await agentDepsInstalled(nested)).toBe(true);
    expect(agentDepsInstalledSync(nested)).toBe(true);
  });

  it("requires ALL declared deps — a partial install (SDK present, zod missing) is NOT ready", async () => {
    const project = await tmp("agent-deps-partial-");
    await writeManifest(project, ["@sapiom/agent", "@sapiom/tools", "zod"]);

    // npm has written the SDK but not zod yet — the bundle would still fail on
    // "Could not resolve zod/v4", so this must read as not-ready.
    await installPkg(project, "@sapiom/agent");
    await installPkg(project, "@sapiom/tools");
    expect(await agentDepsInstalled(project)).toBe(false);
    expect(agentDepsInstalledSync(project)).toBe(false);

    // zod lands — now the full dependency set resolves.
    await installPkg(project, "zod");
    expect(await agentDepsInstalled(project)).toBe(true);
    expect(agentDepsInstalledSync(project)).toBe(true);
  });

  it("ignores devDependencies — they don't affect the type-stripped bundle", async () => {
    const project = await tmp("agent-deps-devonly-");
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "agent",
        dependencies: { "@sapiom/agent": "1.0.0" },
        devDependencies: { typescript: "^5.4.2", prettier: "^3.2.5" },
      }),
    );
    await installPkg(project, "@sapiom/agent"); // devDeps intentionally NOT installed
    expect(await agentDepsInstalled(project)).toBe(true);
  });
});
