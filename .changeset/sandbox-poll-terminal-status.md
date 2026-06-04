---
"@sapiom/sandbox": patch
---

Fix process polling treating only `"completed"` as terminal. Non-zero exits (status `"failed"`) and `"killed"`/`"stopped"` are now recognized as finished, so `exec`/`execStream`/`waitForProcess` return promptly with the real exit code instead of hanging until the timeout. Terminal statuses that omit an exit code now report a non-zero code instead of falsely reporting success.
