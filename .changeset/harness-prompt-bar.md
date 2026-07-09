---
"@sapiom/harness": minor
---

Add chat-style prompt bar beneath the terminal pane

A persistent input bar now sits below the xterm.js terminal in the center pane,
giving users a typed-input surface alongside the raw terminal for both
claude-code and codex sessions.

- Enter submits; Shift+Enter inserts a newline; textarea auto-grows up to six lines
- Submits via the existing POST /api/sessions/:id/input endpoint
- Proactively disabled (with visible reason) when session.ready is false or status is "starting"
- Reactively surfaces 409 "session not ready" errors inline without losing draft text
- Re-enables automatically when the session becomes ready via the event bus
- No focus stealing: the bar never auto-focuses; after a successful submit focus returns to the bar for rapid follow-up prompts
- Fully accessible: aria-disabled, aria-labelledby, aria-describedby, role="status" on the reason text
- Identical presentation and behaviour for claude-code and codex sessions
