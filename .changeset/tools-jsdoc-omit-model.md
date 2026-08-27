---
"@sapiom/tools": patch
---

`model` JSDoc on the llm and models specs no longer suggests pinning `smart` — it is the default, so pinning it does nothing. The hover text now says to omit `model`, and to pass a size label only when picking a class deliberately.
