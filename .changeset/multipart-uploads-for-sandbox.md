---
"@sapiom/sandbox": minor
---

Add multipart file upload support. New `uploadFile(path, content, opts?)` handles the full initiate → parallel part uploads → complete lifecycle with auto-abort on failure. Accepts `Blob | Uint8Array | string`. Low-level `initiateMultipartUpload` / `uploadPart` / `completeMultipartUpload` / `abortMultipartUpload` / `listMultipartParts` primitives are also exposed for resumable or custom-retry use cases.
