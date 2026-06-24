---
"@sapiom/tools": minor
---

Add the `memory` capability — tenant-scoped long-term memory over the Sapiom memory gateway (hybrid vector + full-text store). Exposes `append`, `recall`, `get`, and `forget` via `createClient().memory`, the ambient `memory` namespace, or the `@sapiom/tools/memory` subpath. Non-2xx responses throw `MemoryHttpError`. The `@sapiom/tools/stub` client gains a matching `memory` stub so steps that use it can be exercised locally.
