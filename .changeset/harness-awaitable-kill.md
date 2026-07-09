---
"@sapiom/harness": patch
---

Awaitable kill for harness sessions and tasks with liveness-fallback resolution.

`SessionManager.kill()` now returns `Promise<boolean>` that resolves once the
process is **actually gone** — not fire-and-forget. Existing callers that do not
await the return value keep working unchanged.

Resolution is driven by whichever path fires first: node-pty's real `onExit`
event, or a synthesized exit from `kill()`'s own escalation path. The escalation
path is genuinely bounded:

1. SIGTERM sent immediately.
2. After `KILL_ESCALATION_MS` (2000 ms): if still alive, send SIGKILL.
3. After a further `KILL_ESCALATION_CONFIRM_MS` (500 ms): `markExited()` is
   called **unconditionally** — SIGKILL has been sent and the window has
   elapsed, so the session is over regardless of any liveness probe. This
   prevents an EPERM zombie (a process that `isPidAlive` still reports as alive
   after SIGKILL) from leaving the promise pending forever.

`SessionManager.killAll()` is now `async` and resolves when all concurrent kills
have confirmed death via `markExited()` — the single convergence point for real
and synthesized exits alike.

`TaskManager.killAll()` gains the same awaitable treatment with SIGTERM→SIGKILL
escalation and per-task exit promises wired through the existing `finish()`
convergence point. After the SIGKILL confirm window, `finish(id, null)` is
synthesized for any still-registered process — a zombie that never emits an exit
event is declared dead rather than leaving `killAll()` pending forever.
`finish()`'s idempotence guard prevents a double-fire if the real exit event
arrives concurrently.

Server shutdown (`close()` in server/index.ts) now awaits both `killAll()` calls
with a 5-second outer timeout, so the process actually exits cleanly instead of
leaving orphaned agent children.
