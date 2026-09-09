---
"@sapiom/agent": minor
"@sapiom/agent-runtime": minor
---

feat: add `timeoutStep` for in-workflow pause timeouts

A pause can now declare a `timeoutStep`: `pauseUntilSignal({ signal, resumeStep, timeoutMs, timeoutStep })` (with a matching `pause: { …, timeoutStep }` on the step). When `timeoutMs` elapses with no signal, the engine resumes the run at `timeoutStep` with a branded `PauseTimeoutPayload` as its input (narrow with `isPauseTimeout`) instead of failing the run — making the "wait for an event, otherwise proceed/escalate after N" pattern expressible in-workflow.

Fully backward compatible: a pause with `timeoutMs` but no `timeoutStep` still fails with `PauseTimeoutError`, and the runtime store method that performs the resume (`resumeAtTimeoutStep`) is an optional capability — hosts that don't implement it fall back to the fail path.
