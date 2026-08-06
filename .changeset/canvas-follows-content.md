---
"@sapiom/harness": patch
---

Studio's canvas pane now simply follows the active session's board: whenever a
session has a rendered board, the pane is shown; when it doesn't, it stays
closed. This replaces the previous auto-reveal, which fired only once and only
for sessions born from the composer — so a resumed session that built an agent,
or opening an already-populated agent, left the freshly-rendered board sitting
in a collapsed pane the user had to open by hand.

Now any live render (a `canvas.reload` for the active session — a finished
build, a re-render) opens the pane on its own, and switching to a populated
session shows its board straight away. Trade-off of the simpler model: a manual
collapse of the canvas is no longer a persisted arrangement — it lasts until the
next render or session switch (the rail collapse and the Canvas/Steps/Code tab
still persist). Exited sessions keep their pane open for the "resume to see it"
invite.
