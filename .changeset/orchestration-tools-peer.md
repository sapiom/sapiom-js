---
"@sapiom/orchestration": patch
---

Depend on `@sapiom/tools` with a caret range (`^0.1`) instead of an exact
version. The dependency was declared `workspace:*`, which publishes as the exact
resolved version — so `@sapiom/orchestration@0.1.2` carried a hard `0.1.2` pin and
forced a second copy of `@sapiom/tools` whenever a project used a newer patch
(e.g. tools `0.1.3`), producing duplicate nominal types and `tsc` errors. A caret
range lets the consumer's own `@sapiom/tools` (any `0.1.x`) satisfy and dedupe to
a single copy, while still pulling tools in transitively so authoring types
resolve out of the box.
