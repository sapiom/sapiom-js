---
"@sapiom/browser-pay": minor
---

Require an Adyen iframe or network signal from the same attach before relaying encrypted card payments (SAP-5180). Without one, fail locally with `unsupported_encrypted_checkout` without asking the relay. Confirmed Adyen checkouts keep the existing client-key and placeholder-hash checks; plain card requests are unchanged.
