---
"@sapiom/mcp": patch
---

Remove dead capability tools and drop the legacy `@sapiom/core` + `@sapiom/fetch` dependencies.

The `sapiom_verify_*` and `sapiom_create_transaction_api_key` tools were never registered on the server and belong to the remote Sapiom capability MCP, not this local developer MCP. They were the only consumers of `@sapiom/core`/`@sapiom/fetch`, so both dependencies are now removed. No change to the tools this server actually exposes (`authenticate`, `status`, `agents`).
