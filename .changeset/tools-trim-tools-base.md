---
"@sapiom/tools": patch
---

Trim a trailing slash from `SAPIOM_TOOLS_BASE` (and the `SAPIOM_AGENTS_URL` / `SAPIOM_MODELS_URL` overrides) before appending routes. `https://tools.example/` previously produced `//connectors/v1/...` in every module except the Google connector.
