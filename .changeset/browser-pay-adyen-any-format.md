---
"@sapiom/browser-pay": patch
---

Relay Adyen secured-field payments in JSON, nested JSON strings, URL-encoded forms and multipart forms without changing body bytes. Require all four observed placeholder ciphertexts in the Pay body; refuse unobserved ciphertexts and escaped ciphertexts that cannot be replaced byte for byte. Formats other than top-level JSON also need a relay that swaps ciphertexts by hash; a relay that reads only a top-level JSON `paymentMethod` refuses them, and the request fails without sending card data.
