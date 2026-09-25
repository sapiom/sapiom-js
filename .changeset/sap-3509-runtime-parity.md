---
"@sapiom/agent-runtime": patch
"@sapiom/agent-core": patch
---

`serializeStepCompletionError(error, facts?)` takes the facts a Sapiom-surface
call recorded about its own failure, and the protocol-1 completion schema
accepts the resulting retryable payload alongside the terminal ones. The local
dispatcher passes `readSapiomCall(error)`, so a transient failure looks the same
under `run_local` as it does in a deployed run. Called without `facts`, the
serializer behaves exactly as before.
