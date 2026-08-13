---
"@sapiom/harness": patch
---

Canvas: open the right pane when a real step graph renders, not when scaffolding is written

A canvas WRITE is not a canvas RESULT. The pane revealed itself on every
`canvas.reload`, and the "Preparing your agent — installing dependencies"
placeholder written while npm runs is exactly such a write — so a fresh
scaffold popped the pane open on setup state and presented it as the result
(the server's "Rendering agent diagram…" pending document does the same to the
mount probe).

The reveal now waits for the document to post `sapiom-canvas:graph`, which only
a real render embeds and the placeholders deliberately omit. Nothing is
deferred but the reveal: a collapsed pane is hidden with `display:none`, never
unmounted, so the iframe still loads and swaps its document in the background
and the board is there the instant it is worth showing. Absence of content is
still announced immediately, so an empty pane still hides itself.
