import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditProviderNeutralCopy,
  findProviderCopyMentions,
} from "./provider-neutral-copy-check.mjs";

describe("provider-neutral copy guard", () => {
  it("rejects underlying provider names in product and documentation prose", () => {
    const violations = findProviderCopyMentions(
      [
        "Enrich contacts with Hunter.",
        "The FAL webhook resumes the job.",
        "Only Blaxel cloud sandboxes work.",
        "Execute inside a Firecracker microVM.",
        "Fallback is usually Anthropic.",
        "Every build uses your Claude Code account.",
      ].join("\n"),
    );

    assert.deepEqual(
      violations.map(({ token }) => token),
      [
        "Hunter",
        "FAL",
        "Blaxel",
        "Firecracker",
        "usually Anthropic",
        "Claude Code account",
      ],
    );
  });

  it("allows required raw model and execution-environment contracts", () => {
    const violations = findProviderCopyMentions(`
      const videoModel = "fal-ai/kling-video/v2.1/pro/image-to-video";
      const environment = "blaxel_sandbox";
      if (type === EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX) return;
      COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
    `);

    assert.deepEqual(violations, []);
  });

  it("keeps audited repository copy provider-neutral", async () => {
    const result = await auditProviderNeutralCopy();

    assert.ok(result.files.length > 20);
    assert.deepEqual(result.violations, []);
  });
});
