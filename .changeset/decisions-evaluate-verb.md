---
"@sapiom/tools": minor
---

Add `decisions.evaluate` — fixed-answer-set decisions with probabilities (yes/no `noul`, pick-one `choice`, rubric `score`) backed by a System One decision model through the Capability Router (`POST /v1/capabilities/decisions.evaluate`). Reachable as `ctx.sapiom.decisions.evaluate(...)` / `client.decisions.evaluate(...)`, importable from `@sapiom/tools/decisions`; the answers map is typed by the questions passed. Non-2xx responses throw `DecisionsHttpError`. The local stub answers every question in its type's shape (undecided) and rejects the rubrics the router rejects, so `run_local` runs unchanged; override it under the `decisions.evaluate` key.

Results contain answers, token usage, and optional cost quote metadata, without model or provider identity. The optional request model remains supported.
