---
"@sapiom/agent-core": patch
---

Fall back to a git clone when archives are switched off, not just when absent.

The engine ships with the source-archive flag OFF, so against a freshly deployed
engine every `GET /source` returns 409, not 404. Handling only 404 meant `clone`
failed outright at the exact stage of the rollout that is meant to change nothing.

A 403 still propagates: falling back there would turn a real permission error into
a stale checkout that looks like success.
