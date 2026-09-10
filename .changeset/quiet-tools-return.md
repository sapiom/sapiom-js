---
"@sapiom/harness": patch
"@sapiom/opencode": patch
---

Preserve MCP replay cursors and optional-stream protocol responses so queued tool results arrive without repeating the original tool call. Use the pinned OpenCode runtime's native Code Mode to retain full MCP discovery without sending every remote tool schema with each model request.
