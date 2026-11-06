---
"@sapiom/browser-pay": patch
"@sapiom/core": patch
---

Remove the unreleased Braintree/Cardinal native return implementation and acknowledgment field. Keep the existing Shopify observer and Basis Theory challenge flow.

Prevent another credential relay after challenge capture is reserved, recorded, or launched, while preserving readback of an existing relay. Keep unavailable or failed observer registration from waiting on stalled adapter cleanup.

Recognize the receipt-query revision observed in the retained Shopify checkout, with the same card-session, receipt and amount validation.

Project verification responses and observer handles onto their documented fields so extra transport data is not retained or exposed.
