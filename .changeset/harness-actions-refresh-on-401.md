---
"@sapiom/harness": patch
---

Extend the expired/rotated API key recovery to the Deploy and Prod-run actions. When one of these actions is rejected as unauthorized, the Studio now re-reads your cached credentials and retries once — so signing in again (in the CLI or elsewhere) unblocks Deploy/Prod-run in place, matching the live-run status path, instead of every action staying stuck on the stale key until a restart.
