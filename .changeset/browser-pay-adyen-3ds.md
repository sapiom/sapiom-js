---
"@sapiom/browser-pay": patch
---

Follow an Adyen payment through 3-D Secure (SAP-5281). When the relay answers a payment with `RedirectShopper`, `IdentifyShopper` or `ChallengeShopper`, the page's next details call from the same tab and checkout is watched: Adyen's own `/sessions/{id}/paymentDetails` is relayed as `adyen-checkout` with the same client key, so the relay records the final answer; a merchant's own `/payments/details` goes on unchanged with `interceptResponse`, and only its final code is reported once through the new optional `PaymentRelay.adyenResult` (`POST /v1/transactions/{id}/payment/adyen/result`) and emitted as `adyen_result`. Challenges are counted, so one payment's final answer never clears another's. The SDK never drives the challenge.
