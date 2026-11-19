---
"@sapiom/browser-pay": patch
---

Report Adyen's final result after 3-D Secure (SAP-5281). When a re-encrypted payment answers `RedirectShopper`, `IdentifyShopper` or `ChallengeShopper`, the interceptor reports that code as before and then watches the page's next `POST` to `/payments/details` (or Adyen's `/sessions/{id}/paymentDetails`) on the same origin. That request goes on unchanged with `interceptResponse`; its answer's `resultCode` is reported once through `PaymentRelay.adyenResult` and emitted as `adyen_result`. The SDK never drives the challenge; when no details answer comes, nothing more is reported.
