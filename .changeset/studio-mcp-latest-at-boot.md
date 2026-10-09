---
"@sapiom/harness-desktop": patch
---

At every launch with an `@sapiom/mcp` already installed, Agent Studio checks the npm registry for a newer release and installs it before any session starts (a first launch installs `latest` directly), so new Sapiom tools reach sessions without a Studio release. It previously refreshed only when the install was a week old, which left sessions on 0.18.0 without `sapiom_dev_map` for days after 0.19.0 shipped. An install older than the copy bundled with the app is never launched.
