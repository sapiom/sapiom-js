import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "./default.js";

const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

/**
 * The digest the Sapiom backend pins for `DEFAULT_HARNESS_SYSTEM_PROMPT`
 * (Sapiom repo, backend/src/harness/harness-system-prompt.spec.ts). Must equal the
 * sha-256 of the CURRENT bundled prompt — see the drift-guard test below.
 */
const BACKEND_CONSTANT_DIGEST =
  "f9128ff6afed47242b7bc7946b2e1dab20627171371191cdd2c45537198ce8ed";

describe("DEFAULT_SYSTEM_PROMPT", () => {
  it("matches the digest the backend pins for its served copy (cross-repo, SAP-2810)", () => {
    // This prompt is served from GET /v1/harness/system-prompt and duplicated here
    // verbatim as the offline fallback — the path taken when the session-start fetch
    // fails, which is the one case with no other source of truth. The two must stay
    // byte-identical, and a doc comment alone does not hold that: the `@sapiom/mcp`
    // instructions drifted from 2.6 to 2.8 across two releases with every spec green
    // (SAP-2959), so a session that fell back offline was taught things that were no
    // longer true.
    //
    // Editing the prompt reddens this line, and greening it means moving the digest —
    // at which point the author is looking straight at the fact that the backend
    // constant and its own pin have to move to the same value, in the same pair of PRs.
    // What this cannot do is block a merge in the other repository; what it removes is
    // the silent path.
    expect(sha256(DEFAULT_SYSTEM_PROMPT)).toBe(BACKEND_CONSTANT_DIGEST);
  });

  it("keeps the Studio orientation the prompt exists to deliver", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Agent Studio");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("sapiom-dev");
    expect(DEFAULT_SYSTEM_PROMPT).toContain(".sapiom/harness-context.json");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Local Run, Prod Run, and Deploy");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("sapiom_send_feedback");
  });
});
