---
"@sapiom/harness": patch
---

Restore the `resolveCoreBaseUrl` helper that the actions router relies on to derive the core API base URL. It is now co-located with `resolveAgentsBaseUrl` (its only dependency) instead of living in a since-removed module, so the harness server builds and the actions router self-defaults its base URL again.
