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
the whole run.

`wait()` no longer throws either. Hitting `timeoutMs` resolves `status: "timed_out"`.
A status read the platform refuses, or one that keeps faulting, resolves
`status: "unknown"`. Both keep `executionId`, because the run exists and can be
checked on later; a transient 5xx or transport fault is ridden out for a few
consecutive polls before `"unknown"` is returned, rather than spending the whole
`timeoutMs` on doomed requests.

Of the three new statuses only `"rejected"` means nothing is running, so it is the
only one on which re-dispatching is safe. `"unknown"` and `"timed_out"` name a child
that may still be working — retry those with an `idempotencyKey` or not at all.

A rejected `launch` still returns a handle, but one carrying no `dispatch` — nothing
exists to fire the resume signal — with the rejection readable as `handle.rejection`.
`pauseUntilSignal` now accepts such a handle and rejects with a pointed error instead
of pausing the step on a signal that never arrives.

**Breaking.** A refused dispatch used to throw; it now resolves. If you branch on
`status === "failed"`, change it to `status !== "completed"` — otherwise a rejected
dispatch falls straight through that branch and feeds `output: null` downstream
instead of failing loudly. The old surface documented `status` as
`"completed" | "failed"`, so that spelling was the documented one.

Also breaking at the type level, and a no-op for code that already branches on
`status !== "completed"`: `AgentRunResult.executionId` and `RunHandle.executionId`
widen to `string | null` (and a delayed `launch({ at })` handle now reports `null`
rather than `""`); `AgentRunResult.status` and `RunHandle.status()` widen from
`ExecutionStatus` to `AgentRunStatus`, which adds `"rejected"`, `"unknown"` and
`"timed_out"`; `RunHandle.dispatch` becomes optional and gains a sibling
`rejection?`.

`AgentRunSpec`, `AgentRunResult`, `AgentRunStatus`, `AgentRunError`,
`AgentRunErrorCode`, `AgentRunHandle` and `AgentExecutionStatus` are now exported
from the package root, matching the `models` equivalents — previously they were
reachable only through the `agents` namespace. The agent-authoring skill and the
`agents` README document the statuses and which of them are safe to retry.
