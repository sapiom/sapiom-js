/**
 * generateSkillsPlugin — unit tests.
 *
 * The function resolves @sapiom/agent-core's skills/ directory and writes a
 * per-session plugin layout for claude-code's --plugin-dir. These tests use
 * a fixture skill dir (not a real require.resolve) to stay hermetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
// When false, the mock's require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED
// for the "@sapiom/agent-core/package.json" subpath — simulating an agent-core
// whose `exports` map doesn't expose ./package.json (the real bug that made
// the skill silently never load). Strategy-2 (main-entry walk-up) must cover it.
let exposePackageJson = true;

// We intercept the createRequire call inside skills-plugin.ts to point at a
// fixture agent-core package rather than the real one. The module is mocked at
// the module level; the returned require + its `.resolve` are only CALLED
// lazily (inside a test, after beforeEach sets tmpDir/exposePackageJson), so
// the closure captures live values.
//
// Two specifiers are honoured, matching resolveAgentCoreSkillsDir's two
// strategies:
//   - "@sapiom/agent-core/package.json" → fixture package.json (strategy 1),
//     unless exposePackageJson is false, in which case it throws like a real
//     exports-restricted package.
//   - "@sapiom/agent-core"              → fixture main entry (strategy 2), from
//     which the resolver walks up to the package root.
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: () => {
      const resolve = (specifier: string): string => {
        if (specifier === "@sapiom/agent-core/package.json") {
          if (!exposePackageJson) {
            const err = new Error(
              `Package subpath './package.json' is not defined by "exports"`,
            );
            (err as NodeJS.ErrnoException).code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
            throw err;
          }
          return path.join(tmpDir, "agent-core", "package.json");
        }
        if (specifier === "@sapiom/agent-core") {
          return path.join(tmpDir, "agent-core", "dist", "esm", "index.js");
        }
        throw new Error(`Unexpected require.resolve: ${specifier}`);
      };
      const mockRequire = (specifier: string): string => resolve(specifier);
      mockRequire.resolve = resolve;
      return mockRequire;
    },
  };
});

// Import AFTER the mock is registered.
import { generateSkillsPlugin } from "./skills-plugin.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a minimal fake @sapiom/agent-core package with one skill. */
async function seedAgentCoreFixture(dir: string): Promise<void> {
  // package.json
  await fs.mkdir(path.join(dir, "agent-core"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "agent-core", "package.json"),
    JSON.stringify({ name: "@sapiom/agent-core", version: "0.0.0-test" }),
  );
  // skills/sapiom-agent-authoring/SKILL.md
  const skillDir = path.join(dir, "agent-core", "skills", "sapiom-agent-authoring");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "# Agent Authoring\n\nA test SKILL.md fixture.",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateSkillsPlugin", () => {
  beforeEach(async () => {
    exposePackageJson = true;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-skills-plugin-"));
    await seedAgentCoreFixture(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes plugin.json and copies the SKILL.md into the plugin layout", async () => {
    const generatedRoot = path.join(tmpDir, "generated");
    const pluginDir = await generateSkillsPlugin("sess-abc", { generatedRoot });

    expect(pluginDir).toBeDefined();
    expect(pluginDir).toBe(path.join(generatedRoot, "sess-abc", "skills-plugin"));

    // plugin.json must exist with the expected name field.
    const pluginJson = JSON.parse(
      await fs.readFile(path.join(pluginDir!, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(pluginJson).toEqual({ name: "sapiom" });

    // The sapiom-agent-authoring SKILL.md must be copied in.
    const copiedMd = await fs.readFile(
      path.join(pluginDir!, "skills", "sapiom-agent-authoring", "SKILL.md"),
      "utf8",
    );
    expect(copiedMd).toContain("Agent Authoring");
  });

  it("resolves skills via the main-entry fallback when ./package.json is not exported", async () => {
    // Regression guard: agent-core's exports map historically didn't expose
    // ./package.json, so require.resolve("@sapiom/agent-core/package.json")
    // threw ERR_PACKAGE_PATH_NOT_EXPORTED and the skill silently never loaded.
    // Strategy 2 (resolve the main entry, walk up to the package root) must
    // still find skills/ without the direct package.json subpath.
    exposePackageJson = false;

    const generatedRoot = path.join(tmpDir, "generated");
    const pluginDir = await generateSkillsPlugin("sess-no-exports", { generatedRoot });

    expect(pluginDir).toBeDefined();
    const copiedMd = await fs.readFile(
      path.join(pluginDir!, "skills", "sapiom-agent-authoring", "SKILL.md"),
      "utf8",
    );
    expect(copiedMd).toContain("Agent Authoring");
  });

  it("isolates sessions into separate directories", async () => {
    const generatedRoot = path.join(tmpDir, "generated");
    const dirA = await generateSkillsPlugin("sess-a", { generatedRoot });
    const dirB = await generateSkillsPlugin("sess-b", { generatedRoot });

    expect(dirA).not.toBe(dirB);
    expect(dirA).toContain("sess-a");
    expect(dirB).toContain("sess-b");
  });

  it("returns undefined gracefully when the agent-core skills directory is absent", async () => {
    // Remove the skills dir to simulate agent-core published without skills/.
    await fs.rm(path.join(tmpDir, "agent-core", "skills"), { recursive: true, force: true });

    const generatedRoot = path.join(tmpDir, "generated");
    const result = await generateSkillsPlugin("sess-no-skills", { generatedRoot });
    expect(result).toBeUndefined();
  });

  it("returns undefined and does not throw when a skill dir has no SKILL.md", async () => {
    // Remove the SKILL.md from the fixture skill — the directory exists but is empty.
    await fs.rm(
      path.join(tmpDir, "agent-core", "skills", "sapiom-agent-authoring", "SKILL.md"),
      { force: true },
    );

    const generatedRoot = path.join(tmpDir, "generated");
    // No error, returns undefined because nothing was copied.
    const result = await generateSkillsPlugin("sess-empty-skill", { generatedRoot });
    expect(result).toBeUndefined();
  });
});
