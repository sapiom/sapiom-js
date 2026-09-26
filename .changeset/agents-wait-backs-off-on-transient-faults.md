---
"@sapiom/tools": patch
---

`agents` `wait()` (and so `run`) backs off on a transient status-read fault instead
of ending the wait on it (SAP-3615). The platform rate-limits the agents routes per
client IP and every sandbox shares one egress IP, so ~100 parents polling their
children every 3 s in lockstep were answered `429` — and each `429` failed a parent
run outright (236 of 413 runs in one incident).

A `429`/`408`, any `5xx`, or a transport error (`fetch failed`, `ECONNRESET`,
`ETIMEDOUT`) now makes the loop back off — 2 s, 4 s, 8 s, … capped at 30 s, with up
to 20% upward jitter — and read again. A `Retry-After` header (seconds or HTTP-date)
replaces the computed delay when the platform sends one. A successful read resets
the schedule to `pollMs`. `wait` gives up with `status: "unknown"` (carrying the last
fault) only after **12 consecutive** transient faults, up from 5 at a fixed `pollMs`
cadence; a permanent fault (`404`, `401`/`403`, a malformed body) still resolves
`"unknown"` at once. No back-off outlasts the caller's `timeoutMs`: the deadline is
checked before every sleep and a sleep is clamped to it, and a `"timed_out"` reached
mid-storm now carries the interrupting fault in `error.details` (previously `null`).

The schedule is tunable with a new optional `wait({ retry })` —
`{ initialBackoffMs, maxBackoffMs, maxConsecutiveFaults }`, exported from the root
as `AgentWaitRetryOptions`. `status()` retries a transient fault the same way but
only three times before throwing it; a permanent one still throws at once.

Internally, `TransportHttpError` gains `retryAfterMs` (parsed from `Retry-After`),
and a fault thrown as a plain `Error` in the transport's `… → 429 …` message shape
is classified by that status rather than treated as a socket fault.

From inside a step, `launch` + `pauseUntilSignal` remains the recommended way to
wait on a long child: it makes no poll calls at all, so it cannot be throttled.
