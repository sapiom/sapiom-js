---
"@sapiom/browser-pay": patch
---

Relay Adyen secured-field payments in JSON, nested JSON strings, URL-encoded forms and multipart forms without changing body bytes. Require all four observed placeholder ciphertexts in the Pay body; refuse unobserved ciphertexts and escaped ciphertexts that cannot be replaced byte for byte.
