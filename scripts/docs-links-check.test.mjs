import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractDocsLinks,
  validateDocsLinkContent,
  validateRepository,
  validateSupportedMcpSetupContent,
} from "./docs-links-check.mjs";

test("accepts canonical docs routes with fragments and punctuation", () => {
  const source = [
    "See https://docs.sapiom.ai/agents/authoring.",
    "Then https://docs.sapiom.ai/capabilities/compute#sandbox-previews.",
  ].join("\n");

  assert.deepEqual(validateDocsLinkContent("README.md", source), []);
  assert.deepEqual(extractDocsLinks(source), [
    "https://docs.sapiom.ai/agents/authoring",
    "https://docs.sapiom.ai/capabilities/compute#sandbox-previews",
  ]);
});

test("rejects a redirecting or nonexistent route at the emitting file", () => {
  assert.deepEqual(
    validateDocsLinkContent(
      "packages/example.ts",
      "Visit https://docs.sapiom.ai/integration/mcp-servers/setup",
    ),
    [
      "packages/example.ts:1 emits noncanonical docs route /integration/mcp-servers/setup",
    ],
  );
});

test("validates mixed-case, protocol-less, malformed, and repeated references", () => {
  const source = [
    "Docs.sapiom.ai/introduction",
    "https://DOCS.sapiom.aim/",
    "https://docs.sapiom.ai/introduction",
  ].join("\n");

  assert.deepEqual(validateDocsLinkContent("README.md", source), [
    "README.md:1 emits noncanonical docs route /introduction",
    "README.md:2 emits malformed docs origin https://docs.sapiom.aim",
    "README.md:3 emits noncanonical docs route /introduction",
  ]);
});

test("rejects client aliases that collapse the two MCP surfaces", () => {
  assert.deepEqual(
    validateSupportedMcpSetupContent(
      "README.md",
      [
        "claude mcp add sapiom-dev -- npx -y @sapiom/mcp",
        "claude mcp add sapiom --transport http https://api.sapiom.ai/v1/mcp",
      ].join("\n"),
    ),
    [
      "README.md:1 registers local @sapiom/mcp without the supported sapiom-project client alias",
      "README.md:2 registers Sapiom Cloud MCP without the supported sapiom-cloud client alias",
    ],
  );
  assert.deepEqual(
    validateSupportedMcpSetupContent(
      "plugin.mcp.json",
      '{"mcpServers":{"sapiom-dev":{"command":"npx"}}}',
    ),
    [
      "plugin.mcp.json uses sapiom-dev as a client configuration key instead of the server's wire identity",
    ],
  );
});

test("accepts the distinct supported local and hosted aliases", () => {
  const source = [
    "claude mcp add sapiom-project -- npx -y @sapiom/mcp",
    "codex mcp add sapiom-project -- npx -y @sapiom/mcp",
    'claude mcp add --scope user --transport http sapiom-cloud https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"',
    "codex mcp add sapiom-cloud --url https://api.sapiom.ai/v1/mcp --bearer-token-env-var SAPIOM_API_KEY",
  ].join("\n");

  assert.deepEqual(validateSupportedMcpSetupContent("README.md", source), []);
  assert.deepEqual(
    validateSupportedMcpSetupContent(
      "adapter.ts",
      "`claude mcp add ${PROJECT_MCP_ALIAS} -- npx -y @sapiom/mcp`",
    ),
    [],
  );
});

test("walks the whole product repository and skips only declared fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "sapiom-js-doc-links-"));
  try {
    mkdirSync(join(root, "packages/example"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "README.md"),
      [
        "https://docs.sapiom.ai/agent-studio/account-and-privacy",
        "https://docs.sapiom.ai/agent-studio/install",
        "https://docs.sapiom.ai/agent-studio/overview",
        "https://docs.sapiom.ai/agents/authoring",
        "https://docs.sapiom.ai/agents/quick-start",
        "https://docs.sapiom.ai/guides/connect-claude-code-with-mcp",
        "https://docs.sapiom.ai/reference/agent-studio",
        "claude mcp add sapiom-project -- npx -y @sapiom/mcp",
        "codex mcp add sapiom-project -- npx -y @sapiom/mcp",
        'claude mcp add --scope user --transport http sapiom-cloud https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"',
        "codex mcp add sapiom-cloud --url https://api.sapiom.ai/v1/mcp --bearer-token-env-var SAPIOM_API_KEY",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "packages/example/emitter.ts"),
      "Docs.sapiom.ai/introduction",
    );
    writeFileSync(
      join(root, "scripts/docs-links-check.test.mjs"),
      "Docs.sapiom.ai/how-it-works",
    );
    writeFileSync(
      join(root, "packages/example/negative.test.ts"),
      "claude mcp add sapiom-dev -- npx -y @sapiom/mcp",
    );

    assert.throws(
      () => validateRepository(root),
      /packages\/example\/emitter\.ts:1/,
    );

    writeFileSync(
      join(root, "packages/example/emitter.ts"),
      "Docs.sapiom.ai/guides/build",
    );
    assert.deepEqual(validateRepository(root), { files: 3, links: 8 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
