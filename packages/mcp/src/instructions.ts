/**
 * The MCP server `instructions` string, returned during the `initialize` handshake.
 * Capable MCP clients surface it to the model on connect, so an agent that adds this
 * server gets an agent-authoring primer without any extra setup.
 *
 * This is the OFFLINE FALLBACK: at startup the server fetches the live copy from
 * `GET {apiURL}/v1/mcp/instructions` (see instructions-fetch.ts) and serves that;
 * this constant is served only when the fetch fails. Keep it semantically aligned
 * with the backend's `DEFAULT_MCP_INSTRUCTIONS` (Sapiom repo,
 * backend/src/mcp/mcp-instructions.constants.ts); cross-repository release checks
 * verify the same supported commands and lifecycle boundaries.
 *
 * Kept intentionally short — it stays in the model's context for the whole session.
 * Deep authoring guidance lives in the scaffold-shipped `sapiom-agent-authoring`
 * skill and `AGENTS.md`, and the full reference on docs.sapiom.ai; this primer
 * points there rather than restating them.
 */
export const AUTHORING_INSTRUCTIONS = `# Sapiom dev MCP

This is Sapiom's local developer MCP — register it under the client alias \`sapiom\`. It reports
\`sapiom-dev\` as its MCP \`serverInfo.name\`, and its authoring tools keep the \`sapiom_dev_*\`
namespace. It is the terminal surface for building and managing your Sapiom projects. Today it
drives **agent authoring and sandbox app previews** (more dev/management tools will land here over
time). Agent authoring: build, test, and deploy a Sapiom agent — a
\`defineAgent({ name, entry, steps })\` (from \`@sapiom/agent\`) where each step's
\`run(input, ctx)\` does work and returns a directive. All from the terminal; no dashboard required.

## Two ways to use Sapiom
Register this local server as \`sapiom\`. It is where you **author agents** — the \`sapiom_dev_agents_*\` tools
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
2. Test locally: \`npm run typecheck\` → \`sapiom_dev_agents_check\` (typechecks, imports the
   definition, and validates its graph; no Sapiom account or service call) →
   \`sapiom_dev_agents_run_local\` (\`ctx.sapiom.*\` calls are stubbed, so there is no Sapiom
   capability spend; authored code and its ordinary side effects still execute).
3. Before the first cloud action, call \`sapiom_authenticate\`; browser login caches the shared
   API-key principal required by link, deploy, run, inspect, schedules, and signals. Confirm with
   \`sapiom_status\`.
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
- Cross-step state: \`ctx.shared\` — the entry input reaches only the entry step.
- Capabilities run via the typed \`ctx.sapiom.*\` client (sandboxes, repositories,
  models.coding, fileStorage, search, database, email, domains, memory, and more) —
  don't memorize the catalog; use autocomplete/typecheck. Schedules (cron triggers) are
  a top-level \`@sapiom/tools\` import, not under \`ctx.sapiom\`.

Full reference: https://docs.sapiom.ai/agents/quick-start and
https://docs.sapiom.ai/integration/mcp-servers/remote, plus the \`AGENTS.md\` and
\`sapiom-agent-authoring\` skill inside
your scaffolded project.`;
