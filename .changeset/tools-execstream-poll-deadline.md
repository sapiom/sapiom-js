---
"@sapiom/tools": patch
---

Bound `Sandbox.execStream`'s post-stream status reconciliation by the exec timeout.

When a log stream ends before its process reaches a terminal status, `execStream` re-polls process status to resolve the real exit code. That loop had no deadline, so a process that never reported a terminal status left the caller awaiting the output iterable forever. `exec` / `pollProcess` already stop at the 60s exec timeout and throw `Process <pid> timed out after 60000ms`; the reconciliation loop now does the same.
