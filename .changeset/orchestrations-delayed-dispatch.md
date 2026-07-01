---
"@sapiom/tools": patch
---

`orchestrations.launch({ at })`: from inside a step, schedule a child orchestration to run at a future time and pause on the returned handle — the step resumes with the child's result once the scheduled run finishes (delayed dispatch). Immediate `launch`/`run` are unchanged.
