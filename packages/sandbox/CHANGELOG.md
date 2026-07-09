# @sapiom/sandbox

## 0.8.3

### Patch Changes

- c0fef6d: Deprecate for new projects. `@sapiom/tools` now ships sandbox support built in (`sapiom.sandboxes.*`), which new projects should use instead. This standalone package remains published and supported for existing production use. Adds a deprecation notice to the README.

## 0.8.2

### Patch Changes

- b857467: Republish to fix the `@sapiom/fetch` dependency. The `0.8.1` artifact shipped with the unresolved `workspace:*` specifier, making it uninstallable; this release ships it resolved to a real version range.

## 0.8.1

### Patch Changes

- 17880a2: Fix process polling treating only `"completed"` as terminal. Non-zero exits (status `"failed"`) and `"killed"`/`"stopped"` are now recognized as finished, so `exec`/`execStream`/`waitForProcess` return promptly with the real exit code instead of hanging until the timeout. Terminal statuses that omit an exit code now report a non-zero code instead of falsely reporting success.

## 0.8.0

### Minor Changes

- 2781e03: Add multipart file upload support. New `uploadFile(path, content, opts?)` handles the full initiate → parallel part uploads → complete lifecycle with per-part retries (408/425/429/5xx + network errors, honors `Retry-After`) and auto-abort on failure. Accepts `Blob | Uint8Array | string`. Low-level `initiateMultipartUpload` / `uploadPart` / `completeMultipartUpload` / `abortMultipartUpload` / `listMultipartParts` primitives are exposed for resumable or custom-retry use cases, and a typed `SandboxHttpError` carries `status` + `retryAfterMs` for programmatic handling.

## 0.7.0

### Minor Changes

- 0f8d6cd: support keepAlive and processTimeout opts

## 0.6.0

### Minor Changes

- 658e8fb: New: SDK Identity Token Lifecycle. Adds automatic Sapiom-Identity JWT management across all SDK packages. The SDK lazily fetches identity tokens from POST /v1/auth/tokens, caches them in-memory, and attaches the Sapiom-Identity header to requests whose target hostname matches the token's aud claim (direct or subdomain match).

### Patch Changes

- Updated dependencies [658e8fb]
  - @sapiom/fetch@0.5.0

## 0.5.0

### Minor Changes

- 96afc06: reverts "yield final stdout/stderr before closing"

## 0.4.0

### Minor Changes

- 2376a14: yield final stdout/stderr before closing

## 0.3.0

### Minor Changes

- 0cde98e: support upload and uploadUrl when creating sandboxes

## 0.2.0

### Minor Changes

- de766f0: Add @sapiom/sandbox package for sandbox environment lifecycle management

### Patch Changes

- Updated dependencies [c9ad2cb]
  - @sapiom/fetch@0.4.0
