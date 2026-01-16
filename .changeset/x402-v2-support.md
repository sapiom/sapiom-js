---
"@sapiom/core": minor
"@sapiom/axios": minor
"@sapiom/fetch": minor
"@sapiom/langchain": minor
"@sapiom/langchain-classic": minor
"@sapiom/node-http": minor
---

Add x402 V2 protocol support

- Add V1/V2 union types (`X402ResponseV1`, `X402ResponseV2`, etc.) in `@sapiom/core`
- Add type guards (`isV2Response`, `isV1Requirement`) and helpers (`getPaymentAmount`, `getResourceUrl`)
- `PaymentRequiredError` now exposes `x402Version` and `isV2()`/`isV1()` methods
- Axios/fetch interceptors send `PAYMENT-SIGNATURE` header for V2, `X-PAYMENT` for V1
- Full backward compatibility with V1 protocol maintained
