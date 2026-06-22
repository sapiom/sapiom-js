# fileStorage

Tenant-scoped object storage on top of presigned GCS URLs. The same file-storage
capability your agents call over MCP, callable directly from your code.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// 1. Ask for a presigned upload URL (control plane).
const { fileId, uploadUrl, requiredHeaders } = await sapiom.fileStorage.upload({
  contentType: "image/png",
  fileName: "photo.png",
  visibility: "private", // or "public"
});

// 2. PUT the bytes straight to GCS yourself.
await fetch(uploadUrl, { method: "PUT", headers: requiredHeaders, body: bytes });

// 3. Later: a presigned download URL, list, visibility, delete.
const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(fileId);
const { files } = await sapiom.fileStorage.list({ limit: 50 });
await sapiom.fileStorage.setVisibility(fileId, "public");
await sapiom.fileStorage.delete(fileId);
```

Ambient import works too: `import { fileStorage } from "@sapiom/tools"`.

## Control plane only — you move the bytes

`upload()` and `getDownloadUrl()` return **presigned GCS URLs**; this client never
transfers file bytes. You `PUT` to the upload URL and `GET` from the download URL
yourself, so you own streaming, progress, and resumable-upload behavior. `upload()`
returns `requiredHeaders` you **must** include on the `PUT` (notably `Content-Type`).

## Lifecycle

After you `PUT` the bytes, a gateway sweep verifies the object and flips its
`status` from `pending_upload` → `uploaded` (usually within seconds) and records
`actualFileSize`. Until then, `getDownloadUrl()` on a still-pending file is rejected.

## Visibility

- `private` (default) — downloading requires a valid tenant credential.
- `public` — the download URL is unauthenticated.

Access is **tenant-scoped**: any API key under your tenant can act on the tenant's
files; another tenant cannot read your private files.

## Gotchas

- **Sizes are strings.** `expectedFileSize` / `actualFileSize` on returned metadata
  are `string | null` — the gateway serializes int64 byte counts as strings to
  avoid JS `Number` precision loss on large files. (`expectedFileSize` on the
  `upload()` *input* is a regular `number`.)
- **`delete` is idempotent** — deleting an already-deleted file resolves without
  error.
- **Non-2xx responses throw `FileStorageHttpError`** (carries `status` + parsed
  `body`), exported from `@sapiom/tools`.
- **Base URL** defaults to the production gateway; override with the
  `SAPIOM_FILE_STORAGE_URL` env var (e.g. to target a staging gateway).
