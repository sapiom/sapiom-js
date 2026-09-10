---
"@sapiom/harness": patch
"@sapiom/opencode": patch
---

Attach a per-request completion instruction and support one durable native continuation from saved conversation results after an eligible incomplete turn. Fence prompt admission and uncertain dispatch, retain normal permissions, bound recovery time, and prevent the same continuation from dispatching again after reload. This mitigates missing final answers; premature stops and unnecessary recaps can still occur.
