---
"@sapiom/harness": patch
---

Enrich the step debug/explain context with the run's real per-step evidence. When you ask the agent to debug or explain a step from the run inspector, the injected context now folds in the step's actual input and output, the capabilities it called (with a marker for any served by a stub), and — for offline runs — supplied stubs that matched nothing or carried the wrong shape, on top of the step's status, latency, error, and logs. Every section is emitted only when the trace carries it (no fabricated placeholders), and the context names capabilities, never a model, so "why did this step do X" carries the real evidence instead of just the step name.
