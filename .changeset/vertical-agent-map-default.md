---
"@sapiom/harness": minor
---

Replace the previous Agent Map layout with Vertical ELK in Studio and the desktop app. All existing maps use the new layout without regenerating their nodes, connections, or history. Remove the layout selector and earlier layout preferences. A failed layout can be retried without changing saved maps.

Opening a map loads the bundled ELK worker (about 1.6 MB raw / 467 kB gzip).
