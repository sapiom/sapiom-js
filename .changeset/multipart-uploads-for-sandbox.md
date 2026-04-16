---
"@sapiom/sandbox": minor
---

Add multipart file upload support. New `uploadFile(path, content, opts?)` handles the full initiate → parallel part uploads → complete lifecycle with per-part retries (408/425/429/5xx + network errors, honors `Retry-After`) and auto-abort on failure. Accepts `Blob | Uint8Array | string`. Low-level `initiateMultipartUpload` / `uploadPart` / `completeMultipartUpload` / `abortMultipartUpload` / `listMultipartParts` primitives are exposed for resumable or custom-retry use cases, and a typed `SandboxHttpError` carries `status` + `retryAfterMs` for programmatic handling.
