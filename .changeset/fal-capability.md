---
"@sapiom/tools": minor
---

Add the `fal` capability — image generation through the Sapiom Fal gateway, with an optional `storage` param that persists each output into Sapiom file-storage server-side (each generated image then comes back annotated with its own `file_id`, or `storage_error`). Exposes `run` via `createClient().fal`, the ambient `fal` namespace, or the `@sapiom/tools/fal` subpath. Responses are Fal-native (passthrough); non-2xx responses throw `FalHttpError`. Pairs with the `fileStorage` capability — pass `storage` to stitch the two with zero extra plumbing.
