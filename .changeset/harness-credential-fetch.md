---
"@sapiom/harness": minor
"@sapiom/analytics-core": minor
---

Agent Studio now sends the tenant API key through the shared credential policy: plain http to a non-loopback Sapiom host is refused (Agents and core panels, the Assistant bridge, and the MCP config written for Claude Code and Codex), and the key is dropped on a redirect to another origin. `https://` and `localhost` are unchanged. For a trusted private network, opt in with `SAPIOM_ALLOW_INSECURE_HTTP=1`.

`@sapiom/analytics-core/credential` adds an `"authorization"` credential header (for Bearer APIs) and `credentialHeaders()`, which checks a URL before a credential is handed to another process.
