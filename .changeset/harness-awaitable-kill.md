---
"@sapiom/harness": patch
---

Awaitable kill for harness sessions and tasks with liveness-fallback resolution.

`SessionManager.kill()` now returns `Promise<boolean>` that resolves once the
process is **actually gone** — not fire-and-forget. Existing callers that do not
await the return value keep working unchanged.

Resolution is driven by whichever path fires first: node-pty's real `onExit`
event, or a synthesized exit from `kill()`'s own SIGTERM→SIGKILL escalation
fallback (which performs an OS-level pid liveness check after the escalation
window). The promise never hangs: worst-case resolution is
`KILL_ESCALATION_MS + KILL_ESCALATION_CONFIRM_MS` (2500 ms), after which the
process is declared dead via the OS probe regardless of whether node-pty's event
arrived.

`SessionManager.killAll()` is now `async` and resolves when all concurrent kills
have confirmed death. `TaskManager.killAll()` gains the same awaitable treatment
with SIGTERM→SIGKILL escalation and per-task exit promises wired through the
existing `finish()` convergence point.

Server shutdown (`close()` in server/index.ts) now awaits both `killAll()` calls
with a 5-second outer timeout, so the process actually exits cleanly instead of
leaving orphaned agent children.
