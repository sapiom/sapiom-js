---
"@sapiom/browser-pay": minor
---

Report Adyen's answer to a re-encrypted payment (SAP-5180). The interceptor continues only that request with `interceptResponse`, reads the top-level `resultCode` (`unknown` when unreadable), passes the answer to the page unchanged, posts `POST /v1/transactions/{id}/payment/adyen/result` `{ injectionRef, resultCode, pspReference? }` once through the new optional `PaymentRelay.adyenResult`, and emits `adyen_result` (`resultCode`, `status`, `reported`). A failed report never touches the page and logs only codes.
