---
"@sapiom/tools": minor
---

Every error thrown by a Sapiom call now carries `err.sapiomCall`: the facts
about the call that failed (`capability`, `status`, `retryAfterMs`, `network`).
Read it with the new `readSapiomCall(err)`. These are facts only: nothing in
the SDK decides whether a call is worth retrying, so the rule can change
platform-side without an SDK release or an agent rebuild.

Error classes are unchanged, so `catch (e) { if (e instanceof SearchHttpError) }`
keeps working. Two behavior notes:

- The 15 call sites that threw a bare `Error` on a non-2xx (`Transport.request`,
  and a handful of `sandboxes` methods) now throw the new `SapiomCallError`, a
  subclass of `Error` with `status` and `body`. Messages are unchanged.
- Every capability's `ensureOk` is now a wrapper over one shared non-2xx path,
  which also means every capability reads `Retry-After`, not just `sandboxes`.
  `parseRetryAfter` moved from `sandboxes/multipart` into that shared module and
  is still re-exported from its old path.
