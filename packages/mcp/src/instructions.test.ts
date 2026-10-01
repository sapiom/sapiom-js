import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AUTHORING_INSTRUCTIONS,
  AUTHORING_INSTRUCTIONS_DIGEST,
  AUTHORING_INSTRUCTIONS_RELEASE,
} from "./instructions.js";

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

  it("bundled snapshot is self-consistent: sha-256(body) equals the stamped digest", () => {
    // instructions.generated.ts is written by scripts/mcp-instructions-snapshot.mjs
    // from the served endpoint, body and digest together. Editing the body by hand
    // fails this; the fix is to re-run the script, never to re-point the digest.
    expect(AUTHORING_INSTRUCTIONS_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(AUTHORING_INSTRUCTIONS_RELEASE).toMatch(/^\d+\.\d+$/);
    const sha256 = createHash("sha256")
      .update(AUTHORING_INSTRUCTIONS, "utf8")
      .digest("hex");
    expect(sha256).toBe(AUTHORING_INSTRUCTIONS_DIGEST);
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

  it("names the two servers by role and keeps distinct aliases in the registration commands (SAP-3179)", () => {
    // Served since the 2.12 release (sapiom/Sapiom#5026, which folded the closed #4884 in);
    // #814 parked this block while that wording was unserved, and this copy carries it from 2.14 on.
    // Two-MCP frame: this server authors agents; the hosted capability server answers
    // one-off calls. Under SAP-3179 both are named by ROLE — "the local authoring
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

  it("teaches App Link management from this server, version-gated (SAP-3178)", () => {
    // 2.8 taught publishing and nothing else about a link, so an offline session
    // could not learn that webhooks are off by default, how to turn them on, or
    // that `/hook/*` is the receiver. The three management tools shipped in 0.15;
    // the gate is the same one `_publish` carries, for the same reason. Served since
    // the 2.12 release (sapiom/Sapiom#5026), which folded them into 2.11's webhook
    // paragraph and retired its "no `sapiom_dev_*` tool sets it yet" clause.
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_app_list");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_app_settings");
    expect(AUTHORING_INSTRUCTIONS).toContain("sapiom_dev_app_delete");
    expect(AUTHORING_INSTRUCTIONS).toContain("`@sapiom/mcp` >= 0.15");
    expect(AUTHORING_INSTRUCTIONS).toContain("Webhooks are OFF by default");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "https://apps.sapiom.ai/{org}/{slug}/hook/<path>",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("settings need `org.write`");
    expect(AUTHORING_INSTRUCTIONS).not.toContain(
      "no `sapiom_dev_*` tool sets it yet",
    );
  });

  it("names the entry step's inputSchema as the agent's public API (SAP-2227)", () => {
    // The primer is the only always-in-context surface, so authors learn the entry
    // contract here. Matches the served text.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "entry step's `inputSchema` is the agent's public API",
    );
  });

  it("teaches the LLM call-surface rule (SAP-2775) — matches the served text", () => {
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.llm.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.models.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("models.coding.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.agents.run");
    expect(AUTHORING_INSTRUCTIONS).toContain("You never pick a model");
    // The internal `workflows`-service naming must never reach this customer-facing
    // primer — the per-step debugging endpoint lives in the docs guide, not spelled
    // out here verbatim (matches this package's own scaffold terminology guard).
    expect(AUTHORING_INSTRUCTIONS).toContain("Run Inspector");
    const ALLOWED_WORKFLOWS_ROUTES = [
      "GET /v1/workflows/receipts?outcome=unmatched",
      "GET /v1/workflows/receipts/{id}",
      "POST /v1/workflows/receipts/{id}/replay",
      "POST /v1/workflows/fires/{id}/replay",
    ];
    const outsideAllowList = ALLOWED_WORKFLOWS_ROUTES.reduce(
      (text, route) => text.split(route).join(""),
      AUTHORING_INSTRUCTIONS,
    );
    expect(outsideAllowList).not.toContain("/v1/workflows/");
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
    // That is a consequence of the sync, not an oversight: the snapshot is generated
    // from the served text, so it cannot carry a paragraph the server does not. The
    // contract still reaches authors through packages/agent/README.md and the
    // scaffold-shipped `sapiom-agent-authoring` skill. Putting it back in the primer is
    // a server-side content release, not an edit here.
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "Cross-step state: `ctx.shared` — the entry input reaches only the entry step.",
    );
  });

  it("teaches the four trigger kinds and the webhook signing scheme (SAP-3174)", () => {
    // Before 2.10 the primer named only the two schedule kinds, and the schedule tool's enum
    // matched — an agent asked to run on an inbound POST concluded nothing listens and
    // proposed hand-building a server. The kinds, the scheme, and the App Link boundary
    // (third-party senders cannot produce our HMAC) all have to be here, version-gated.
    for (const kind of ["schedule_cron", "schedule_once", "event", "webhook"]) {
      expect(AUTHORING_INSTRUCTIONS).toContain(`\`${kind}\``);
    }
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "sapiom_dev_agents_schedule_secret",
    );
    const flat = AUTHORING_INSTRUCTIONS.replace(/\s+/g, " ");
    expect(flat).toContain("HMAC-SHA256 hex over `timestamp.eventId.rawBody`");
    expect(flat).toContain(
      "epoch-ms timestamp, url-safe event id `[A-Za-z0-9_-]{1,128}`, ±5 min skew",
    );
    for (const h of [
      "X-Sapiom-Timestamp",
      "X-Sapiom-Event-Id",
      "X-Sapiom-Signature",
    ]) {
      expect(AUTHORING_INSTRUCTIONS).toContain(h);
    }
    expect(AUTHORING_INSTRUCTIONS).toContain("App Link `/hook/*` receiver");
    expect(AUTHORING_INSTRUCTIONS).toContain("`@sapiom/mcp` >= 0.15");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "https://docs.sapiom.ai/guides/triggers",
    );
  });

  it("teaches Vault semantics, agents.launch, receipts/replay, and App Link webhooks (SAP-3180)", () => {
    // Served since 2.11 (sapiom/Sapiom#4885); this copy carries it from 2.14 on.
    // Each of these shipped without any served text teaching it, so an agent could only
    // guess at it. Matches the served text, so asserted here too.
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.vault.get");
    expect(AUTHORING_INSTRUCTIONS).toContain("agent code cannot write");
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.agents.launch");
    expect(AUTHORING_INSTRUCTIONS).toContain("GET /v1/workflows/receipts");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "POST /v1/workflows/fires/{id}/replay",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("webhooksEnabled");
    expect(AUTHORING_INSTRUCTIONS).toContain(
      "https://apps.sapiom.ai/{org}/{slug}/hook/<path>",
    );
    expect(AUTHORING_INSTRUCTIONS).toContain("byte-exact");
    expect(AUTHORING_INSTRUCTIONS).toContain("held up to 60 s");
    // `LlmRunSpec` has no `deadlineMinutes`; 2.9 dropped the clause that offered it to a
    // one-shot caller. Scoped to that clause, not the identifier: `LlmSubmitSpec` has a
    // real `deadlineMinutes`, and a later primer may document the deferred lane's knob.
    expect(AUTHORING_INSTRUCTIONS).not.toContain("Say how long you can wait");
  });

  it("says a Sapiom Postgres is permanent, with no lifetime to pick (2.13)", () => {
    // 2.13 (sapiom/Sapiom#4972) retired the 7-day database claim: a database lives until
    // deleted and holds a plan slot while held, so an author must not look for a `duration`.
    expect(AUTHORING_INSTRUCTIONS).toContain("ctx.sapiom.database.create");
    expect(AUTHORING_INSTRUCTIONS).toContain("is permanent");
    expect(AUTHORING_INSTRUCTIONS).toContain("no `duration` to pass");
  });

  it("says an App Link is a redirector, not a reverse proxy, and how to reach the app (SAP-3217)", () => {
    // 2.14 (sapiom/Sapiom#4926), from Studio feedback: an agent treated the durable URL as a
    // stable base and pointed the app's own fetches at sub-paths of it, which the host 404s.
    // The primer must name the redirect-then-`__status` discovery loop, its ordering trap, and
    // the token expiry that makes storing the address wrong too.
    const flat = AUTHORING_INSTRUCTIONS.replace(/\s+/g, " ");
    expect(flat).toContain("**redirector, not a reverse proxy**");
    expect(flat).toContain("request the root WITHOUT following redirects");
    expect(flat).toContain("Do NOT make `__status` your FIRST call");
    expect(flat).toContain(
      "Re-read the address per use rather than storing it",
    );
    expect(flat).toContain("an org-scoped app's API is browser-only");
    // The `/hook/*` exposure caveats 2.11 omitted: any method on any sub-path, no caller auth.
    expect(flat).toContain(
      "the hook accepts ANY method on ANY path under `/hook/`",
    );
    expect(flat).toContain("treat the URL as a secret");
  });
});
