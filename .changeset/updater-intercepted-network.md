---
"@sapiom/harness-desktop": patch
---

Update checks now say when github.com is not reachable from the current network (a proxy or sign-on page answered instead of GitHub) and what to check, instead of reporting a GitHub rate limit, a bare "403 Forbidden", or "no release published yet". The updater log records the response status, server and content-type for support.
