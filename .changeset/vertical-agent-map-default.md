---
"@sapiom/harness": minor
---

Use the Vertical ELK layout by default for Agent Maps in Studio and the desktop app. Remember explicit Classic or Vertical choices across desktop launches, retain the Classic fallback if layout fails, and preserve saved maps and their history when changing views.

Opening a map in Vertical, now the default, loads the bundled ELK worker (about 1.6 MB raw / 467 kB gzip). Classic remains available without loading that worker.
