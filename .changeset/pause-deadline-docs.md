---
"@sapiom/agent": patch
---

Document the pause deadline on `pauseUntilSignal`, `PauseUntilSignalDirective.timeoutMs` and `Pause.timeoutMs`.

Forthcoming behavior change on the hosted engine, not in this package: a pause that omits `timeoutMs` waits indefinitely today, and will instead carry a 7-day deadline once the engine change for SAP-3207 is deployed. Past that deadline the run is finalized as failed with `PauseTimeoutError` rather than parking silently, so a run that used to hang forever will surface as a failure. Pass an explicit `timeoutMs` on a signal pause that must outlive a week, such as a human approval gate. `run_local` is unaffected either way: it never applies or enforces a pause deadline, it auto-resumes every pause immediately.

This package ships documentation only, with no type, signature or runtime change.
