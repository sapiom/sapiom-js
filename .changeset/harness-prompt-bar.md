---
"@sapiom/harness": patch
---

Terminal-only center pane for v0

The center pane renders the xterm terminal as the sole content when a session
is live, and the exited-session overlay (resume / close) when the session has
exited. The first-run welcome panel continues to appear when no session exists
on a fresh install.

- Analytics hook pipeline (SessionStart / UserPromptSubmit / PreToolUse /
  PostToolUse / Stop / SessionEnd → /ingest → normalizer → store + emitter →
  collector) is fully intact and independent of the center-pane shape
- Skills panel, canvas, consent chip, telemetry, adapter registry, session
  kill/resume, and typed errors are all preserved
