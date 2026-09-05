---
"@sapiom/tools": minor
---

Coding runs and model runs take an optional `deadlineMinutes` — how long you're willing to wait, sent on the wire as `deadline_minutes`. The platform derives the billing lane (`run_now` / `priority` / `standard` / `flex`) from it, so a run you can wait on costs less. Omitting it is unchanged behavior: the key never reaches the wire and the run dispatches immediately.

`RunStatus` also gains `awaiting_capacity`, the non-terminal state a deferred run reports while it waits for a lane. `run()` and a `launch()` handle keep polling through it rather than resolving with no result.
