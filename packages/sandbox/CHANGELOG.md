# @sapiom/sandbox

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
