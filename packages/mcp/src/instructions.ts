/**
 * MCP server `instructions` — returned in the `initialize` handshake. Capable clients
 * (e.g. Claude Code) inject this into the agent's context on connect, so any coding agent
 * that adds this MCP gets the workflow-authoring primer automatically — no skill to install,
 * no docs to hand over.
 *
 * Keep this CONCISE: it is always in context while the server is connected. It POINTS to the
 * single-source full docs (https://docs.sapiom.ai/workflows) and the `AGENTS.md` the scaffold
 * writes into every project, rather than restating them — so it rarely needs to change.
 */
export const AUTHORING_INSTRUCTIONS = `# Sapiom Workflow Authoring

These tools let a coding agent build, test, and deploy a Sapiom workflow — a
\`defineOrchestration({ name, entry, steps })\` (from \`@sapiom/orchestration\`) where each
step's \`run(input, ctx)\` does work and returns a directive. All from the terminal; no dashboard.

## Lifecycle (in order)
1. \`sapiom_authenticate\` — browser login; caches an API key (makes you an API-key principal,
   required for deploy/run). Confirm with \`sapiom_status\`.
2. \`sapiom_dev_orchestrations_scaffold\` — writes a project. READ its \`AGENTS.md\` first; it is
   the full authoring guide, shipped inside every scaffold. Then \`npm install\`.
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
- Capabilities run via \`ctx.sapiom.*\` (sandboxes, repositories, agent.coding, fileStorage,
  contentGeneration.images) — a typed subset of the gateway catalog; use autocomplete/typecheck.

Full reference: https://docs.sapiom.ai/workflows (authoring · capabilities · reference · examples)
and the \`AGENTS.md\` inside your scaffolded project.`;
