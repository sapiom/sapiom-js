---
"@sapiom/agent-core": minor
"@sapiom/mcp": minor
---

Ship the `sapiom-agent-authoring` skill with every scaffold, and finish the MCP
instructions rename.

- New canonical skill (`agent-core/skills/sapiom-agent-authoring/SKILL.md`) with a
  task-shape trigger ("automate a multi-step / scheduled / deployable task"), the full
  authoring guide (`defineAgent`, directives, pause/resume, stubs), and a bootstrap
  step for agents whose client doesn't have the sapiom-dev MCP yet.
- Both scaffold templates ship it at `.claude/skills/sapiom-agent-authoring/` (auto-loads
  as a project skill in Claude Code) and `AGENTS.md` points to it, so every scaffolded
  project self-documents. A sync test keeps template copies identical to the canonical.
- `@sapiom/mcp`'s bundled instructions fallback rewritten to the agents/models
  vocabulary (the rename left it on the old text), thinned to lifecycle + canonical
  rules + pointers — deep guidance lives in the skill/AGENTS.md/docs.
