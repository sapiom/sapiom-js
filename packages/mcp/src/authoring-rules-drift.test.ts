import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authoringRulesDriftWarnings,
  fetchServedAuthoringRulesStamp,
  readProjectAuthoringRulesStamps,
} from "./authoring-rules-drift.js";

const env = { apiURL: "https://api.sapiom.ai" };
const STAMP = "<!-- sapiom-authoring-rules release=1.0 digest=1f3e5cd9648f -->";

function servedResponse(headers: Record<string, string>, ok = true) {
  return {
    ok,
    headers: new Headers(headers),
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sapiom-drift-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("authoring-rules drift check", () => {
  let originalFetch: typeof globalThis.fetch;
  let dir: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  describe("fetchServedAuthoringRulesStamp", () => {
    it("reads the release and digest from the stamp headers on the resolved apiURL", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        servedResponse({
          "x-sapiom-content-release": "1.1",
          "x-sapiom-content-digest": "abcdefabcdef",
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(fetchServedAuthoringRulesStamp(env)).resolves.toEqual({
        release: "1.1",
        digest: "abcdefabcdef",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.sapiom.ai/v1/agents/authoring-rules",
        expect.objectContaining({ signal: expect.anything() }),
      );
    });

    it("is null on a non-200, on missing headers, and on a network error", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          servedResponse({}, false),
        ) as unknown as typeof globalThis.fetch;
      await expect(fetchServedAuthoringRulesStamp(env)).resolves.toBeNull();

      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          servedResponse({ "x-sapiom-content-release": "1.1" }),
        ) as unknown as typeof globalThis.fetch;
      await expect(fetchServedAuthoringRulesStamp(env)).resolves.toBeNull();

      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(
          new Error("network down"),
        ) as unknown as typeof globalThis.fetch;
      await expect(fetchServedAuthoringRulesStamp(env)).resolves.toBeNull();
    });
  });

  describe("readProjectAuthoringRulesStamps", () => {
    it("finds the stamp in AGENTS.md and the scaffolded skill, and skips unstamped or absent files", async () => {
      dir = project({
        "AGENTS.md": `# Working in this agent\n\n${STAMP}\n`,
        ".claude/skills/sapiom-agent-authoring/SKILL.md":
          "---\nname: x\n---\nno stamp here",
      });
      await expect(readProjectAuthoringRulesStamps(dir)).resolves.toEqual([
        {
          file: "AGENTS.md",
          stamp: { release: "1.0", digest: "1f3e5cd9648f" },
        },
      ]);
    });
  });

  describe("authoringRulesDriftWarnings", () => {
    it("makes no request and warns nothing when the project carries no stamp", async () => {
      dir = project({ "AGENTS.md": "# hand-written, pre-stamp project\n" });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(authoringRulesDriftWarnings(dir, env)).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is silent when every stamp matches the served digest", async () => {
      dir = project({ "AGENTS.md": `${STAMP}\n` });
      globalThis.fetch = vi.fn().mockResolvedValue(
        servedResponse({
          "x-sapiom-content-release": "1.0",
          "x-sapiom-content-digest": "1f3e5cd9648f",
        }),
      ) as unknown as typeof globalThis.fetch;

      await expect(authoringRulesDriftWarnings(dir, env)).resolves.toEqual([]);
    });

    it("warns once per stamped file that differs, naming both stamps and the URL, and never says 'older'", async () => {
      dir = project({
        "AGENTS.md": `${STAMP}\n`,
        ".claude/skills/sapiom-agent-authoring/SKILL.md": `---\nname: sapiom-agent-authoring\n---\n${STAMP}\n`,
      });
      globalThis.fetch = vi.fn().mockResolvedValue(
        servedResponse({
          "x-sapiom-content-release": "1.1",
          "x-sapiom-content-digest": "abcdefabcdef",
        }),
      ) as unknown as typeof globalThis.fetch;

      const warnings = await authoringRulesDriftWarnings(dir, env);

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("AGENTS.md");
      expect(warnings[1]).toContain(
        path.join(".claude", "skills", "sapiom-agent-authoring", "SKILL.md"),
      );
      for (const warning of warnings) {
        expect(warning).toContain("release 1.0 (digest 1f3e5cd9648f)");
        expect(warning).toContain("differs");
        expect(warning).toContain("release 1.1, digest abcdefabcdef");
        expect(warning).toContain(
          "https://api.sapiom.ai/v1/agents/authoring-rules",
        );
        // Digests do not order and release ids have collided (SAP-3190): the
        // wording is "differs", never a ranking.
        expect(warning).not.toMatch(/older|newer|outdated|behind/i);
      }
    });

    it("stays silent when the server cannot be reached", async () => {
      dir = project({ "AGENTS.md": `${STAMP}\n` });
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(
          new Error("offline"),
        ) as unknown as typeof globalThis.fetch;

      await expect(authoringRulesDriftWarnings(dir, env)).resolves.toEqual([]);
    });
  });
});
