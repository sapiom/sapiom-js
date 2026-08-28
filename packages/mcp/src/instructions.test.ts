import { createHash } from "node:crypto";
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
  });

  it("keeps local authoring and hosted direct access on distinct aliases", () => {
    // Two-MCP frame: this server authors agents under the local `sapiom` alias; the
    // hosted capability MCP answers one-off calls under the distinct `sapiom-direct`
    // alias. The 2.6-era copy conflated them onto one `sapiom` alias, which is why
    // the negative assertions below exist.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "`sapiom-dev` is this package's MCP server identity",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "supported local alias `sapiom` with `claude mcp add sapiom -- npx -y @sapiom/mcp`",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "claude mcp add --scope user --transport http sapiom-direct https://api.sapiom.ai/v1/mcp",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("tool_discover");
    expect(AUTHORING_INSTRUCTIONS).not.toContain(
      "claude mcp add sapiom --transport http",
    );
    expect(AUTHORING_INSTRUCTIONS).not.toContain("it exposes every capability");
    expect(AUTHORING_INSTRUCTIONS).not.toContain(
      "# Sapiom dev MCP (sapiom-dev)",
    );
  });

  it("points the preview path at App Links for durable sharing (SAP-2923)", () => {
    // A preview URL dies with its sandbox. Without a named durable successor here,
    // App Links are undiscoverable from the one surface every session reads on
    // connect — and this fallback is the copy served when the live fetch fails,
    // i.e. the path with no other source of truth.
    expect(AUTHORING_INSTRUCTIONS).toContain("App Link");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "https://apps.sapiom.ai/{org}/{slug}",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_app_publish");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "https://docs.sapiom.ai/capabilities/app-links",
    );
    // The local one-call path, version-gated: the backend live-fetches this text to
    // every install, including clients on an older @sapiom/mcp whose server never
    // advertised the tool. The gate is the part that keeps naming it honest.
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_app_publish");
    expect(AUTHORING_INSTRUCTIONS).toContain("`@sapiom/mcp` >= 0.13");
  });

  it("names the entry step's inputSchema as the agent's public API (SAP-2227)", () => {
    // The primer is the only always-in-context surface, so authors learn the entry
    // contract here. Kept byte-identical to the backend DEFAULT_MCP_INSTRUCTIONS copy.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "entry step's `inputSchema` is the agent's public API",
    );
  });

  it("teaches the LLM call-surface rule (SAP-2775)", () => {
    // Stops an authored agent from misusing a one-shot LLM call as an agent loop (or
    // vice versa) and from string-parsing JSON out of a `thinking`-capable response.
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.llm.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.models.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("models.coding.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.agents.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("You never pick a model");
    expect(AUTHORING_INSTRUCTIONS).toContain("Run Inspector");
    expect(AUTHORING_INSTRUCTIONS).not.toContain("/v1/workflows/");
  });

  it("is byte-identical to the backend primer (frozen sha-256, SAP-2959)", () => {
    // The `contain` assertions above are what let this copy fall two content
    // releases behind the server without anything going red: each one still
    // passed against the older text. This is the guard that actually binds the
    // two copies — the digest is the same frozen value the server-side spec pins
    // for the matching content release, so a one-sided edit reddens one repo or
    // the other, with no network call from either test suite.
    //
    // To change the primer: ship the server-side content release, copy its new
    // body here verbatim, and update both digests in the same pair of PRs. Never
    // re-point this digest on its own — that just re-blesses the drift the guard
    // exists to catch.
    //
    // Current release: 2.8 (App Links + `sapiom_dev_app_publish`).
    const sha256 = createHash("sha256")
      .update(AUTHORING_INSTRUCTIONS, "utf8")
      .digest("hex");
    expect(sha256).toBe(
      "7f518d9c4a80122e51d45e9e28dc5f6cacfd3b05f4101aa1a5b8ae5d4494c0df",
    );
  });
});
