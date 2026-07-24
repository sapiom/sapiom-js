---
"@sapiom/harness": patch
---

Deploy now links-or-creates your own agent definition by name before deploying, instead of only updating an existing linked id. A workflow that is unlinked, or linked to a definition that isn't on your account (for example a freshly cloned template), now deploys cleanly under your account — no more "not linked" or "definition not found" dead-ends.
