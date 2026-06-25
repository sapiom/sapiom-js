---
"@sapiom/mcp": minor
---

Deliver the workflow-authoring primer via the MCP server `instructions` field. Capable clients (e.g. Claude Code) inject it into the agent's context on connect, so any agent that adds `@sapiom/mcp` gets the authoring lifecycle (authenticate → scaffold → check/run_local → deploy/run) and the canonical `@sapiom/orchestration` rules automatically — no skill install or docs hand-off. The primer is concise and points to the full docs (docs.sapiom.ai/workflows) and the scaffold's `AGENTS.md`.
