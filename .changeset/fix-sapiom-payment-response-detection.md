---
'@sapiom/core': patch
---

fix(core): detect Sapiom-format 402 responses in payment error extraction

The `isSapiomPaymentResponse` guard required a `paymentData` field that does not
exist on `SapiomPaymentResponse` (whose fields are `requiresPayment`,
`transactionId`, `x402`, `message`). It therefore rejected every real Sapiom 402
body, leaving the wrapper branch in `extractX402` / `extractX402Response`
unreachable — a Sapiom response nesting its x402 payload under `requiresPayment`
was never detected. The guard now discriminates on `requiresPayment === true`.
`extractTransactionId` returns the body `transactionId` only when present, so the
`x-sapiom-transaction-id` header fallback still runs when the body omits it.
