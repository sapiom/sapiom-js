---
"@sapiom/agent-core": patch
"@sapiom/cli": patch
---

`sapiom-agent-authoring` skill + scaffold `AGENTS.md`: system-design teaching for multi-stage builds. New "Composing Deployed Agents" section — one agent per PROJECT; a multi-stage system is several small projects composed via `ctx.sapiom.agents.run`, with a worked coordinator example — and the scaffold's "keep exactly one `defineAgent` export" rule now says so inline, so it reads as a per-project rule rather than a design instruction to inline every stage. Also drops the "pass `smart` if you must pin" no-op from the label rule (omitting `model` is the recommendation; `smart` already is the default).
