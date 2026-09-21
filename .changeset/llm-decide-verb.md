---
"@sapiom/tools": minor
---

Add `llm.decide` — fixed-answer-set decisions with probabilities (yes/no `noul`, pick-one `choice`, rubric `score`) backed by TypeSafe Jev through the Capability Router (`POST /v1/capabilities/llm.decide`). Reachable as `ctx.sapiom.llm.decide(...)` / `client.llm.decide(...)`; the answers map is typed by the questions passed. The local stub answers every question in its type's shape so `run_local` runs unchanged.
