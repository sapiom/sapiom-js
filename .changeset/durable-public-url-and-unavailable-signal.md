---
"@sapiom/tools": minor
---

file-storage: add `fileStorage.getPublicUrl(fileId)` — a pure helper that builds the durable, unauthenticated `/public/:id` permalink (the gateway re-signs a fresh URL on each hit), so callers can email or embed a link for an external recipient instead of a ~15-min presigned URL.

content-generation: add `downloadUrlUnavailable?: boolean` to `ImageResultPayload` / `VideoResultPayload` outputs, so a resumed step can tell "URL omitted, re-fetch from fileId" from "no asset".

Both are additive; no breaking changes. (Releases the changes merged in #504.)
