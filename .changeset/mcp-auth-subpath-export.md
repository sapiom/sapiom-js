---
"@sapiom/mcp": minor
---

Add a `./auth` subpath export (`@sapiom/mcp/auth`) re-exporting the browser-OAuth flow (`performBrowserAuth`) and the `~/.sapiom/credentials.json` store (`resolveEnvironment`, `readCredentials`, `writeCredentials`, `clearCredentials`) — for consumers (e.g. `@sapiom/harness`) that want Sapiom's login without importing the MCP server entrypoint, which starts an stdio server as a side effect on import.

The package now declares an `exports` map (`"."` and `"./auth"`); `main`/`types` are unchanged for non-exports-aware consumers, but this does mean a deep import like `@sapiom/mcp/dist/auth.js` is no longer resolvable — use `@sapiom/mcp/auth` instead.
