---
"@sapiom/browser-pay": patch
---

Take the Adyen client key only from the browser's own https requests to Adyen's checkoutshopper hosts (SAP-5180). A key the page puts in its DOM is never used; no key, or two different keys, fails the payment closed with `adyen_client_key`.
