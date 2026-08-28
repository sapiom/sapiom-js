/**
 * The MCP server `instructions` string, returned during the `initialize` handshake.
 * Capable MCP clients surface it to the model on connect, so an agent that adds this
 * server gets an agent-authoring primer without any extra setup.
 *
 * This is the OFFLINE FALLBACK: at startup the server fetches the live copy from
 * `GET {apiURL}/v1/mcp/instructions` (see instructions-fetch.ts) and serves that;
 * this constant is served only when the fetch fails. KEEP IT IDENTICAL to the
 * server's live-fetched copy (a private companion repo) — the two are one
 * canonical text.
 *
 * That rule is now enforced rather than merely stated: instructions.test.ts pins the
 * sha-256 of this string, and the server-side spec freezes the same digest for the
 * matching content release, so editing either copy alone reddens one repo's CI. The
 * guard exists because the rule failed silently for two content releases (SAP-2959):
 * this fallback still described a Sapiom without App Links, which offline sessions —
 * the only ones that read it — were then told did not exist. Changing the primer now
 * means moving both copies and both digests together.
 *
 * Kept intentionally short — it stays in the model's context for the whole session.
 * Deep authoring guidance lives in the scaffold-shipped `sapiom-agent-authoring`
 * skill and `AGENTS.md`, and the full reference on docs.sapiom.ai; this primer
 * points there rather than restating them.
 */
export const AUTHORING_INSTRUCTIONS = `# Sapiom local authoring MCP

\`sapiom-dev\` is this package's MCP server identity. In Claude Code, register it under the
supported local alias \`sapiom\` with \`claude mcp add sapiom -- npx -y @sapiom/mcp\`.
It is the terminal surface for building and managing your Sapiom projects. Today it drives
**agent authoring, sandbox app previews, and durable app publishing** (more
dev/management tools will land here over time). Agent authoring: build, test, and deploy a
Sapiom agent — a \`defineAgent({ name, entry, steps })\` (from \`@sapiom/agent\`) where each
step's \`run(input, ctx)\` does work and returns a directive. All from the terminal; no
dashboard required.

## Two ways to use Sapiom
Use the local \`sapiom\` alias to **author agents** — the \`sapiom_dev_agents_*\` tools
scaffold, typecheck, run with stubs, and deploy from a local checkout. For a **one-off
capability call** without an agent (a search, a scrape, one image), use the hosted capability
MCP under the distinct \`sapiom-direct\` alias:
\`claude mcp add --scope user --transport http sapiom-direct https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"\`.
Its runtime \`tools/list\` response is authoritative; use \`tool_discover\` to find a direct
\`sapiom_*\` capability tool. The endpoint may also advertise implemented cloud workflow and
governance tools, but the supported public authoring route is this local MCP or Agent Studio.
Rule of thumb: author an agent for anything multi-step, scheduled, or deployable; use the
hosted capability MCP or the TypeScript SDK for a single action.

## Lifecycle (in order)
1. Start a project — \`sapiom_dev_agents_scaffold\` (a fresh starter) or \`sapiom_dev_agents_clone\`
   (materialize a gallery template or an existing fork — the "use this template" handoff).
   READ the project's \`AGENTS.md\` first, plus the \`sapiom-agent-authoring\` skill in
   \`.claude/skills/\` where present (scaffolded projects include it; auto-loads in Claude Code).
   Then \`npm install\`.
2. Test locally: \`npm run typecheck\` → \`sapiom_dev_agents_check\` (bundles and imports the
   definition, then validates its graph; top-level author code can execute) →
   \`sapiom_dev_agents_run_local\` (Sapiom capabilities are stubbed with no Sapiom
   capability spend; authored code and its ordinary side effects still execute).
3. Before the first cloud action, call \`sapiom_authenticate\`; browser login caches the shared
   credential required by link/deploy/run. Confirm with \`sapiom_status\`.
4. Ship: \`sapiom_dev_agents_link\` → \`_deploy\` → \`_run\` (real cloud execution; costs
   depend on the work performed) → \`_inspect\`.

## Preview a web app
From inside the project: \`sapiom_dev_sandbox_configure\` (writes the validated \`sapiom.json\`
resource — source, start command, port, optional build/tier/ttl/env) →
\`sapiom_dev_sandbox_check\` (optional) → \`sapiom_dev_sandbox_preview\` (uploads, builds, starts,
and returns a live URL; a \`failed\` status carries the build/start logs — fix and retry).

That preview URL dies with its sandbox — the TTL expires and the link stops resolving. For a
link you can hand to someone, publish an **App Link**: a durable
\`https://apps.sapiom.ai/{org}/{slug}\` that outlives every sandbox — a visit wakes the app
from its stored bundle behind a "Starting …" page (cold start: tens of seconds). Durable
sharing, not always-on hosting. From this project that is \`sapiom_dev_app_publish\` (slug +
name only — it reads the same \`sapiom.json\` sandbox resource \`_preview\` uses, so source,
start, port, build and env are already set); it needs \`@sapiom/mcp\` >= 0.13, so if your
\`tools/list\` does not offer it, upgrade or use the next line. Without a project on disk:
\`sapiom_app_publish\` on the \`sapiom-direct\` alias above, or
\`POST /v1/app-links\` → \`PUT …/bundle\` → \`POST …/publish\`. Bundles are text-only UTF-8
and self-contained; republishing the same slug replaces the app in place at the same URL.
Org-scoped by default; \`public\` needs an explicit confirmation and a daily spend cap because
your org pays for every wake. See https://docs.sapiom.ai/capabilities/app-links.

## Canonical rules (types are the source of truth — run \`npm run typecheck\`)
- Import \`defineAgent\`, \`defineStep\`, and the directives
  (\`goto\` / \`terminate\` / \`fail\` / \`retry\` / \`pauseUntilSignal\`) from \`@sapiom/agent\`.
  Import Zod from \`zod/v4\`.
- \`terminate()\` requires \`terminal: true\`; \`fail()\` requires \`canFail: true\`;
  \`pauseUntilSignal(handle, …)\` requires \`pause: { signal, resumeStep }\`; every \`goto\`
  target must be listed in \`next[]\`. TypeScript enforces all of these.
- The entry step's \`inputSchema\` is the agent's public API — the dashboard Run form,
  the trigger snippet, and engine-side validation all read it. Declare it with zod
  (\`zod/v4\`); give fields \`.default()\` so a zero-input run still validates.
- Cross-step state: \`ctx.shared\` — the entry input reaches only the entry step.
- Capabilities run via the typed \`ctx.sapiom.*\` client (sandboxes, repositories,
  models.coding, fileStorage, search, database, email, domains, memory, and more) —
  don't memorize the catalog; use autocomplete/typecheck. Schedules (cron triggers) are
  a top-level \`@sapiom/tools\` import, not under \`ctx.sapiom\`.

## Calling LLMs and running agent loops (from agent code)
- **One LLM call → \`ctx.sapiom.llm.run\`** — summarize, extract, classify, one-shot generate.
  For a plain-text reply, read only \`type === 'text'\` content blocks (a \`thinking\` block
  may be present). For structured/JSON output, use the \`output\` param — it forces a tool
  call under the hood, so the payload is always the \`tool_use\` block's \`input\` — never
  "reply with only JSON" + string parsing.
- **Platform-driven agent loop → \`ctx.sapiom.models.run\`** — a multi-turn reasoning +
  tool-calling task (minutes, not seconds). \`models.coding.run\` for sandboxed coding tasks.
  Never use this for a one-shot completion — it will loop and overthink.
- **Dispatch a deployed agent by slug → \`ctx.sapiom.agents.run\`** — compose systems from
  small deployed agents rather than one large monolith.
- **You never pick a model.** Say how long you can wait (\`deadlineMinutes\` where supported)
  — the platform picks the model. \`llm.run\`/\`models.run\` report the served class and lane
  on the result (absent on older servers — treat missing as unknown); \`models.coding.run\`
  reports both as \`null\` today.
  **Omit \`model\` entirely (recommended)** — the platform routes it. Raw provider model ids
  are never honored.
- **Debugging a run:** open the Run Inspector, or fetch a step's full input/output via
  the per-step endpoint documented in the guide.

Full reference: https://docs.sapiom.ai/agents/quick-start,
https://docs.sapiom.ai/agents/authoring, and
https://docs.sapiom.ai/guides/connect-claude-code-with-mcp, plus the \`AGENTS.md\` and
\`sapiom-agent-authoring\` skill inside
your scaffolded project.`;
