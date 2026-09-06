---
"@sapiom/agent": patch
---

Document the engine's default pause deadline on `pauseUntilSignal`. A pause that omits `timeoutMs` now carries a 7-day deadline (the capability resume-token TTL) and is finalized as failed with `PauseTimeoutError` if no signal arrives, instead of waiting forever. Docs only: no SDK behavior changes.
