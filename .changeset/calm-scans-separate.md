---
"@sapiom/harness": patch
---

Separate permanent workspace discovery freshness from legacy System Graph invocation observations while preserving shared watcher ownership. On polling fallback, files covered only by legacy invocation scanning stop triggering session and rail rescans after the legacy graph subscription retires; accepted discovery inputs continue to refresh normally.
