---
"@sapiom/agent": minor
"@sapiom/agent-core": minor
"@sapiom/agent-runtime": minor
"@sapiom/tools": minor
"@sapiom/cli": minor
"@sapiom/mcp": minor
---

Rename the composition SDK to **agents** and the coding/LLM capability to **models**.

**Breaking — the package names changed. Install the new names; the old ones are deprecated.**

- Packages: `@sapiom/orchestration` → `@sapiom/agent`, `@sapiom/orchestration-core` → `@sapiom/agent-core`, `@sapiom/orchestration-runtime` → `@sapiom/agent-runtime`. (`@sapiom/create-orchestration` is retired — scaffold with the CLI or the developer MCP.)
- API: `defineOrchestration` → `defineAgent`; `Orchestration*` types/errors → `Agent*`.
- `@sapiom/tools`: the `agent` capability namespace is now `models` (e.g. `sapiom.models.coding`); the `orchestrations` namespace is now `agents`.
- CLI: `sapiom orchestrations …` → `sapiom agents …`.
- Developer MCP tools: `sapiom_dev_orchestrations_*` → `sapiom_dev_agents_*`.
