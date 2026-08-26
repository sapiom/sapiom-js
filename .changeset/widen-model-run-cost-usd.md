---
"@sapiom/tools": minor
---

`ModelRunOutcome.costUsd` is now `number | null` — the type told a lie.

The platform already sends `cost_usd: null` on a bounded set of runs, where the
stored estimate came from a source it will not stand behind and the honest
figure is unrecoverable. The published type said `number`, so a strict consumer
could do `outcome.costUsd.toFixed(2)` on a value that was `null` at runtime.
The mapper now lands a wire `null`, a missing key, and a malformed value all on
`null` — one encoding, never a fabricated `0` that would read as "this run was
free".

**Strictness impact:** under `strictNullChecks`, code that does arithmetic on or
formats `result.costUsd` will now fail to compile until it guards —
`outcome.costUsd ?? 0`, or skip the row. That is the point: the runtime `null`
was already reaching those call sites. Code that only reads or logs the value is
unaffected.

Worth guarding rather than defaulting: `costUsd` is a size×lane **estimate**,
not the amount you are billed. Billed cost belongs to the metering rail (plan
allowance + priced overage), and this field is deprecated as an authoritative
dollar figure.
