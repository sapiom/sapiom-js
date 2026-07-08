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
