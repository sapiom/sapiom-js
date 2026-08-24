import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AUTHORING_INSTRUCTIONS } from "./instructions.js";

describe("server instructions", () => {
  it("are delivered to a client over the initialize handshake", async () => {
    const server = new McpServer(
      { name: "sapiom-dev", version: "0.1.0" },
      { instructions: AUTHORING_INSTRUCTIONS },
    );
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // This is the channel a capable client injects into the agent's context.
    expect(client.getInstructions()).toBe(AUTHORING_INSTRUCTIONS);
  });

  it("primer covers the lifecycle, canonical rules, and points to the docs", () => {
    // Lifecycle tools an agent must drive
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_authenticate");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_agents_scaffold");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_agents_clone");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_agents_run_local");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_sandbox_preview");
    // Canonical naming (and the stale names it must steer away from)
    expect(AUTHORING_INSTRUCTIONS).toContain("@sapiom/agent");
    expect(AUTHORING_INSTRUCTIONS).toContain("defineAgent");
    // the old package names are gone entirely — new users never see them
    expect(AUTHORING_INSTRUCTIONS).not.toContain("defineOrchestration");
    expect(AUTHORING_INSTRUCTIONS).not.toContain("@sapiom/orchestration");
    // Pointer to the full docs + the scaffold-shipped guidance (AGENTS.md + skill)
    expect(AUTHORING_INSTRUCTIONS).toContain("https://docs.sapiom.ai/agents");
    expect(AUTHORING_INSTRUCTIONS).toContain("AGENTS.md");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom-agent-authoring");
    // The two-MCP frame: agents learn the remote MCP exists for direct tool calls
    expect(AUTHORING_INSTRUCTIONS).toContain("remote MCP");
    expect(AUTHORING_INSTRUCTIONS).toContain("api.sapiom.ai/v1/mcp");
    expect(AUTHORING_INSTRUCTIONS).toContain("tool_discover");
  });

  it("names the entry step's inputSchema as the agent's public API (SAP-2227)", () => {
    // The primer is the only always-in-context surface, so authors learn the entry
    // contract here. Kept byte-identical to the backend DEFAULT_MCP_INSTRUCTIONS copy.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "entry step's `inputSchema` is the agent's public API",
    );
  });

  it("teaches the LLM call-surface rule (SAP-2775) — kept byte-identical to the backend copy", () => {
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.llm.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.models.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("models.coding.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.agents.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("You never pick a model");
    // The internal `workflows`-service naming must never reach this customer-facing
    // primer — the per-step debugging endpoint lives in the docs guide, not spelled
    // out here verbatim (matches this package's own scaffold terminology guard).
    expect(AUTHORING_INSTRUCTIONS).toContain("Run Inspector");
    expect(AUTHORING_INSTRUCTIONS).not.toContain("/v1/workflows/");
    // Structured/forced-tool output has no `text` block — the reply lives in the
    // `tool_use` block's `input`. Reading only `type === 'text'` there returns
    // `undefined` and invites exactly the string-parsing fallback this rule bans.
    expect(AUTHORING_INSTRUCTIONS).toContain("tool_use");
    // `output` is sugar for a forced tool call — one mechanism, one payload location.
    expect(AUTHORING_INSTRUCTIONS).toContain("it forces a tool");
    // The disclosure claim stays scoped: coding runs report honest nulls, and older
    // servers omit the fields entirely — never a flat "always on the result" promise.
    expect(AUTHORING_INSTRUCTIONS).toContain("treat missing as unknown");
    expect(AUTHORING_INSTRUCTIONS).toContain("reports both as `null` today");
    // "Pin the `smart` label" was a no-op (smart IS the default) and wrong-field on
    // the sessions surface — it must not come back.
    expect(AUTHORING_INSTRUCTIONS).not.toContain("If you must pin");
  });

  it("documents the complete ctx.shared quota contract", () => {
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "inclusive 256 KiB (262,144-byte) quota",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("measured as compact");
    expect(AUTHORING_INSTRUCTIONS).toContain("`JSON.stringify` UTF-8 bytes");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "IDs/references here instead of bulk state",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "`ctx.shared.set()` validates the complete candidate synchronously",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "construct this SDK version's `InMemoryContextStore`",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "snapshot unchanged after an oversized or unserializable write",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("structural payload guards");
    expect(AUTHORING_INSTRUCTIONS).toContain("than `instanceof`");
    expect(AUTHORING_INSTRUCTIONS).toContain("Hosts that have not adopted");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "There is no `delete()` operation",
    );
  });
});
