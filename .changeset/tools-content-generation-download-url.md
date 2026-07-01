---
"@sapiom/tools": minor
---

`contentGeneration` image + video outputs now include a ready-to-use `downloadUrl` (and its `downloadUrlExpiresAt`) alongside the durable `fileId` when `storage` is requested.

- `GeneratedImage` and `GeneratedVideo` gain an optional `downloadUrl` — a short-lived, ready-to-use signed URL for the persisted output, surfaced inline on the result so you don't need a follow-up `fileStorage.getDownloadUrl(fileId)` call just to fetch it — plus `downloadUrlExpiresAt` (ISO) so the field is self-describing. It expires; `fileId` remains the durable reference (re-mint a fresh URL any time via `fileStorage.getDownloadUrl(fileId)`).
- `VideoResultPayload.outputs[]` (delivered to a step resumed from `pauseUntilSignal`) carries `downloadUrl` + `downloadUrlExpiresAt` too, and `toVideoResumePayload` maps them through.
- The provider-hosted `url` is now documented as the raw, possibly short-lived / unauthenticated URL — prefer `downloadUrl` (ready to use) or `fileId` (durable) when you requested `storage`.
- `createStubClient()` mirrors the new fields: stubbed image / video outputs include a `downloadUrl` + `downloadUrlExpiresAt` when `storage` is passed.

Backward compatible: the new fields are optional and additive; the existing `fileId` / `url` / `storageError` fields are unchanged.
