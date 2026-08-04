---
"@sapiom/harness": patch
"@sapiom/mcp": patch
---

Standardize MCP client aliases: use `sapiom` for local authoring and
`sapiom-direct` for the hosted capability connection while preserving the
local server's `sapiom-dev` wire identity and `sapiom_dev_*` tool namespace.
