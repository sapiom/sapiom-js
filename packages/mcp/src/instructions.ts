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
 * Kept intentionally short — it stays in the model's context for the whole session.
 * Deep authoring guidance lives in the scaffold-shipped `sapiom-agent-authoring`
 * skill and `AGENTS.md`, and the full reference on docs.sapiom.ai; this primer
 * points there rather than restating them.
 */
export const AUTHORING_INSTRUCTIONS = `# Sapiom dev MCP (sapiom-dev)

\`sapiom-dev\` is Sapiom's local developer MCP — the terminal surface for building and managing
your Sapiom projects. Today it drives **agent authoring and sandbox app previews** (more
dev/management tools will land here over time). Agent authoring: build, test, and deploy a
Sapiom agent — a \`defineAgent({ name, entry, steps })\` (from \`@sapiom/agent\`) where each
step's \`run(input, ctx)\` does work and returns a directive. All from the terminal; no
dashboard required.

## Two ways to use Sapiom
This server (\`sapiom-dev\`) is where you **author agents** — the \`sapiom_dev_agents_*\` tools
scaffold, typecheck, run with stubs, and deploy from a local checkout. For a **one-off
capability call** without an agent (a search, a scrape, one image), or from **hosted clients
that cannot run npx** (ChatGPT), use Sapiom's **remote MCP** at \`https://api.sapiom.ai/v1/mcp\`
(\`claude mcp add sapiom --transport http https://api.sapiom.ai/v1/mcp\`) — it exposes every
capability as a direct \`sapiom_*\` tool (run \`tool_discover\` to find the right one) plus cloud
workflow tools (\`sapiom_workflow_*\`: create → deploy with a \`files\` map → run → inspect/signal).
Rule of thumb: author an agent for anything multi-step, scheduled, or deployable; use the
remote MCP or the SDK for a single action.

## Lifecycle (in order)
1. Start a project — \`sapiom_dev_agents_scaffold\` (a fresh starter) or \`sapiom_dev_agents_clone\`
   (materialize a gallery template or an existing fork — the "use this template" handoff).
   READ the project's \`AGENTS.md\` first, plus the \`sapiom-agent-authoring\` skill in
   \`.claude/skills/\` where present (scaffolded projects include it; auto-loads in Claude Code).
   Then \`npm install\`.
2. Test locally: \`npm run typecheck\` → \`sapiom_dev_agents_check\` (typechecks, imports the
   definition, and validates its graph; no Sapiom account or service call) →
   \`sapiom_dev_agents_run_local\` (\`ctx.sapiom.*\` calls are stubbed, so there is no Sapiom
   capability spend; the author's own local code and side effects remain real).
3. Before cloud work, run \`sapiom_authenticate\` — browser login caches an API key and makes
   you an API-key principal. Confirm with \`sapiom_status\`; auth is required for link/deploy/run.
4. Ship: \`sapiom_dev_agents_link\` → \`_deploy\` → \`_run\` (real, billed) → \`_inspect\`.

## Preview a web app
From inside the project: \`sapiom_dev_sandbox_configure\` (writes the validated \`sapiom.json\`
resource — source, start command, port, optional build/tier/ttl/env) →
\`sapiom_dev_sandbox_check\` (optional) → \`sapiom_dev_sandbox_preview\` (uploads, builds, starts,
and returns a live URL; a \`failed\` status carries the build/start logs — fix and retry).

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
- Cross-step state: \`ctx.shared\` — the entry input reaches only the entry step. The whole
  snapshot has an inclusive 256 KiB (262,144-byte) quota, measured as compact
  \`JSON.stringify\` UTF-8 bytes; keep IDs/references here instead of bulk state. Hosts that
  construct this SDK version's \`InMemoryContextStore\` get setter-time validation:
  \`ctx.shared.set()\` validates the complete candidate synchronously and leaves the previous
  snapshot unchanged after an oversized or unserializable write. Hosts that have not adopted
  this store version may enforce only at execution boundaries during rollout. Use
  structural payload guards rather than \`instanceof\` when catching these errors because
  host and definition bundles can contain separate SDK copies.
  There is no \`delete()\` operation; to recover from legacy invalid state, replace an
  offending key with a compact, JSON-compatible value that brings the complete candidate
  within the quota.
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

Full reference: https://docs.sapiom.ai/agents/quick-start (authoring · capabilities ·
reference · examples), plus the \`AGENTS.md\` and \`sapiom-agent-authoring\` skill inside
your scaffolded project.`;
