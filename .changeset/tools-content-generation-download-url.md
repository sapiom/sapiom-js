---
"@sapiom/tools": minor
---

`contentGeneration` image + video outputs now include a ready-to-use `downloadUrl` alongside the durable `fileId` when `storage` is requested.

- `GeneratedImage` and `GeneratedVideo` gain an optional `downloadUrl` — a short-lived, ready-to-use signed URL for the persisted output, surfaced inline on the result so you don't need a follow-up `fileStorage.getDownloadUrl(fileId)` call just to fetch it. It expires; `fileId` remains the durable reference (re-mint a fresh URL any time via `fileStorage.getDownloadUrl(fileId)`).
- `VideoResultPayload.outputs[]` (delivered to a step resumed from `pauseUntilSignal`) carries `downloadUrl` too, and `toVideoResumePayload` maps it through.
- The provider-hosted `url` is now documented as the raw, possibly short-lived / unauthenticated URL — prefer `downloadUrl` (ready to use) or `fileId` (durable) when you requested `storage`.
- `createStubClient()` mirrors the new field: stubbed image / video outputs include a `downloadUrl` when `storage` is passed.

Backward compatible: `downloadUrl` is optional and additive; the existing `fileId` / `url` / `storageError` fields are unchanged.
