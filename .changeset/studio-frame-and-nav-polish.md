---
"@sapiom/harness": patch
"@sapiom/harness-desktop": patch
---

Studio's top bar, rail icon, and window floor:

- While the composer home is up there is no session to name, so the bar's first
  slot carries **Back** (a left arrow) to the session the composer was opened
  over, replacing the inert `💬 new session` pill — and the composer's own
  floating Back, which duplicated it and overlapped the heading on a narrow
  window. With nothing behind the composer (first run, every session closed) the
  slot is empty rather than offering a Back that goes nowhere.
- "Add existing agents" now reads with a folder**+** glyph instead of the open
  folder it shared with the Workspaces header.
- The desktop window refuses to resize below **560×480**: dragged narrower, the
  app became a strip of overlapping labels. The starter-template row also drops
  to one column under 640px, where two cards left the names ellipsized past the
  words that tell templates apart.
