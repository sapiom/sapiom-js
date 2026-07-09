---
"@sapiom/harness": patch
---

Chat-first center pane with prompt composer (ChatView + PromptBar)

The center pane now defaults to a chat conversation view (ChatView) with a
prompt composer (PromptBar) anchored at its bottom. The xterm terminal is
available as a secondary tab and stays mounted via CSS keep-alive so the
connection survives tab flips without reconnecting.

- Chat turn list renders user bubbles and streamed assistant responses with
  safe markdown (bold, italic, inline code, fenced blocks, headings, lists,
  blockquotes — no dangerouslySetInnerHTML)
- Tool-call chips appear inline as the agent runs tools; status transitions
  (start → ok | error) animate in place
- Attention banner surfaces when the agent is blocked on a permission prompt
  (Notification hook), with a link to the Terminal tab
- PromptBar composer: Enter submits; Shift+Enter inserts a newline; textarea
  auto-grows up to six lines; per-session draft state survives tab switches
- Proactively disabled (with visible reason) when session.ready is false or
  status is "starting"
- Reactively surfaces 409 "session not ready" errors inline without losing
  draft text; re-enables automatically when the session becomes ready
- Fully accessible: aria-disabled, aria-labelledby, aria-describedby,
  role="status" on the reason text
- Identical presentation and behaviour for claude-code and codex sessions
