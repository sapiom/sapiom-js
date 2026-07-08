/**
 * The MCP server `instructions` string, returned during the `initialize` handshake.
 * Capable MCP clients surface it to the model on connect, so an agent that adds this
 * server gets an agent-authoring primer without any extra setup.
 *
 * This is the OFFLINE FALLBACK: at startup the server fetches the live copy from
 * `GET {apiURL}/v1/mcp/instructions` (see instructions-fetch.ts) and serves that;
 * this constant is served only when the fetch fails. KEEP IT IDENTICAL to the
 * backend's `DEFAULT_MCP_INSTRUCTIONS` (Sapiom repo,
 * backend/src/mcp/mcp-instructions.constants.ts) — the two are one canonical text.
 *
 * Kept intentionally short — it stays in the model's context for the whole session.
 * Deep authoring guidance lives in the scaffold-shipped `sapiom-agent-authoring`
 * skill and `AGENTS.md`, and the full reference on docs.sapiom.ai; this primer
 * points there rather than restating them.
 */
export const AUTHORING_INSTRUCTIONS = `# Sapiom dev MCP (sapiom-dev)

\`sapiom-dev\` is Sapiom's local developer MCP — the terminal surface for building and managing
your Sapiom projects. Today it drives **agent authoring** (more dev/management tools will land
here over time): build, test, and deploy a Sapiom agent — a \`defineAgent({ name, entry, steps })\`
(from \`@sapiom/agent\`) where each step's \`run(input, ctx)\` does work and returns a directive.
All from the terminal; no dashboard required.

## Two ways to use Sapiom
This server (\`sapiom-dev\`) is where you **author agents** — the \`sapiom_dev_agents_*\` tools
scaffold, typecheck, run with stubs, and deploy from a local checkout. For a **one-off
capability call** without an agent (a search, a scrape, one image), or from **hosted clients
that cannot run npx** (ChatGPT), use Sapiom's **remote MCP** at \`https://api.sapiom.ai/v1/mcp\`
(\`claude mcp add sapiom --transport http https://api.sapiom.ai/v1/mcp\`) — it exposes every
capability as a direct \`sapiom_*\` tool (run \`tool_discover\` to find the right one) plus cloud
agent tools (\`sapiom_agent_*\`: create → deploy with a \`files\` map → execute → inspect/signal).
Rule of thumb: author an agent for anything multi-step, scheduled, or deployable; use the
remote MCP or the SDK for a single action.

## Lifecycle (in order)
1. \`sapiom_authenticate\` — browser login; caches an API key (makes you an API-key principal,
   required for deploy/run). Confirm with \`sapiom_status\`.
2. \`sapiom_dev_agents_scaffold\` — writes the project, including the full authoring guide:
   read \`AGENTS.md\` first, and the \`sapiom-agent-authoring\` skill in \`.claude/skills/\`
   (auto-loads in Claude Code). Then \`npm install\`.
3. Test for free: \`npm run typecheck\` → \`sapiom_dev_agents_check\` (validates the step graph,
   offline) → \`sapiom_dev_agents_run_local\` (capabilities are stubbed; zero spend).
4. Ship: \`sapiom_dev_agents_link\` → \`_deploy\` → \`_run\` (real, billed) → \`_inspect\`.

## Canonical rules (types are the source of truth — run \`npm run typecheck\`)
- Import \`defineAgent\`, \`defineStep\`, and the directives
  (\`goto\` / \`terminate\` / \`fail\` / \`retry\` / \`pauseUntilSignal\`) from \`@sapiom/agent\`.
  NEVER \`defineWorkflow\`, \`defineOrchestration\`, or \`@sapiom/orchestration\` (stale names).
  Import Zod from \`zod/v4\`.
- \`terminate()\` requires \`terminal: true\`; \`fail()\` requires \`canFail: true\`;
  \`pauseUntilSignal(handle, …)\` requires \`pause: { signal, resumeStep }\`; every \`goto\`
  target must be listed in \`next[]\`. TypeScript enforces all of these.
- Cross-step state: \`ctx.shared\` — the entry input reaches only the entry step.
- Capabilities run via the typed \`ctx.sapiom.*\` client (sandboxes, repositories,
  models.coding, fileStorage, search, database, and more) — don't memorize the catalog;
  use autocomplete/typecheck.

Full reference: https://docs.sapiom.ai/agents/quick-start (authoring · capabilities ·
reference · examples), plus the \`AGENTS.md\` and \`sapiom-agent-authoring\` skill inside
your scaffolded project.`;
