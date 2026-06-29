# fileStorage

Tenant-scoped object storage with presigned URLs. The same file-storage capability
your agents call over MCP, callable directly from your code.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// 1. Ask for a presigned upload URL.
const { fileId, uploadUrl, requiredHeaders } = await sapiom.fileStorage.upload({
  contentType: "image/png",
  fileName: "photo.png",
  visibility: "private", // or "public"
  fileSize: bytes.byteLength, // required — size in bytes
});

// 2. PUT the bytes to the upload URL yourself.
await fetch(uploadUrl, {
  method: "PUT",
  headers: requiredHeaders,
  body: bytes,
});

// 3. Later: a presigned download URL, list, visibility, delete.
const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(fileId);
const { files } = await sapiom.fileStorage.list({ limit: 50 });
await sapiom.fileStorage.setVisibility(fileId, "public");
await sapiom.fileStorage.delete(fileId);
```

Ambient import works too: `import { fileStorage } from "@sapiom/tools"`.

## You move the bytes

`upload()` and `getDownloadUrl()` return **presigned URLs**; this client never
transfers file bytes. You `PUT` to the upload URL and `GET` from the download URL
yourself, so you own streaming, progress, and resumable-upload behavior. `upload()`
returns `requiredHeaders` you **must** include on the `PUT` (notably `Content-Type`).

## Lifecycle

After you `PUT` the bytes, the file's `status` moves from `pending_upload` →
`uploaded` (usually within seconds) and `fileSize` is updated to the measured size.
Until then, `getDownloadUrl()` on a still-pending file is rejected.

## Visibility

- `private` (default) — downloading requires a valid tenant credential.
- `public` — the download URL is unauthenticated.

Access is **tenant-scoped**: any API key under your tenant can act on the tenant's
files; another tenant cannot read your private files.

## Gotchas

- **`fileSize` is a string on metadata.** `fileSize` on returned metadata is a
  `string` to avoid JS `Number` precision loss on large files. (`fileSize` on the
  `upload()` _input_ is a regular `number`, and is **required**.)
- **`delete` is idempotent** — deleting an already-deleted file resolves without
  error.
- **Failed requests throw `FileStorageHttpError`** (carries `status` + parsed
  `body`), exported from `@sapiom/tools`.
