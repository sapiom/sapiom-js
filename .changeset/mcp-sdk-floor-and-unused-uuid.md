---
"@sapiom/mcp": patch
"@sapiom/harness": patch
"@sapiom/agent-map": patch
---

Dependency maintenance: `@sapiom/mcp` and `@sapiom/harness` now require
`@modelcontextprotocol/sdk` 1.32.2 or later within 1.x, and `@sapiom/agent-map`
and `@sapiom/harness` no longer depend on the unused `uuid` package.
