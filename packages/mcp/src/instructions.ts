/**
 * The MCP server `instructions` string, returned during the `initialize` handshake.
 * Capable MCP clients surface it to the model on connect, so an agent that adds this
 * server gets a workflow-authoring primer without any extra setup.
 *
 * Kept intentionally short — it stays in the model's context for the whole session, and
 * points to the full documentation and the `AGENTS.md` generated into each scaffolded
 * project rather than restating them.
 */
export const AUTHORING_INSTRUCTIONS = `# Sapiom dev MCP (sapiom-dev)

\`sapiom-dev\` is Sapiom's local developer MCP — the terminal surface for setting up and managing
your Sapiom projects. Today it drives **workflow authoring** (more dev/management tools will land
here over time): these tools build, test, and deploy a Sapiom workflow — a
\`defineOrchestration({ name, entry, steps })\` (from \`@sapiom/orchestration\`) where each step's
\`run(input, ctx)\` does work and returns a directive. All from the terminal; no dashboard.

## Two ways to use Sapiom
This server (\`sapiom-dev\`) is where you **author workflows** — the
\`sapiom_dev_orchestrations_*\` tools build, test, and deploy them. For a **one-off capability call** without authoring a
workflow, use Sapiom's **remote MCP** at \`https://api.sapiom.ai/v1/mcp\`
(\`claude mcp add sapiom --transport http https://api.sapiom.ai/v1/mcp\`) — it exposes every
capability as a direct \`sapiom_*\` tool (e.g. \`sapiom_search\`; run \`tool_discover\` to find the right one) — or call the gateway from code with the SDK
(\`@sapiom/fetch\`). Rule of thumb: author a workflow for anything multi-step, scheduled, or
deployable; use the remote MCP or the SDK for a single action.

## Lifecycle (in order)
1. \`sapiom_authenticate\` — browser login; caches an API key (makes you an API-key principal,
   required for deploy/run). Confirm with \`sapiom_status\`.
2. Start a project — either \`sapiom_dev_orchestrations_scaffold\` (a fresh starter) or
   \`sapiom_dev_orchestrations_clone\` (materialize a gallery template / an existing fork — the
   "use this template" handoff; forks + git-clones the repo and writes \`sapiom.json\`). READ the
   project's \`AGENTS.md\` first; it is the full authoring guide. Then \`npm install\`.
3. Test for free: \`npm run typecheck\` → \`sapiom_dev_orchestrations_check\` (validates the step
   graph, offline) → \`sapiom_dev_orchestrations_run_local\` (capabilities are stubbed; zero spend).
4. Ship: \`sapiom_dev_orchestrations_link\` → \`_deploy\` → \`_run\` (real, billed) → \`_inspect\`.

## Canonical rules (types are the source of truth — run \`npm run typecheck\`)
- Import \`defineOrchestration\`, \`defineStep\`, and the directives
  (\`goto\` / \`terminate\` / \`fail\` / \`retry\` / \`pauseUntilSignal\`) from \`@sapiom/orchestration\`.
  NEVER \`defineWorkflow\` or \`@sapiom/workflow-sdk\` (they do not exist). Import Zod from \`zod/v4\`.
- \`defineStep({ name, next, terminal?, canFail?, pause?, inputSchema?, run })\`:
  \`terminate()\` requires \`terminal: true\`; \`fail()\` requires \`canFail: true\`;
  \`pauseUntilSignal(handle, …)\` requires \`pause: { signal, resumeStep }\`; every \`goto\` target
  must be listed in \`next[]\`. TypeScript enforces all of these.
- Cross-step state: \`ctx.shared\` — the entry input reaches only the entry step.
- Capabilities run via \`ctx.sapiom.*\` (sandboxes, repositories, agent(+coding), orchestrations,
  fileStorage, contentGeneration.{images,video}, search, database) — a typed subset of the gateway
  catalog; use autocomplete/typecheck.

Full reference: https://docs.sapiom.ai/workflows/quick-start (authoring · capabilities · reference · examples)
and the \`AGENTS.md\` inside your scaffolded project.`;
