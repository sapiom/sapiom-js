---
"@sapiom/agent": patch
"@sapiom/agent-runtime": patch
---

Document that `pauseUntilSignal({ timeoutMs })` is a hard failure (`PauseTimeoutError`), not an in-workflow timeout→resume branch. Authors who need wait-or-proceed should fire the same signal from an external timer.
