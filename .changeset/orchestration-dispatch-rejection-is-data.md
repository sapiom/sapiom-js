---
"@sapiom/tools": minor
"@sapiom/agent": minor
"@sapiom/agent-core": patch
---

Make `agents.run`/`agents.launch` honor their documented "failure is data, does not
throw" contract when the DISPATCH itself is refused. An unknown slug (404), input the
engine's pre-gate rejects (400), and a transport fault no longer throw out of the
calling step — they resolve an `AgentRunResult` with `status: "rejected"`,
`executionId: null`, and a structured `AgentRunError` (`{ code, message, status,
details }`) whose `details` keeps the platform's own response body. A coordinator
dispatching several children by slug can branch on one bad child instead of failing
the whole run; `if (result.status !== "completed")` remains the single branch.

`wait()` no longer throws either: hitting `timeoutMs` resolves `status: "timed_out"`
(keeping `executionId`, so the run can be checked on later), a 4xx while reading the
run's status resolves `"rejected"`, and a transient 5xx/transport fault keeps polling
until the deadline.

A rejected `launch` still returns a handle, but one carrying no `dispatch` — nothing
exists to fire the resume signal — with the rejection readable as `handle.rejection`.
`pauseUntilSignal` now accepts such a handle and rejects with a pointed error instead
of pausing the step on a signal that never arrives.

Types: `AgentRunResult.executionId` and `RunHandle.executionId` widen to
`string | null`, and `AgentRunResult.status`/`RunHandle.status()` widen from
`ExecutionStatus` to `AgentRunStatus` (adds `"rejected"` and `"timed_out"`). Code that
already branches on `status !== "completed"` is unaffected. `Transport.request` now
throws a `TransportHttpError` carrying the status and parsed body (same message text
as before). The agent-authoring skill and the `agents` README document the statuses.
