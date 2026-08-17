---
"@sapiom/harness": patch
---

Give the workflow registry's atomic write a per-process temp file name, so two harness instances sharing the machine-wide workflows.json cannot publish a torn file.
