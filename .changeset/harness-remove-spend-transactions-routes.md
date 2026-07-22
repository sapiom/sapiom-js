---
"@sapiom/harness": patch
---

Remove the run spend and transactions endpoints (`GET /api/runs/:executionId/spend` and `/transactions`) and their supporting fetchers. The runs router now serves only run state (`GET /api/runs/:executionId/state`).
