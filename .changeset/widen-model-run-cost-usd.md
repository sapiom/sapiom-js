---
"@sapiom/tools": minor
---

**Breaking (type-level):** `ModelRunOutcome.costUsd` is now `number | null`.

The platform doesn't report a cost estimate for every run, so `costUsd` could
already arrive as `null` at runtime — the published type said `number` and left
no room for it.

Under `strictNullChecks`, code that does arithmetic on or formats
`result.costUsd` now fails to compile until it guards (`outcome.costUsd ?? 0`,
or skip the row). Read-only and logging code is unaffected, and nothing changes
at runtime for a run that does report an estimate.

Both delivery paths land the same encoding: a polled result and a step resumed
via `pauseUntilSignal` both give you `null` — never `undefined`, never a
fabricated `0` — when no estimate was reported.

`costUsd` is an estimate, not a billed amount; don't reconcile invoices against
it.
