---
"@sapiom/harness": patch
---

Deploy now checks that a project's saved agent id still belongs to your account. If it doesn't — e.g. you cloned a repo someone else had deployed — Deploy re-links or creates the agent under your account instead of failing with "definition not found."
