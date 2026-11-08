---
"@sapiom/tools": patch
---

Bound `Sandbox.execStream`'s post-stream status reconciliation by the exec timeout. When a log stream ends before its process reaches a terminal status, `execStream` re-polls the process status to resolve the real exit code. That loop had no deadline, so a process that never reported a terminal status left the caller's `output` iterable pending forever. It now stops at the same 60s timeout `exec`/`waitForProcess` already apply, throwing `Process <pid> timed out after 60000ms` — matching the fix already applied to `@sapiom/sandbox`'s `execStream` (#616).
