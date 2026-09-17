---
"@sapiom/agent": minor
---

Add the retryable direction of the closed step-error contract: a Sapiom-surface
call that failed transiently.

`isTransientSapiomCall(facts)` is the single versioned rule (5xx, 429, 408, or a
connection that never produced a response). `toRetryableStepErrorPayload(error,
facts)` builds the canonical wire payload from it, and
`parseRetryableStepErrorPayload` / `isRetryableStepErrorPayload` read it back on
the host side:

```json
{
  "name": "SearchHttpError",
  "message": "Failed to search: 503 ...",
  "code": "SAPIOM_CALL_TRANSIENT",
  "version": 1,
  "retryable": true,
  "status": 503,
  "capability": "web.search",
  "retryAfterMs": 2000
}
```

The facts are passed in rather than read here: `@sapiom/tools` owns the marker
on the error, this package owns the rule, and the host composes the two. A
deterministic failure (4xx) returns `undefined` and ships as a legacy error with
no disposition field, so nothing about today's retry behavior changes.
