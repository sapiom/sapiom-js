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
import {
  AUTHORING_RULES_FETCH_DISABLED_ENV,
  generateSkillsPlugin,
  inlineServedAuthoringRules,
  markBundledAuthoringRules,
} from "./skills-plugin.js";

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

// ---------------------------------------------------------------------------
// Served platform rules (SAP-3225)
// ---------------------------------------------------------------------------

/** A bundled skill shaped like the shipped one: intro, stamp, summary chapters. */
const BUNDLED_SKILL = [
  "---",
  "name: sapiom-agent-authoring",
  "description: test",
  "---",
  "",
  "# Building Sapiom Agents",
  "",
  "Opening paragraph.",
  "",
  "**Two kinds of content live here, and they update differently.** Platform rules are",
  "only summarized here.",
  "",
  "<!-- sapiom-authoring-rules release=1.1 digest=8ed17f08af11 -->",
  "",
  "<!-- section: one-off-vs-agent -->",
  "",
  "## One-off summary",
  "",
  "Bundled summary of one-off vs agent.",
  "",
  "<!-- /section: one-off-vs-agent -->",
  "",
  "## Lifecycle from Zero",
  "",
  "Scaffold, then run.",
  "",
  "<!-- section: trigger-kinds -->",
  "",
  "## Triggers summary",
  "",
  "<!-- /section: trigger-kinds -->",
  "",
  "## Determinism",
  "",
  "Be deterministic.",
  "",
].join("\n");

const SERVED_BODY = [
  "# Sapiom platform rules for agent authors",
  "",
  "<!-- section: one-off-vs-agent -->",
  "## One-off call, or an agent?",
  "",
  "Served rule text.",
].join("\n");

const SERVED_FOOTER =
  "\n\n_Sapiom teaching content · authoring-rules · release 1.2 · abcdefabcdef · served live._";

describe("inlineServedAuthoringRules", () => {
  const served = { body: SERVED_BODY, release: "1.2", digest: "abcdefabcdef" };

  it("drops the summary chapters and the stamp, keeps the mechanics, and appends the served body with a served footer", () => {
    const out = inlineServedAuthoringRules(BUNDLED_SKILL, served);

    expect(out.startsWith("---\nname: sapiom-agent-authoring\n")).toBe(true);
    expect(out).not.toContain("Bundled summary of one-off vs agent.");
    expect(out).not.toContain("## Triggers summary");
    expect(out).not.toContain("<!-- /section:");
    expect(out).not.toContain("sapiom-authoring-rules release=");
    expect(out).not.toContain("only summarized here");
    expect(out).toContain("## Lifecycle from Zero\n\nScaffold, then run.");
    expect(out).toContain("## Determinism\n\nBe deterministic.");
    expect(out).toContain("inlined in full at the end of this skill");
    expect(out.indexOf("## Determinism")).toBeLessThan(
      out.indexOf("# Sapiom platform rules for agent authors"),
    );
    expect(out.endsWith(`${SERVED_BODY}\n\n---\n\nsource: served · release 1.2 · digest abcdefabcdef\n`)).toBe(
      true,
    );
  });

  it("splices the shipped skill without leaving a summary chapter or the summaries intro behind", async () => {
    const shipped = await fs.readFile(
      new URL("../../../../agent-core/skills/sapiom-agent-authoring/SKILL.md", import.meta.url),
      "utf8",
    );
    const out = inlineServedAuthoringRules(shipped, served);

    expect(out.startsWith("---\nname: sapiom-agent-authoring\n")).toBe(true);
    expect(out).not.toMatch(/<!-- \/section: /);
    expect(out).not.toContain("only summarized here");
    expect(out).not.toContain("sapiom-authoring-rules release=");
    expect(out).toContain("## Lifecycle from Zero");
    expect(out).toContain("inlined in full at the end of this skill");
    expect(out).toContain("source: served · release 1.2 · digest abcdefabcdef");
  });
});

describe("markBundledAuthoringRules", () => {
  it("keeps the bundled copy unchanged and appends a bundled footer with its stamp", () => {
    const out = markBundledAuthoringRules(BUNDLED_SKILL);
    expect(out.startsWith(BUNDLED_SKILL.trimEnd())).toBe(true);
    expect(out.endsWith("\n\n---\n\nsource: bundled · release 1.1 · digest 8ed17f08af11\n")).toBe(
      true,
    );
  });

  it("names the release and digest unknown when the bundled copy carries no stamp", () => {
    expect(markBundledAuthoringRules("# Skill\n")).toBe(
      "# Skill\n\n---\n\nsource: bundled · release unknown · digest unknown\n",
    );
  });
});

describe("generateSkillsPlugin — served platform rules", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalFlag: string | undefined;
  let sourceSkill: string;

  beforeEach(async () => {
    exposePackageJson = true;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-skills-plugin-"));
    await seedAgentCoreFixture(tmpDir);
    sourceSkill = path.join(tmpDir, "agent-core", "skills", "sapiom-agent-authoring", "SKILL.md");
    await fs.writeFile(sourceSkill, BUNDLED_SKILL);
    originalFetch = globalThis.fetch;
    originalFlag = process.env[AUTHORING_RULES_FETCH_DISABLED_ENV];
    // src/test-setup.ts disables the fetch suite-wide; these specs exercise it.
    delete process.env[AUTHORING_RULES_FETCH_DISABLED_ENV];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env[AUTHORING_RULES_FETCH_DISABLED_ENV];
    else process.env[AUTHORING_RULES_FETCH_DISABLED_ENV] = originalFlag;
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function sessionSkill(sessionId: string): Promise<string> {
    const pluginDir = await generateSkillsPlugin(sessionId, {
      generatedRoot: path.join(tmpDir, "generated"),
      environment: "production",
    });
    expect(pluginDir).toBeDefined();
    return fs.readFile(path.join(pluginDir!, "skills", "sapiom-agent-authoring", "SKILL.md"), "utf8");
  }

  it("inlines the served body into the session copy only, with a served footer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(SERVED_BODY + SERVED_FOOTER, {
        status: 200,
        headers: {
          "x-sapiom-content-release": "1.2",
          "x-sapiom-content-digest": "abcdefabcdef",
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const skill = await sessionSkill("sess-served");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sapiom.ai/v1/agents/authoring-rules",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(skill).toContain("Served rule text.");
    expect(skill).not.toContain("Bundled summary of one-off vs agent.");
    // The serve-time footer is replaced by the session copy's own source line.
    expect(skill).not.toContain("served live._");
    expect(skill.endsWith("source: served · release 1.2 · digest abcdefabcdef\n")).toBe(true);
    // The installed package's copy is never touched.
    await expect(fs.readFile(sourceSkill, "utf8")).resolves.toBe(BUNDLED_SKILL);
  });

  it.each([
    ["a non-200", () => Promise.resolve(new Response("nope", { status: 503 }))],
    ["an empty body", () => Promise.resolve(new Response("   ", { status: 200 }))],
    ["a network error", () => Promise.reject(new Error("offline"))],
  ])("keeps the bundled copy with a bundled footer on %s", async (_label, impl) => {
    globalThis.fetch = vi.fn(impl) as unknown as typeof globalThis.fetch;

    const skill = await sessionSkill("sess-fallback");

    expect(skill).toBe(`${BUNDLED_SKILL.trimEnd()}\n\n---\n\nsource: bundled · release 1.1 · digest 8ed17f08af11\n`);
  });

  it.each(["1", "true"])(
    "makes no request and keeps the bundled copy when %s disables the fetch",
    async (value) => {
      process.env[AUTHORING_RULES_FETCH_DISABLED_ENV] = value;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const skill = await sessionSkill("sess-disabled");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(skill).toContain("source: bundled · release 1.1 · digest 8ed17f08af11");
    },
  );
});
