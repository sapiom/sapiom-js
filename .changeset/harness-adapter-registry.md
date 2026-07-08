---
"@sapiom/harness": minor
---

Add the harness adapter registry: a `HarnessAdapter` contract whose embedded/external split is enforced at the type level (external adapters have no spawn path), `getAdapter`/`listAdapters` over a data-driven registry (`createHarnessRegistry`), a fully supported Claude Code adapter (interactive launch with literal-argv system-prompt append, post-launch prompt delivery, pure-Node PATH detection incl. PATHEXT on Windows), experimental scaffold adapters for codex/pi/opencode, an external companion adapter for Conductor, and per-harness `installMcpPrompt()` guidance for setting up the Sapiom MCP server (`@sapiom/mcp`).
