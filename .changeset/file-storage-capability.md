---
"@sapiom/tools": minor
---

Add the `fileStorage` capability — tenant-scoped object storage on presigned GCS URLs. Exposes `upload`, `getDownloadUrl`, `list`, `setVisibility`, and `delete` via `createClient().fileStorage`, the ambient `fileStorage` namespace, or the `@sapiom/tools/file-storage` subpath. Non-2xx responses throw `FileStorageHttpError`. Byte transfer stays client-side (presigned URLs); the capability owns only the control plane.
