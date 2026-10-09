---
"@sapiom/agent": patch
---

Document the pause deadline on `pauseUntilSignal`, `PauseUntilSignalDirective.timeoutMs` and `Pause.timeoutMs`.

Forthcoming behavior change on the hosted engine, not in this package: a pause that omits `timeoutMs` waits indefinitely today, and will instead carry a 7-day deadline once the engine change for SAP-3207 is deployed. Past that deadline the run is finalized as failed rather than parking silently, carrying the engine's pause-timeout error, so a run that used to hang forever will surface as a failure. Runs already paused without `timeoutMs` when it deploys are held to the same 7 days, counted from their last activity, so one that has already waited longer fails soon after the deploy; a new `timeoutMs` only reaches pauses recorded after you redeploy. Pass an explicit `timeoutMs` on a signal pause that must outlive a week, such as a human approval gate. A pause on a dispatched child agent, launched now or with `at`, needs none: the engine keeps extending it while the child is still running, and an explicit `timeoutMs` there is taken literally and turns that off. `run_local` is unaffected either way: it never applies or enforces a pause deadline, it auto-resumes every pause immediately.

This package ships documentation only, with no type, signature or runtime change.
