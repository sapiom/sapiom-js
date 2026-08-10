---
"@sapiom/harness": minor
---

Studio: a new agent's workspace folder now appears in the rail the instant you
start creating it — from the composer or a template — as an optimistic
"Creating agent…" row, pinned to the top and focusable. It stays put through
session-landing and the clone, and across the brief window after the session
binds but before its `sapiom.json` is registered, so switching sessions
mid-creation can never strand the in-progress agent.

Also fixes two rail/canvas issues:

- **Canvas no longer clips the terminal step.** A revise loop (a step pointing
  back to an earlier one) left a gap in the layer numbering; the SVG height was
  derived from the layer *count* while nodes were positioned by their raw layer
  *index*, so the deepest node (a terminal like `deliver`) fell below the
  viewBox and was drawn off-screen with a dangling edge. Rows are now compacted
  to consecutive positions, which also removes the empty band the gap produced.
- **Cloned agents show a short name in the rail.** The row now reads
  `newsletter-autopilot` rather than the full package name
  `@sapiom/example-newsletter-autopilot` (npm scope and a leading `example-`
  stripped for display only — the full name is on hover, and the raw name still
  keys testids and lookups).
