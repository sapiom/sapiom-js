---
"@sapiom/harness": patch
---

Register successfully scaffolded agents immediately under their creating Studio
project, including folders beside its root. Preserve the project's existing
conversation when selecting those agents, and restore membership from recorded
scaffold completions on restart without moving files or creating extra sessions.

Accept native Codex timed MCP results and relative scaffold targets while preserving exact creator-path and project ownership checks. Previously recorded successful Codex completions recover membership on restart.

Keep an explicitly selected archived conversation when selecting its project's created agents after restart. Remember that conversation across browser reloads only while its exact session ID remains in the server's state, without resuming a runtime, creating a session, or replaying input. Existing browser preferences remain compatible; absent or stale conversation selections use the existing live-session fallback.
