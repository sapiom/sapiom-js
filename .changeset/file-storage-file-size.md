---
"@sapiom/tools": minor
---

**Breaking:** `fileStorage` now uses a single `fileSize` field, matching the service contract.

Previously `upload` 400'd and metadata sizes came back `undefined` because the SDK was on an older field shape.

- `UploadInput.expectedFileSize?: number` → `fileSize: number` (now **required** — the service rejects uploads without it).
- `FileMetadata.expectedFileSize` / `actualFileSize` → a single `fileSize: string`.

To migrate: pass `fileSize` on `upload(...)`, and read `fileSize` (a string) instead of `expectedFileSize` / `actualFileSize` on returned metadata.
