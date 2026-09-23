---
"@sapiom/tools": minor
---

Every error from a Sapiom call that was actually sent now carries
`err.sapiomCall`: the facts about the call that failed (`capability`, `status`,
`retryAfterMs`, `network`). A capability's own input check throws before
anything is sent and carries none.
Read it with the new `readSapiomCall(err)`. These are facts only: nothing in
the SDK decides whether a call is worth retrying, so the rule can change
platform-side without an SDK release or an agent rebuild.

Error classes are unchanged, so `catch (e) { if (e instanceof SearchHttpError) }`
keeps working. Two behavior notes:

- The `sandboxes` methods that threw a bare `Error` on a non-2xx now throw the
  new `SapiomCallError`, a subclass of `Error` with `status` and `body`.
  Messages are unchanged. (`Transport.request` keeps the `TransportHttpError`
  it already throws.)
- Every capability's `ensureOk` is now a wrapper over one shared non-2xx path,
  which also means every capability reads `Retry-After`, not just `sandboxes`.
  `parseRetryAfter` moved from `sandboxes/multipart` into that shared module and
  is still re-exported from its old path. It is also stricter now: delta-seconds
  must be `1*DIGIT` per RFC 9110, and a malformed numeric value is ignored rather
  than passed to `Date.parse`, which used to turn `"1.5"` into a date in 2001.
