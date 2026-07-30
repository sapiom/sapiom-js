---
"@sapiom/harness": patch
---

The macros API (`POST /api/macros/:id/run`) no longer executes the `deploy`, `prod_run`, or `run_local` ids — those run through the Studio's direct API. This closes the terminal-inject bypass without affecting the Local Run / Prod Run / Deploy buttons, which continue to render and route through the direct action path as before.
