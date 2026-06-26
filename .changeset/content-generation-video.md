---
"@sapiom/tools": minor
---

Add `contentGeneration.video.create` — generate a video from a prompt, with an optional `storage` param. Video generation is asynchronous: `create` submits the job and polls until the result is ready (configurable `pollIntervalMs` / `timeoutMs`), then resolves — so you `await` it just like `images.create`. When `storage` is passed, the output is persisted and the returned `video` carries a `fileId`. camelCase surface, mapped from the wire.
