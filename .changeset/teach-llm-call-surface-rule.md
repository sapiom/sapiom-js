---
"@sapiom/agent-core": patch
"@sapiom/tools": patch
---

`sapiom-agent-authoring` skill: teaches the LLM call-surface rule from step
code (`llm.run` one-shot vs `models.run` platform-driven loop vs `agents.run`
deployed-agent dispatch, with a worked example against the "reply with only
JSON" + string-parsing mistake) and settles the platform's naming
conventions (the overloaded "agent"/"run"/"task"/"session"/"dispatch" terms,
and "label" as the author-facing term for a `model:` value). Synced across
the canonical source, both scaffold templates, and the Claude Code plugin
copy. `@sapiom/tools`: corrected stale `agent.run`/`agent.coding` naming in
`models/index.ts`'s doc comments — the actual exported namespace is
`models`.
