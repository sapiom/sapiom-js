---
"@sapiom/harness": minor
---

Add trusted child-session creation, recovery and closure with exact binding checks, plus exclusive Codex rollout attribution for simultaneous runtimes. Failed launches retain retryable ownership, and finished discovery releases pending runtime registrations.

The SessionManager returned by startServer exposes the owned-session lifecycle methods. Callers can handle the public SubsessionBindingMismatchError when an operation does not match its coordinator binding and SubsessionFreshRestartForbiddenError when a fresh restart would overwrite a recorded or explicitly closed conversation. The close() operation must be awaited because durable closure bookkeeping can reject.
