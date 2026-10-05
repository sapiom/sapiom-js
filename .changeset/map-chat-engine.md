---
"@sapiom/harness": patch
"@sapiom/opencode": patch
---

Add the project map-chat engine: an OpenCode host per project (`map:<projectId>`) whose conversation persists across restarts, Stop and New chat routes, a `handoff` tool the model uses to offer a Claude Code session, and a `neverAsk` config option that denies every permission prompt. The map chat stops after 15 idle minutes. Sessions are no longer bound to an agent automatically when a rescan finds one under their folder.
