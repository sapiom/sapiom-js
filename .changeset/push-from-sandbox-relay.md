---
"@sapiom/tools": patch
---

`repositories.pushFromSandbox` now always publishes the agent's work — it
commits any pending changes and pushes the current commit, so your work reaches
the repo whether the agent left changes uncommitted, already committed them, or
both. (Previously it skipped the push when there were no uncommitted changes.)
The result now includes `branch` alongside `pushed` and `sha`.
