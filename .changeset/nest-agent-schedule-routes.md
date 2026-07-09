---
"@sapiom/tools": patch
"@sapiom/agent-core": patch
---

Align agent run and schedule requests with the current API endpoints. This also fixes `@sapiom/tools` `schedules` operations (create/list/get/cancel), which were targeting an outdated endpoint. Public function signatures are unchanged.
