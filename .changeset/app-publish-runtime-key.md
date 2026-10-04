---
"@sapiom/mcp": minor
---

`sapiom_dev_app_publish` sends a sandbox resource's `runtimeKey.permissions` from `sapiom.json` (for example `["org.read", "org.write"]`), so an App Link's injected `SAPIOM_API_KEY` can do what the app needs without a pasted key. The publishing credential must hold every permission named. The result reports the live key's `runtimeKeyPermissions`.
