---
"@sapiom/mcp": patch
"@sapiom/harness": patch
"@sapiom/agent-map": patch
---

`@sapiom/mcp` and `@sapiom/harness` now require `@modelcontextprotocol/sdk`
1.32.0 or later within 1.x, the first release that fixes the SDK's published
security advisories. `@sapiom/agent-map` and `@sapiom/harness` no longer depend
on the unused `uuid` package.
