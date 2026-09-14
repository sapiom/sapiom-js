/**
 * Stamp agreement guard (SAP-3181). Every npm-shipped file that summarizes or
 * points at the served platform rules records which release it was written
 * against. Those records have to move together — a file left on an old stamp
 * would make `sapiom_dev_agents_check` warn about a copy that was in fact
 * re-read, or stay silent about one that was not — so this holds all of them
 * to the constants in src/authoring-rules.ts, which the backend's own digest
 * pin holds to the served body. `scripts/authoring-rules-stamp.mjs` is how
 * they move.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  AUTHORING_RULES_DIGEST,
  AUTHORING_RULES_RELEASE,
  AUTHORING_RULES_SECTIONS,
  AUTHORING_RULES_URL,
  authoringRulesDriftWarning,
  parseAuthoringRulesStamp,
  renderAuthoringRulesStamp,
} from "../authoring-rules";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const CANONICAL_SKILL = path.join(
  PKG_ROOT,
  "skills",
  "sapiom-agent-authoring",
  "SKILL.md",
);

/** Markdown files carrying the HTML-comment stamp. */
function stampedMarkdownFiles(): string[] {
  const files = [
    CANONICAL_SKILL,
    path.join(PKG_ROOT, "templates", "default", "AGENTS.md"),
    path.join(PKG_ROOT, "templates", "coding-pause", "AGENTS.md"),
    path.join(REPO_ROOT, "examples", "AUTHORING.md"),
  ];
  // The CLI's separately published template — may not exist on every branch.
  const cliAgentsMd = path.join(
    REPO_ROOT,
    "packages",
    "cli",
    "templates",
    "default",
    "AGENTS.md",
  );
  if (existsSync(cliAgentsMd)) files.push(cliAgentsMd);
  const examples = path.join(REPO_ROOT, "examples");
  for (const entry of readdirSync(examples, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentsMd = path.join(examples, entry.name, "AGENTS.md");
    if (existsSync(agentsMd)) files.push(agentsMd);
  }
  return files;
}

/** `.ts` files carrying the JSDoc form, `(written against release X)`. */
const JSDOC_FILES = [
  path.join(REPO_ROOT, "packages", "tools", "src", "llm", "index.ts"),
  path.join(REPO_ROOT, "packages", "tools", "src", "models", "index.ts"),
];

const rel = (file: string) => path.relative(REPO_ROOT, file);

describe("authoring-rules stamp", () => {
  it("renders and parses round-trip", () => {
    const stamp = { release: "2.3", digest: "0123456789ab" };
    expect(parseAuthoringRulesStamp(renderAuthoringRulesStamp(stamp))).toEqual(
      stamp,
    );
    expect(parseAuthoringRulesStamp("# no stamp here\n")).toBeNull();
  });

  it("the shipped stamp is a well-formed release id and 12-hex digest", () => {
    expect(AUTHORING_RULES_RELEASE).toMatch(/^\d+\.\d+$/);
    expect(AUTHORING_RULES_DIGEST).toMatch(/^[0-9a-f]{12}$/);
  });

  const markdownFiles = stampedMarkdownFiles();

  it("guards the skill, the templates, AUTHORING.md and every example", () => {
    // 3 templates + skill + AUTHORING.md + the gallery. A missing example is a
    // gallery change, not a stamp change, but a count this low means the walk broke.
    expect(markdownFiles.length).toBeGreaterThan(20);
  });

  for (const file of markdownFiles) {
    it(`${rel(file)} carries the current stamp`, () => {
      const markdown = readFileSync(file, "utf8");
      expect(parseAuthoringRulesStamp(markdown)).toEqual({
        release: AUTHORING_RULES_RELEASE,
        digest: AUTHORING_RULES_DIGEST,
      });
      // The prose beside the stamp names the same release, so a reader and the
      // machine see one number.
      expect(markdown).toContain(
        `written against release ${AUTHORING_RULES_RELEASE}`,
      );
      expect(markdown).not.toMatch(
        new RegExp(
          `written against release (?!${AUTHORING_RULES_RELEASE.replace(".", "\\.")}\\b)\\d+\\.\\d+`,
        ),
      );
    });
  }

  for (const file of JSDOC_FILES) {
    it(`${rel(file)} JSDoc pointers name the current release`, () => {
      const source = readFileSync(file, "utf8");
      const releases = [
        ...source.matchAll(
          /authoring-rules#[a-z-]+\s*(?:\*\s*)?\(written against release ([^)\s]+)\)/g,
        ),
      ].map((m) => m[1]);
      expect(releases.length).toBeGreaterThan(0);
      expect(new Set(releases)).toEqual(new Set([AUTHORING_RULES_RELEASE]));
    });
  }
});

describe("authoring-rules pointers", () => {
  const anchorsOf = (text: string): string[] =>
    [...text.matchAll(/authoring-rules#([a-z-]+)/g)].map((m) => m[1]);

  it("every section anchor a shipped file points at exists on the served body", () => {
    const known = new Set<string>(AUTHORING_RULES_SECTIONS);
    for (const file of [...stampedMarkdownFiles(), ...JSDOC_FILES]) {
      for (const anchor of anchorsOf(readFileSync(file, "utf8"))) {
        expect({
          file: rel(file),
          anchor: known.has(anchor) ? anchor : `UNKNOWN:${anchor}`,
        }).toEqual({ file: rel(file), anchor });
      }
    }
  });

  it("the skill brackets each platform chapter with matching section markers", () => {
    const skill = readFileSync(CANONICAL_SKILL, "utf8");
    const opens = [...skill.matchAll(/<!-- section: ([a-z-]+) -->/g)].map(
      (m) => m[1],
    );
    const closes = [...skill.matchAll(/<!-- \/section: ([a-z-]+) -->/g)].map(
      (m) => m[1],
    );
    expect(opens.length).toBeGreaterThan(0);
    expect(closes).toEqual(opens);
    expect(new Set(opens).size).toBe(opens.length);
    for (const name of opens) {
      expect(AUTHORING_RULES_SECTIONS).toContain(name);
    }
    // Every bracketed chapter points at the section it summarizes.
    for (const name of opens) {
      const body = skill
        .split(`<!-- section: ${name} -->`)[1]
        .split(`<!-- /section: ${name} -->`)[0];
      expect(body).toContain(`${AUTHORING_RULES_URL}#${name}`);
    }
  });

  it("the skill no longer restates the rules it points at", () => {
    const skill = readFileSync(CANONICAL_SKILL, "utf8");
    // The worked LLM example, the vocabulary table and the trigger table were
    // the restatements; each is one pointer now.
    expect(skill).not.toContain("| `ctx.sapiom.llm.run`    |");
    expect(skill).not.toContain("| **agent**    |");
    expect(skill).not.toContain("| `schedule_cron` |");
    expect(skill).not.toContain("X-Sapiom-Signature");
  });
});

describe("authoringRulesDriftWarning", () => {
  const local = { release: "1.0", digest: "1f3e5cd9648f" };

  it("is null when the digests agree, whatever the release ids say", () => {
    expect(
      authoringRulesDriftWarning("AGENTS.md", local, {
        release: "1.1",
        digest: local.digest,
      }),
    ).toBeNull();
  });

  it("says 'differs', names both stamps and the URL, and never ranks them", () => {
    const warning = authoringRulesDriftWarning("AGENTS.md", local, {
      release: "1.1",
      digest: "abcdefabcdef",
    });
    expect(warning).toContain("AGENTS.md");
    expect(warning).toContain("release 1.0 (digest 1f3e5cd9648f)");
    expect(warning).toContain("differs");
    expect(warning).toContain("release 1.1, digest abcdefabcdef");
    expect(warning).toContain(AUTHORING_RULES_URL);
    expect(warning).not.toMatch(/older|newer|outdated|behind/i);
  });
});
