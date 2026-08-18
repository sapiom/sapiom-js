---
"@sapiom/tools": patch
---

models (stub): `models.launch` now honors the documented override keys. It previously resolved only the stale `agent.launch` / `agent.run` spellings — stranded by the agent→models half of the #167 rename — so a `models.launch` or `models.run` override was silently ignored by `launch()` (only `run()` honored `models.run`) and the built-in default was returned instead. `launch()` now consults `models.launch` > `models.run` > legacy `agent.launch` > `agent.run`; the legacy spellings stay honored for back-compat but now add a warning to the `warnings` sink (they sit one character from the unrelated `agents.*` namespace).

The launch path also merges the override **over** the built-in defaults instead of using it verbatim: a partial stub (e.g. `{ "output": "..." }`, the documented minimal shape) keeps `status` / `error` / `result` filled so `handle.status()` works and the resume payload stays schema-valid; a function override returning a Promise is awaited; and an author-supplied `runId` is preserved across `wait()` and the resume correlation (in the real client `run()` *is* `launch().wait()`, so both paths agree on the id). `models.run()` is unchanged (verbatim, as before).
