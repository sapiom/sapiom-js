---
"@sapiom/browser-pay": minor
---

Observe qualified Braintree/Cardinal 3DS challenges automatically on the no-profile card relay. Preserve the complete challenge form, bind its return to the original lookup and native verifier, and continue the same pending payment once. Unknown native implementations retain their existing checkout before capture. Backend enablement and issuer qualification remain required.

Retain the original amount-bound lookup when later lookup traffic arrives, require a controllable pending verifier promise before capture, and block uncertain bank-frame traffic once capture is proposed, recorded or launched.
