---
"@sapiom/harness": patch
---

`DEFAULT_SYSTEM_PROMPT` gains a compact "Calling LLMs from agent code"
section — the same LLM call-surface rule taught in the MCP instructions and
the `sapiom-agent-authoring` skill, kept to ~8 lines since the prompt is
injected fresh into every Studio session's context. Also corrects the
adjacent "sapiom (remote, HTTP)" bullet's vague "models" capability mention
to point at the new section.
