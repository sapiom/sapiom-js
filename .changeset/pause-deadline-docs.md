---
"@sapiom/agent": patch
---

Document the pause deadline on `pauseUntilSignal`, `PauseUntilSignalDirective.timeoutMs` and `Pause.timeoutMs`.

Forthcoming behavior change on the hosted engine, not in this package: a pause that omits `timeoutMs` waits indefinitely today, and will instead carry a deadline once the engine change for SAP-3207 is deployed. The engine picks it from what the pause is waiting on: 7 days for a machine wait, one year for a run it recognizes as parked on a human approval gate. Past the deadline the run is finalized as failed with `PauseTimeoutError` rather than parking silently, so a run that used to hang forever will surface as a failure. Set `timeoutMs` explicitly on a dispatched child agent that can outlive a week: its result returns through parent linkage rather than a resume token, so the machine default does not bound it. `run_local` is unaffected either way: it never applies or enforces a pause deadline, it auto-resumes every pause immediately.

This package ships documentation only, with no type, signature or runtime change.
