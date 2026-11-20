---
"@sapiom/browser-pay": minor
---

Adyen Pay now carries `adyen.placeholderBlobHashes` (SAP-5180): the sha256 hex of the four `encrypted*` blobs the page's secured-field iframes posted, observed passively in the page and never kept or logged as blobs. A Pay with any of the four unobserved fails locally with the new `adyen_placeholder_unobserved` reason and the relay is not asked. The interceptor now enables the `Page` and `Runtime` domains on armed targets.
