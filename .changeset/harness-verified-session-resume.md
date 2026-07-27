---
"@sapiom/harness": patch
---

Verify resumability before offering Resume, so no past-session row is a button that's guaranteed to fail (SAP-2057).

A row's Resume badge was `agentSessionId != null` — "our SessionStart hook fired once", not "the agent still has this conversation". Since neither Claude Code nor Codex writes any transcript for a session that never received a prompt, one in three registry rows on a real machine (16 of 49 measured) offered Resume and answered with `No conversation found with session ID: …`, exit 1, and a dead pane offering Resume again. Transcript-only rows had the inverse bug: hardcoded un-resumable even when the transcript was right there, so opening one silently started a fresh session and dropped the conversation.

- `HarnessAdapter` gains `canResume(agentSessionId, cwd)` (never throws): one `stat` on the encoded transcript path for claude-code, a `session_meta` id+cwd match for codex.
- `SessionSummary` gains `resumeMode: "agent-resume" | "rehydrate"`, resolved server-side in `GET /api/sessions/history` for both row sources. Adapters now return `PastSessionRecord`, so they can't decide it themselves.
- `SessionManager.resume()` pre-flights `canResume()` and throws `SessionNotResumeableError` (409, with a reason naming the agent) instead of spawning a doomed pty.
- New `POST /api/sessions/adopt` wires up `registerHistorical()`: a transcript-only row whose conversation the agent really holds is adopted into the registry and genuinely resumed. The server re-verifies resumability itself, and the route is idempotent.
- Truthful durations: a resume that never reaches a live pty no longer stamps `lastActiveAt`, so an idle session stops reporting "Ran for 6h 25m" after a failed Resume, and `formatDuration` returns null on a zero span instead of inventing "under a minute".
- UI: rows render the verified `resumeMode` (`resumable` / `archived`, `checking…` until known); the dead pane and past-session pane disable Resume with the real reason instead of a generic one.
