---
"@sapiom/tools": minor
---

Add the `contentGeneration` capability — media generation (images today; video and audio to come) with an optional `storage` param that persists each output to Sapiom file storage (each generated image comes back annotated with its own `fileId`, or `storageError`). Exposes `contentGeneration.images.create({ prompt, numImages?, storage? })` via `createClient()`, the ambient `contentGeneration` namespace, or the `@sapiom/tools/content-generation` subpath. Failed requests throw `ContentGenerationHttpError`. Pairs with `fileStorage` — pass `storage` to persist outputs with no extra plumbing.
