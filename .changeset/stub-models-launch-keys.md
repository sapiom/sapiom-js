---
"@sapiom/tools": patch
---

models (stub): `models.launch` now honors the documented override keys. It previously resolved the stale `agent.launch` / `agent.run` spellings — a leftover from the orchestrations→agents rename — so a `models.launch` or `models.run` override was silently ignored by `launch()` (only `run()` honored `models.run`), and the built-in default was returned instead. `launch()` now consults `models.launch` > `models.run` > legacy `agent.launch` / `agent.run`, with the legacy spellings kept honored for back-compat since they were the only working keys before this fix. `models.run()` is unchanged.
