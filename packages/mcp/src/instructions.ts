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
export const AUTHORING_INSTRUCTIONS = `# Sapiom Project MCP

This local server works beside a checkout so you can create, check, test, deploy, and operate
a Sapiom agent project from Claude Code or Codex. Register the connection as
\`sapiom-project\`:
- Claude Code: \`claude mcp add sapiom-project -- npx -y @sapiom/mcp\`
- Codex: \`codex mcp add sapiom-project -- npx -y @sapiom/mcp\`

The package still reports \`sapiom-dev\` as its MCP wire identity, and its project tools keep
their \`sapiom_dev_*\` names. A client alias labels the configured connection; it does not
rename tools. Some clients merge tools from every connection into one flat list, so never use
\`sapiom_*\` as a cloud-only permission wildcard: it also matches these project lifecycle
tools.

## Project MCP and Cloud MCP
Use Project MCP when the work belongs to a local agent project. Use Sapiom Cloud MCP for a
direct cloud capability without a checkout. Register Cloud MCP separately as \`sapiom-cloud\`:
- Claude Code: \`claude mcp add --scope user --transport http sapiom-cloud https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"\`
- Codex: \`codex mcp add sapiom-cloud --url https://api.sapiom.ai/v1/mcp --bearer-token-env-var SAPIOM_API_KEY\`

Cloud MCP requires a Sapiom API key when it connects. Project MCP can scaffold, check, and run
locally while signed out; before its first cloud action, \`sapiom_authenticate\` opens browser
sign-in and caches the selected Sapiom environment. Cloud MCP's runtime tool catalog is
authoritative; use its discovery tool instead of memorizing names or assuming a prefix means
an operation is read-only.

## Lifecycle (in order)
1. Start a project — \`sapiom_dev_agents_scaffold\` (a fresh starter) or \`sapiom_dev_agents_clone\`
   (materialize a gallery template or an existing fork — the "use this template" handoff).
   READ the project's \`AGENTS.md\` first, plus the \`sapiom-agent-authoring\` skill in
   \`.claude/skills/\` where present (Claude Code can auto-load it; Codex should follow
   \`AGENTS.md\`).
   Then \`npm install\`.
2. Test locally: \`npm run typecheck\` → \`sapiom_dev_agents_check\` (typechecks, imports the
   definition, and validates its graph; top-level author code can execute, but there is no
   Sapiom account or service call) →
   \`sapiom_dev_agents_run_local\` (\`ctx.sapiom.*\` calls are stubbed, so there is no Sapiom
   capability spend; authored code and its ordinary side effects still execute).
3. Before the first cloud action, call \`sapiom_authenticate\`; browser login caches the shared
   API-key principal required by link, deploy, run, inspect, schedules, and signals. Confirm with
   \`sapiom_status\`.
4. Ship: \`sapiom_dev_agents_link\` → \`_deploy\` → \`_run\` (real cloud execution; costs
   depend on the work performed) → \`_inspect\`.

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

Full reference: https://docs.sapiom.ai/agents/quick-start,
https://docs.sapiom.ai/agents/authoring, and
https://docs.sapiom.ai/guides/connect-claude-code-with-mcp, plus the \`AGENTS.md\` and
\`sapiom-agent-authoring\` skill inside
your scaffolded project.`;
