---
"@sapiom/harness": patch
"@sapiom/opencode": patch
---

The project map chat no longer edits files: `noShell` now also denies OpenCode's `edit`, `write` and `apply_patch` tools, and the map chat sends every change request to the `handoff` card instead. Studio session Assistants are unchanged. Adding a project to Studio now marks its folder trusted for Claude Code (`projects[<root>].hasTrustDialogAccepted` in Claude Code's global config, written under Claude Code's own config lock, only for that folder), and a Claude Code session started inside an added project makes sure of it before it launches, so hand-off and Open in session sessions start without the "trust this folder?" prompt.
