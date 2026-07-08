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
    // Canonical naming (and the stale name it must steer away from)
    expect(AUTHORING_INSTRUCTIONS).toContain("@sapiom/agent");
    expect(AUTHORING_INSTRUCTIONS).toContain("defineAgent");
    // the stale names appear only inside the explicit "NEVER use" warning
    expect(AUTHORING_INSTRUCTIONS).toContain("NEVER `defineWorkflow`");
    // Pointer to the full docs + the scaffold guide
    expect(AUTHORING_INSTRUCTIONS).toContain("https://docs.sapiom.ai/workflows");
    expect(AUTHORING_INSTRUCTIONS).toContain("AGENTS.md");
    // The two-MCP frame: agents learn the remote MCP exists for direct tool calls
    expect(AUTHORING_INSTRUCTIONS).toContain("remote MCP");
    expect(AUTHORING_INSTRUCTIONS).toContain("api.sapiom.ai/v1/mcp");
  });
});
