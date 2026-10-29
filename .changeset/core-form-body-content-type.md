---
"@sapiom/core": patch
---

Stop sending the default `Content-Type: application/json` with `FormData`, `URLSearchParams` and `Blob` request bodies. The default overrode the type fetch derives from the body, so a `FormData` upload went out without its `multipart/form-data; boundary=...` header and the server could not parse it. A `Content-Type` passed on the request now replaces the default in any casing instead of being sent alongside it.
