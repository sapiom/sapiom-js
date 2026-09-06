import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { DEFAULT_SYSTEM_PROMPT, resolveKnownSystemPrompt } from "./default.js";

const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

/**
 * Snapshot of the bundled prompt's sha-256. The Sapiom backend pins the same value for
 * the copy it serves, so the two move together — see the drift-guard test below.
 */
const PINNED_PROMPT_DIGEST =
  "e9453ef4262205c54a6d1d4833cdaa963259ef7bd9e035167ca0cf93a1b502b6";

const legacy = readFileSync(new URL("./fixtures/legacy-system-prompt.md", import.meta.url), "utf8").trim();

describe("DEFAULT_SYSTEM_PROMPT", () => {
  it("stays byte-identical to the copy the backend serves (cross-repo pin, SAP-2810)", () => {
    // This prompt is served from GET /v1/harness/system-prompt and duplicated here
    // verbatim as the offline fallback — the path taken when the session-start fetch
    // fails, which is the one case with no other source of truth. The two must stay
    // byte-identical, and a doc comment alone has not been enough to hold a pair of
    // copies like this in step before (SAP-2959).
    //
    // Be precise about what this asserts: it is a SNAPSHOT of the local prompt, not a
    // reading of what the backend serves. Editing the prompt reddens this line, and
    // greening it means moving the digest — at which point the author is looking
    // straight at the fact that the backend's pin has to move to the same value, in the
    // same pair of PRs. What it cannot do is verify the other repository; what it
    // removes is the silent path.
    expect(sha256(DEFAULT_SYSTEM_PROMPT)).toBe(PINNED_PROMPT_DIGEST);
  });

  it("keeps the Studio orientation the prompt exists to deliver", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Agent Studio");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("sapiom-dev");
    expect(DEFAULT_SYSTEM_PROMPT).toContain(".sapiom/harness-context.json");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Local Run, Prod Run, and Deploy");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("sapiom_send_feedback");
  });

  it("orients to the project map without delaying a clear first request", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("agent-map");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("shared project Agent Map");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("clear task");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("two Sapiom MCP servers");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("The two MCPs");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("then stop");
  });
});

describe("known served-prompt compatibility", () => {
  it("pins the one historical revision that is safe to upgrade", () => {
    expect(sha256(legacy)).toBe("f9128ff6afed47242b7bc7946b2e1dab20627171371191cdd2c45537198ce8ed");
    expect(resolveKnownSystemPrompt(`\n${legacy}\n`)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("never replaces unknown, custom, or newer remote guidance", () => {
    for (const prompt of ["custom profile", DEFAULT_SYSTEM_PROMPT,
      `${legacy}\nNew runtime instructions from the backend.`]) {
      expect(resolveKnownSystemPrompt(prompt)).toBe(prompt);
    }
  });

  it("preserves the legacy runtime, feedback, and workspace guidance verbatim", () => {
    for (const [start, end] of [
      ["**Calling LLMs", "**The authoring loop"],
      ["**Your current workspace state", "**In your very first reply"],
    ]) {
      const block = legacy.slice(legacy.indexOf(start), legacy.indexOf(end)).trim();
      expect(block.length).toBeGreaterThan(100);
      expect(DEFAULT_SYSTEM_PROMPT).toContain(block);
    }
  });
});
