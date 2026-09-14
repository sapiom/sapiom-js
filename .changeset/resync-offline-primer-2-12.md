---
"@sapiom/mcp": patch
---

Re-sync the offline `AUTHORING_INSTRUCTIONS` fallback with the served 2.12 primer: the App Link
management tools (`sapiom_dev_app_list` / `_settings` / `_delete`, `@sapiom/mcp` >= 0.15) are
now taught inside the App Link webhook paragraph, whose "no `sapiom_dev_*` tool sets it yet"
clause is retired, on top of the 2.11 additions (Vault semantics, `ctx.sapiom.agents.launch`,
receipts and replay, App Link webhooks) that an offline session was not yet receiving.
