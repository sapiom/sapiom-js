---
"@sapiom/agent": minor
"@sapiom/agent-runtime": minor
"@sapiom/agent-core": patch
"@sapiom/harness": patch
---

feat: add `timeoutStep` for in-workflow pause timeouts

A pause can now declare a `timeoutStep`: `pauseUntilSignal({ signal, resumeStep, timeoutMs, timeoutStep })` (with a matching `pause: { …, timeoutStep }` on the step). When `timeoutMs` elapses with no signal, the engine resumes the run at `timeoutStep` with a branded `PauseTimeoutPayload` as its input (narrow with `isPauseTimeout`) instead of failing the run — making the "wait for an event, otherwise proceed/escalate after N" pattern expressible in-workflow.

Fully backward compatible: a pause with `timeoutMs` but no `timeoutStep` still fails with `PauseTimeoutError`, and the runtime store method that performs the resume (`resumeAtTimeoutStep`) is an optional capability — hosts that don't implement it fall back to the fail path, and `ExecutionState.pausedTimeoutStep` is optional so their `loadExecution` keeps type-checking.

`timeoutStep` travels through the step-completion wire contract (`pause_until_signal` in protocol 1) and the local dispatcher, a timed pause must name the `timeoutStep` its step declares, and the Studio map draws the timeout branch as its own edge.
