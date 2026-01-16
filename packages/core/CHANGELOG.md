# @sapiom/core

## 0.2.0

### Minor Changes

- 19338bb: Add x402 V2 protocol support
  - Add V1/V2 union types (`X402ResponseV1`, `X402ResponseV2`, etc.) in `@sapiom/core`
  - Add type guards (`isV2Response`, `isV1Requirement`) and helpers (`getPaymentAmount`, `getResourceUrl`)
  - `PaymentRequiredError` now exposes `x402Version` and `isV2()`/`isV1()` methods
  - Axios/fetch interceptors send `PAYMENT-SIGNATURE` header for V2, `X-PAYMENT` for V1
  - Full backward compatibility with V1 protocol maintained

## 0.1.2

### Patch Changes

- 5593157: Update documentation links, sapiom.com to sapiom.ai

## 0.1.1

- First public release

## 0.1.0

### Initial Release

- Core transaction API client
- HTTP client adapters (Axios, Fetch, Node HTTP)
- Automatic 402 payment handling
- Pre-emptive authorization support
- Zero external dependencies
- Full TypeScript support
