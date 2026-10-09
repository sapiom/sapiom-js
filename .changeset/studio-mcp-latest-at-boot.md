---
"@sapiom/harness-desktop": patch
---

Agent Studio now checks the npm registry for a newer `@sapiom/mcp` at every launch and installs it before any session starts, so new Sapiom tools reach sessions without a Studio release. It previously refreshed only when the install was a week old, which left sessions on 0.18.0 without `sapiom_dev_map` for days after 0.19.0 shipped. An install older than the copy bundled with the app is never launched.
