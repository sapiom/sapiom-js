import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "./default.js";

const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

/**
 * Snapshot of the bundled prompt's sha-256. The Sapiom backend pins the same value for
 * the copy it serves, so the two move together — see the drift-guard test below.
 */
const PINNED_PROMPT_DIGEST =
  "ad6683561332324585cf474636859fa78cdc4a96677a09d5f9ae2772572da4b9";

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

  it("teaches Vault semantics, agents.launch, receipts/replay, and App Link webhooks (SAP-3180)", () => {
    // The digest above only proves the two copies match; it cannot tell a sync that keeps
    // this paragraph from one that drops it. These are the load-bearing facts, so a future
    // "re-pin the digest" sync that loses them fails here by name.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("ctx.sapiom.vault.get");
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      "agent code cannot write the Vault",
    );
    expect(DEFAULT_SYSTEM_PROMPT).toContain("ctx.sapiom.agents.launch");
    // Routes are named without their REST prefix: this prompt is Agent Studio visible
    // text and subject to scripts/agent-studio-terminology-check.mjs.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("GET …/receipts");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("/replay");
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/workflows?/i);
    expect(DEFAULT_SYSTEM_PROMPT).toContain("webhooksEnabled");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("/hook/<path>");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("byte-exact");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("60 s");
  });
});
