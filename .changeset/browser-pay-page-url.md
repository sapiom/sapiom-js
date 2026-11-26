---
"@sapiom/browser-pay": patch
---

Send the paying page's URL with the card relay (SAP-5356). The relay request carries an optional `pageUrl`, the top-level page's origin and path without query or fragment, so the relay can refuse a payment from a Shopify checkout other than the purchase's with `checkout_mismatch`. `pageUrl` is left out when only the frame's `ancestorOrigins` names the page, when it is off `pageOrigin`, or when it holds the placeholder. A refusal's `message` is kept and put on the `refused` event. Release only after the relay backend accepts `pageUrl` (sapiom/Sapiom#7106); an older backend answers 400.
