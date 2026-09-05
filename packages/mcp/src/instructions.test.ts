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

  it("names the two servers by role and keeps distinct aliases in the registration commands", () => {
    // Two-MCP frame: this server authors agents; the hosted capability server answers
    // one-off calls. Since 2.9 (SAP-3179) both are named by ROLE — "the local authoring
    // server", "the hosted capability server" — with the same phrases the Agent Studio
    // system prompt uses, because the aliases differ by context: Studio wires `sapiom`
    // (hosted) / `sapiom-dev` (local), while a plain Claude Code user registers `sapiom`
    // (local) / `sapiom-direct` (hosted). A Studio session reads both texts, so "use the
    // `sapiom` alias to author agents" pointed it at the remote server. Aliases survive
    // only inside the two `claude mcp add` commands. The 2.6-era copy conflated the two
    // servers onto one `sapiom` alias, which is why the negative assertions below exist.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "is **the local authoring server**",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("the hosted capability");
    expect(AUTHORING_INSTRUCTIONS).not.toContain(
      "`sapiom-dev` is this package's MCP server identity",
    );
    expect(AUTHORING_INSTRUCTIONS).not.toContain("the local `sapiom` alias");
    expect(AUTHORING_INSTRUCTIONS).not.toContain(
      "the distinct `sapiom-direct` alias",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "`claude mcp add sapiom -- npx -y @sapiom/mcp`",
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

  it("carries the served primer's one-line ctx.shared contract (SAP-2959)", () => {
    // This file used to assert an 11-line `ctx.shared` quota contract: the inclusive
    // 256 KiB / 262,144-byte limit, compact-`JSON.stringify` measurement, setter-time
    // validation, no `delete()`, structural guards over `instanceof`. That paragraph
    // was in THIS fallback and not in the served primer, so online sessions — the vast
    // majority — never saw it. Syncing to the served text drops it here too.
    //
    // That is a consequence of the sync, not an oversight, and it is the direction the
    // rule requires: the two copies are one canonical text, and the digest below cannot
    // hold if they differ by a paragraph. The contract still reaches authors through
    // packages/agent/README.md and the scaffold-shipped `sapiom-agent-authoring` skill.
    // Putting it back in the primer is a server-side content release, not an edit here.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "Cross-step state: `ctx.shared` — the entry input reaches only the entry step.",
    );
  });

  it("is byte-identical to the backend primer (frozen sha-256, SAP-2959)", () => {
    // THE SYNC RULE, which lives here rather than in instructions.ts because that
    // file's JSDoc is emitted into dist/instructions.d.ts and published to npm, where
    // none of this is actionable for a consumer: AUTHORING_INSTRUCTIONS is duplicated
    // verbatim from the server's canonical primer (a private companion repo). The
    // package must work offline, so it cannot import it. The two are one canonical
    // text — KEEP THEM IDENTICAL whenever either changes.
    //
    // The `contain` assertions above are what let this copy fall two content
    // releases behind the server without anything going red: each one still
    // passed against the older text. This digest is what actually binds the two
    // copies, and it works from both ends: the server-side spec pins this same
    // value against ITS current primer, so a content release there reddens that
    // spec and forces its author onto this pin, while an in-place edit here
    // reddens this one. Neither suite makes a network call.
    //
    // Be honest about the limit: neither pin can block a merge in the other
    // repository, and an author can still move one side alone. What the pair
    // removes is the silent path — drifting now takes a deliberate edit to a line
    // that says what it is for.
    //
    // To change the primer: ship the server-side content release, copy its new
    // body here verbatim, and update both pins to the new digest in the same pair
    // of PRs. Never re-point this digest on its own — that just re-blesses the
    // drift the guard exists to catch.
    //
    // Current release: 2.9 (servers named by role, not alias — SAP-3179).
    const sha256 = createHash("sha256")
      .update(AUTHORING_INSTRUCTIONS, "utf8")
      .digest("hex");
    expect(sha256).toBe(
      "5e9e2d2ac724c0a34c46e96f2092c5d0788929ada9ffadc236e6a0decabde211",
    );
  });
});
