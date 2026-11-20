---
"@sapiom/browser-pay": minor
---

Pay Adyen secured-fields checkouts through the payment relay (SAP-5180). The interceptor pauses an outgoing Adyen payment (`paymentMethod.encryptedCardNumber`, on the merchant's `/payments` call or Adyen's `/sessions/{id}/payments`) and relays it verbatim with `profileId: "adyen-checkout"` and `adyen: { clientKey }` (new optional `RelayRequest.adyen`). The relay encrypts the real card in place of the page's placeholder ciphertext and its response fulfils the page's request; a refusal fails it, so the placeholder's ciphertext is never sent on. `fillCard` types the placeholder into Adyen secured fields as on any other form.
