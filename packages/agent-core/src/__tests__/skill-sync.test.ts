/**
 * Drift guard: the `sapiom-agent-authoring` skill has one canonical source
 * (skills/sapiom-agent-authoring/SKILL.md) and is shipped verbatim inside every
 * scaffold template's `.claude/skills/` directory. If a template copy diverges
 * from the canonical, scaffolded projects teach different rules than the
 * published guide — this test makes that impossible to merge silently.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const CANONICAL = path.join(
  PKG_ROOT,
  "skills",
  "sapiom-agent-authoring",
  "SKILL.md",
);
const TEMPLATES_DIR = path.join(PKG_ROOT, "templates");

describe("sapiom-agent-authoring skill sync", () => {
  const canonical = readFileSync(CANONICAL, "utf8");

  it("has a canonical source with the task-shape trigger frontmatter", () => {
    expect(canonical.startsWith("---\nname: sapiom-agent-authoring")).toBe(true);
    expect(canonical).toContain("description:");
  });

  const templates = readdirSync(TEMPLATES_DIR);

  it("there is at least one template to guard", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  for (const template of templates) {
    it(`template "${template}" ships an identical copy of the skill`, () => {
      const copy = path.join(
        TEMPLATES_DIR,
        template,
        ".claude",
        "skills",
        "sapiom-agent-authoring",
        "SKILL.md",
      );
      expect(readFileSync(copy, "utf8")).toBe(canonical);
    });
  }
});

// Content guards on the canonical (propagated to every copy by the identity
// tests above). Byte-identity alone cannot stop an identical WRONG copy: the
// pin no-op below already survived one correction round in this file.
describe("sapiom-agent-authoring content guards", () => {
  const canonical = readFileSync(CANONICAL, "utf8");

  it("never re-teaches the pin no-op (smart already is the default)", () => {
    expect(canonical.toLowerCase()).not.toContain("if you must pin");
  });

  it("teaches composition for multi-stage systems, with failure branching", () => {
    expect(canonical).toContain("Composing Deployed Agents");
    // agents.run resolves on any terminal status and does not throw — the
    // worked example must branch on a non-completed child.
    expect(canonical).toContain('research.status !== "completed"');
  });
});

// The scaffold templates also ship an AGENTS.md; it has no canonical source, so
// guard the load-bearing composition rule and the encoding directly (a mojibake
// em dash — bytes \u00e2\u0080\u0094 as characters — shipped here once).
describe("template AGENTS.md content", () => {
  for (const template of readdirSync(TEMPLATES_DIR)) {
    it(`template "${template}" AGENTS.md is clean UTF-8 and carries the composition rule`, () => {
      const md = readFileSync(path.join(TEMPLATES_DIR, template, "AGENTS.md"), "utf8");
      expect(md).not.toContain("\u00e2"); // mojibake telltale (â)
      expect(md).toContain("one agent per project");
      expect(md).toContain("ctx.sapiom.agents.run");
    });
  }
});

// The Claude Code plugin (repo root, plugins/sapiom — SAP-1366) carries its own
// copy of the skill. Guarded: the plugin may not exist yet on this branch.
describe("plugin skill copy (when present)", () => {
  const pluginCopy = path.resolve(
    PKG_ROOT,
    "..",
    "..",
    "plugins",
    "sapiom",
    "skills",
    "sapiom-agent-authoring",
    "SKILL.md",
  );

  it("matches the canonical if the plugin ships it", () => {
    if (!existsSync(pluginCopy)) return; // plugin PR not merged yet
    const canonical = readFileSync(CANONICAL, "utf8");
    expect(readFileSync(pluginCopy, "utf8")).toBe(canonical);
  });
});

// Second skill: sapiom-sandbox-preview — canonical + plugin copy only (NOT in the
// scaffold templates: agent projects are not web apps).
describe("sapiom-sandbox-preview skill sync", () => {
  const canonicalPreview = path.join(
    PKG_ROOT,
    "skills",
    "sapiom-sandbox-preview",
    "SKILL.md",
  );

  it("has a canonical source with the preview trigger frontmatter", () => {
    const content = readFileSync(canonicalPreview, "utf8");
    expect(content.startsWith("---\nname: sapiom-sandbox-preview")).toBe(true);
    expect(content).toContain("description:");
  });

  it("plugin copy matches the canonical (when present)", () => {
    const pluginCopy = path.resolve(
      PKG_ROOT,
      "..",
      "..",
      "plugins",
      "sapiom",
      "skills",
      "sapiom-sandbox-preview",
      "SKILL.md",
    );
    if (!existsSync(pluginCopy)) return;
    expect(readFileSync(pluginCopy, "utf8")).toBe(
      readFileSync(canonicalPreview, "utf8"),
    );
  });
});
