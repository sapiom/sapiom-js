---
"@sapiom/sandbox": patch
---

Bound `execStream`'s post-stream status reconciliation by the exec timeout.

When a log stream ends before its process reaches a terminal status, `execStream` re-polls `GET /process/:pid` to resolve the real exit code. That loop had no deadline, so a process that never reported a terminal status left the caller awaiting the output iterable forever. Every other poll path (`exec`, `waitForProcess`) already stops at the 60s exec timeout and throws `Process <pid> timed out after 60000ms`; the reconciliation loop now does the same, turning a silent hang into the loud, debuggable failure the polling contract already documented.
