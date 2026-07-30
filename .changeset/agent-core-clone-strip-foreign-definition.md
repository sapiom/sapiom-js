---
"@sapiom/agent-core": patch
---

Clone: a template or fork clone no longer inherits a `definitionId` committed in the source repo's `sapiom.json`. A fresh fork is left unlinked so you deploy it under your own account; only an explicit clone-by-definitionId stays pre-linked. This fixes runs and deploys failing with "definition not found" on a cloned template that had been pre-linked to someone else's deployment.
