---
"@sapiom/harness": patch
---

Attach generated Sapiom MCP configuration to Codex sessions on launch and resume, using session-specific server names and environment-based credentials while preserving existing Codex settings. Invalid or unreadable generated configuration now reports a launch error instead of silently starting without MCP servers.
