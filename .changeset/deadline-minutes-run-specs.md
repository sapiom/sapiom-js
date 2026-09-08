---
"@sapiom/tools": minor
---

Coding runs and model runs take an optional `deadlineMinutes` — how long you're willing to wait — sent on the wire as `deadline_minutes`. It is the deadline half of the label + deadline vocabulary: you state the kind of call (`model`) and how long you can wait, and the platform derives the billing lane from that rather than you naming one. **In this release the field is accepted and sent on the wire only; lane derivation lands in a later platform release, so a deadline does not yet change how a run is dispatched or priced.** Omitting it is unchanged behavior — the key never reaches the wire and the run dispatches immediately.

`RunStatus` and `ModelRunStatus` gain `awaiting_capacity`, the non-terminal state a deferred run reports while it waits for a lane. `run()` and a `launch()` handle keep polling through it rather than resolving with no result, and `wait()`'s default poll budget now widens to cover the deadline you asked for (an explicit `timeoutMs` still wins). While a run is parked, polling backs off — doubling up to a minute between checks — and returns to the caller's interval as soon as the run is moving, so a long deadline costs a few hundred requests rather than thousands.

Note for consumers who `switch` exhaustively over `RunStatus` or `ModelRunStatus`: a new union member is a compile error against a `default: assertNever(status)` arm. Handle `awaiting_capacity` as non-terminal — the run is still in flight.
