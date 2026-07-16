---
"@sapiom/harness": patch
---

fix(harness): workspace/workflow rail no longer clips below the fold on first paint

`.rail` was missing `min-height: 0`, so as a grid/flex item it grew to its
content height instead of the grid row's — the nav clipped below the fold and
`.rail-list`'s `overflow-y: auto` never engaged until a reflow (only a hard
refresh appeared to fix it). The rail is now constrained to the viewport and
scrolls internally on the initial render.
