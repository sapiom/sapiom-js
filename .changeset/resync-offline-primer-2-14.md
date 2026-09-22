---
"@sapiom/mcp": patch
---

Re-sync the offline `AUTHORING_INSTRUCTIONS` fallback with the served 2.14 primer (SAP-3178,
SAP-3217). The fallback had stayed on the 2.10 body while the backend shipped four content
releases, so a session whose startup fetch of `GET /v1/mcp/instructions` failed never saw them:
2.11 (Vault semantics, `ctx.sapiom.agents.launch`, receipts and replay, App Link webhooks), 2.12
(the two servers named by role, and the App Link management tools `sapiom_dev_app_list` /
`_settings` / `_delete` taught inside the webhook paragraph), 2.13 (a Sapiom Postgres is
permanent), and 2.14 (an App Link is a redirector, not a reverse proxy, plus the `/hook/*`
exposure caveats). The tools themselves shipped in 0.15.0; this moves only the offline copy of
the text that teaches them. The digest pin now matches the backend's `SAPIOM_JS_FALLBACK_DIGEST`.
