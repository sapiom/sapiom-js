---
"@sapiom/mcp": patch
---

`AUTHORING_INSTRUCTIONS` (the offline fallback served when the startup fetch
to the backend's `GET /v1/mcp/instructions` fails) gains a "Calling LLMs and
running agent loops" section: `ctx.sapiom.llm.run` (one-shot) vs
`ctx.sapiom.models.run` (platform-driven multi-turn loop, never for a
one-shot) vs `ctx.sapiom.agents.run` (dispatch a deployed agent by slug); the
omit-`model`-or-pin-`"smart"` label rule; and a debugging pointer. Kept
byte-identical to the backend's live-fetched `DEFAULT_MCP_INSTRUCTIONS` copy
(companion Sapiom-repo PR).
