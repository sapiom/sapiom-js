---
"@sapiom/agent-core": patch
"@sapiom/cli": patch
---

The `sapiom-agent-authoring` skill and the scaffolded `AGENTS.md` now teach coordinators to
launch children with `ctx.sapiom.agents.launch` and pause on each handle instead of waiting
with `agents.run`, which polls the agents API every 3 s for as long as the child runs and fails
with 429s when many coordinators wait at once (SAP-3615). The skill gains a "Waiting on Work"
section with a one-child example, the launch-all / pause-on-each fan-in loop, and the two pause
behaviours to design around, pointing at the served `waiting-on-work` section, which
`AUTHORING_RULES_SECTIONS` now lists.
