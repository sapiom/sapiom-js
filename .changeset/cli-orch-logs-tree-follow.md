---
"@sapiom/cli": minor
---

`agents logs`: render an execution as a tree with per-node cost (captured primary, authorized ceiling — never collapsed) and add a `--follow`/`--watch` live mode that streams updates until the run reaches a terminal status. `agents logs` (no argument) now renders recent executions tree-aware, grouped by `traceRoot`. A `--verbose` flag adds step timings and dispatch details.
