---
"@sapiom/harness": minor
---

Keep Agent Studio Project dependency graphs current with revisioned lifecycle snapshots, per-agent relationship caching, and last-good stale or degraded presentation during refresh failures. Opening a Project graph arms one additional session-independent recursive watcher for that Project; inventory fingerprints and the polling fallback run asynchronously so wide Projects do not block the Studio server loop.
