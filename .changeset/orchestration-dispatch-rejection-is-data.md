---
"@sapiom/tools": minor
"@sapiom/agent-core": patch
---

Fix `agents.run`/`agents.launch` reporting a REFUSED DISPATCH — an unknown slug (404),
input the engine's pre-gate rejects (400), a transport fault — by throwing an untyped
error out of the calling step. Because a step throw feeds the engine's retry machinery,
a coordinator dispatching several children by slug lost its whole run to one typo: the
step retried a deterministic failure to `maxAttemptsPerStep` and then failed.

The two entry points now report it according to what each returns:

- **`run` resolves it as data** — `status: "rejected"`, `executionId: null`, and a
  structured `AgentRunError` (`{ code, message, status, details }`) whose `details`
  keeps the platform's own response body. Its result is already discriminated on
  `status`, and a coordinator treats "the child failed" and "the child never started"
  as one fact, so `if (result.status !== "completed")` stays the single branch and no
  try/catch is needed.

  `"rejected"` is deliberately narrow: it promises nothing is running, so it is used
  only when the platform's answer proves nothing was created (404, 400/422, 401/403).
  A 5xx, or a response lost after the platform accepted the request, may have created
  a child whose id never came back — those resolve `"unknown"` with a `null`
  `executionId`, so re-dispatch guidance stays safe.
- **`launch` throws `AgentDispatchError`** (exported from the package root, with
  `.code`, `.status`, `.details`, and `.toRunError()`). It owes the caller a pausable
  handle, and a dispatch that created no child has none — a handle with a null
  `executionId` that cannot be paused on would misrepresent itself. Catch it and
  `fail()` the step. Uncaught it is an ordinary step throw, so it still retries to the
  cap; making it terminal-without-retry needs the engine's non-retryable error set to
  admit it, which is separate work. The error's `childMayExist` draws the same
  proven-vs-ambiguous distinction as the `"rejected"`/`"unknown"` split, so a `launch`
  caller can tell whether a retry is safe.

`wait()` no longer throws. Hitting `timeoutMs` resolves `status: "timed_out"`; a status
read the platform refuses, or one that keeps faulting, resolves `status: "unknown"`.
Both keep `executionId`, because the run exists and can be checked on later. A
transient 5xx, 408, 429 or transport fault is ridden out for a few consecutive polls
before `"unknown"`, rather than spending the whole `timeoutMs` on doomed requests — and
a single rate-limit answer no longer ends an hour-long wait.

Of the three new statuses only `"rejected"` means nothing is running, so it is the only
one on which re-dispatching is safe. `"unknown"` and `"timed_out"` name a child that may
still be working — retry those with an `idempotencyKey` or not at all.

**Breaking.** A refused dispatch used to throw out of `run`; it now resolves. If you
branch on `status === "failed"`, change it to `status !== "completed"` — otherwise a
rejected dispatch falls straight through that branch and feeds `output: null`
downstream instead of failing loudly. The old surface documented `status` as
`"completed" | "failed"`, so that spelling was the documented one. `launch` still
throws, now with a typed error instead of a bare `Error`.

Also breaking at the type level, and a no-op for code that already branches on
`status !== "completed"`: `AgentRunResult.executionId` and `RunHandle.executionId` widen
to `string | null` (a delayed `launch({ at })` handle now reports `null` rather than
`""`), and `AgentRunResult.status` widens from `ExecutionStatus` to `AgentRunStatus`,
adding `"rejected"`, `"unknown"` and `"timed_out"`. `RunHandle` still `extends
DispatchHandle`, so every handle you receive is pausable.

`AgentRunSpec`, `AgentRunResult`, `AgentRunStatus`, `AgentRunError`, `AgentRunErrorCode`,
`AgentRunHandle`, `AgentExecutionStatus` and `AgentDispatchError` are now exported from
the package root, matching the `models` equivalents.

In `createStubClient` (and so `run_local`), `agents.launch` resolves through the
overrides — `agents.launch` then the shared `agents.run`, merged over the built-in
defaults, matching `models.coding.launch`. It previously built a completed run
unconditionally, so the try/catch the docs require was impossible to cover in a local
test. A stubbed `{ status: "rejected" }` throws from `launch` and resolves from `run`,
mirroring the real split; `{ status: "failed" }` covers a child that ran and failed, and
the resume payload a paused step receives follows the stubbed status. A partial
`{ status: "rejected" }` fills in a real `AgentRunError` (so `result.error.code` reads
the same under the stub as in production), a function override returning a promise is
awaited, and a delayed `launch({ at })` returns production's shape — `executionId: null`
with a trigger correlation id.
