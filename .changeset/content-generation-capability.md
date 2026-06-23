---
"@sapiom/tools": minor
---

Add the `contentGeneration` capability — provider-neutral media generation (images today; video/audio to come) with an optional `storage` param that persists each output into Sapiom file-storage server-side (each generated image comes back annotated with its own `file_id`, or `storage_error`). Exposes `contentGeneration.images.create({ prompt, storage? })` via `createClient()`, the ambient `contentGeneration` namespace, or the `@sapiom/tools/content-generation` subpath. Non-2xx responses throw `ContentGenerationHttpError`. Pairs with `fileStorage` — pass `storage` to stitch the two with zero extra plumbing.
