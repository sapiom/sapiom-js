---
"@sapiom/agent": patch
---

Document the pause deadline on `pauseUntilSignal`, `PauseUntilSignalDirective.timeoutMs` and `Pause.timeoutMs`.

Behavior change (hosted engine, not this package): a pause that omits `timeoutMs` used to wait indefinitely, and the hosted engine now gives it a 7-day deadline. Past it the run is finalized as failed with `PauseTimeoutError` instead of parking silently, so a run that previously hung forever will surface as a failure. Pass an explicit `timeoutMs` on a signal pause that must outlive a week, such as a human approval gate. `run_local` is unaffected: the in-memory host records the deadline but never sweeps for it.

This package ships documentation only, with no type, signature or runtime change.
