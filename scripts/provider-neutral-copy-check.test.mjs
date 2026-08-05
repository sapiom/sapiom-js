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
        "Every build uses your Claude Code account.",
      ].join("\n"),
    );

    assert.deepEqual(
      violations.map(({ token }) => token),
      ["Hunter", "FAL", "Blaxel", "Firecracker", "Claude Code account"],
    );
  });

  it("rejects provider-disclosing LLM fallback paraphrases", () => {
    const violations = findProviderCopyMentions(
      [
        "Fallback may use Anthropic.",
        "Anthropic normally serves spillover requests.",
        "OpenAI may serve overflow capacity.",
        'Fallback provider is "anthropic".',
        'Overflow is served by "openai".',
        "anthropic: normally serves spillover requests.",
        "openai: serves overflow capacity.",
      ].join("\n"),
      "packages/tools/src/llm/index.ts",
    );

    assert.deepEqual(
      violations.map(({ token }) => token),
      [
        "Anthropic",
        "Anthropic",
        "OpenAI",
        "anthropic",
        "openai",
        "anthropic",
        "openai",
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

  it("allows intentional LLM wire-shape identifiers", () => {
    const violations = findProviderCopyMentions(
      `
        POST /v2/anthropic/v1/messages
        The verbatim LLM request uses the Anthropic messages shape.
        This client speaks Anthropic Messages.
        The default Anthropic shape uses the anthropic/v1/messages route.
        The alternate wire shape is OpenAI Chat Completions.
        Pass \`shape: "openai"\` to select Chat Completions.
        const urls: { anthropic: string; openai: string };
        const shape: { shape?: "anthropic" | "openai" } = {};
        if (opts.shape === "openai") return;
        const suffix = "openai/v1/chat/completions";
      `,
      "packages/tools/src/llm/index.ts",
    );

    assert.deepEqual(violations, []);
  });

  it("allows explicit user-selected provider credentials", () => {
    const violations = findProviderCopyMentions(`
      { "requiredSecrets": [{ "provider": "anthropic", "key": "ANTHROPIC_API_KEY" }] }
      Connect your Anthropic API key to use that integration.
    `);

    assert.deepEqual(violations, []);
  });

  it("keeps audited repository copy provider-neutral", async () => {
    const result = await auditProviderNeutralCopy();

    assert.ok(result.files.length > 50);
    assert.ok(
      result.files.includes("examples/scheduled-db-insight-report/index.ts"),
    );
    assert.ok(result.files.includes("examples/proposal-generator/AGENTS.md"));
    assert.deepEqual(result.violations, []);
  });
});
