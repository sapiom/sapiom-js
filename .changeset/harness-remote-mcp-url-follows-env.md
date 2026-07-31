---
"@sapiom/harness": patch
---

fix(harness): remote `sapiom` MCP URL follows `SAPIOM_ENVIRONMENT`

The injected remote `sapiom` MCP server URL was hardcoded to production
(`https://api.sapiom.ai/v1/mcp`), so running against a non-prod environment
minted auth against `api.sapiom.dev` but sent remote tool calls to
`api.sapiom.ai` — every call 401'd. The URL is now derived from the resolved
environment via `resolveEnvironment`, so `SAPIOM_ENVIRONMENT=dev`/`staging`
points at `https://api.sapiom.dev/v1/mcp`, with production remaining the
default.
