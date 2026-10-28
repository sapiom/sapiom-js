---
"@sapiom/agent-core": patch
"@sapiom/sandbox-preview": patch
---

Git clone and push credentials are passed to `git` through the environment
instead of the command line. Credential helpers and interactive prompts are
disabled for those calls, so a rejected credential fails immediately (and
`deploy` still re-mints an expired push credential once). Requires git 2.31 or
newer: an older git now fails with a `GIT_TOO_OLD` error naming the version
instead of an authentication failure. The tokenless URL is pinned against the
user's `insteadOf` rewrites so it keeps using the authenticated HTTPS remote.
