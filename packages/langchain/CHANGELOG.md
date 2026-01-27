# @sapiom/langchain

## 0.2.2

### Patch Changes

- 797d633: Fix ESM imports in Node.js by adding `{"type": "module"}` package.json to dist/esm folders
- Updated dependencies [797d633]
  - @sapiom/core@0.2.2

## 0.2.1

### Patch Changes

- fix: add .js extensions to ESM imports for Node.js compatibility

  Node.js ESM requires explicit .js extensions in relative imports. This change ensures all packages work correctly when imported as ES modules in Node.js environments.

- Updated dependencies
  - @sapiom/core@0.2.1

## 0.2.0

### Minor Changes

- 19338bb: Add x402 V2 protocol support
  - Add V1/V2 union types (`X402ResponseV1`, `X402ResponseV2`, etc.) in `@sapiom/core`
  - Add type guards (`isV2Response`, `isV1Requirement`) and helpers (`getPaymentAmount`, `getResourceUrl`)
  - `PaymentRequiredError` now exposes `x402Version` and `isV2()`/`isV1()` methods
  - Axios/fetch interceptors send `PAYMENT-SIGNATURE` header for V2, `X-PAYMENT` for V1
  - Full backward compatibility with V1 protocol maintained

### Patch Changes

- Updated dependencies [19338bb]
  - @sapiom/core@0.2.0

## 0.1.2

### Patch Changes

- 5593157: Update documentation links, sapiom.com to sapiom.ai
- Updated dependencies [5593157]
  - @sapiom/core@0.1.2

## 0.1.1

- First public release

## 0.1.0

### Initial Release

- LangChain v1.x middleware integration
- Automatic agent lifecycle tracking
- Model call tracking with token estimation
- Tool call pre-authorization support
- Session-based cost tracking
- Compatible with LangChain v1.0+
