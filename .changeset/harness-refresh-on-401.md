---
"@sapiom/harness": patch
---

Recover from an expired or rotated API key instead of getting stuck. When a live-run status request is rejected as unauthorized, the Studio now re-reads your cached credentials and retries once, so signing in again (in the CLI or elsewhere) unblocks the app in place rather than requiring a restart. Studio actions always authenticate with your held API key.
