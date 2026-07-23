---
"@sapiom/harness": patch
---

Restore the bundled demo canvas document (`web/public/canvas/sess-boot/`) the
Studio's mock/demo mode renders on first paint. The web app already references
it (the demo session opens on its seeded board), but the file was missing, so
the canvas pane stayed empty in demo mode. This is demo/mock-only content; real
local mode still renders the server-generated canvas.
