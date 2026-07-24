---
"@sapiom/harness": patch
---

Add a run-input dialog to Local Run and Prod Run. Clicking either now opens a small JSON editor — prefilled from the entry step's declared input fields (or your last-used input for that workflow) — so you can supply the run input before it fires, instead of always running with an empty `{}`. This makes agents whose entry step requires input (e.g. a `topic`) runnable straight from the Studio's run buttons.
