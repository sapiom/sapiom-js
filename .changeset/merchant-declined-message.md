---
"@sapiom/core": minor
---

`CompleteTransactionRequest` adds `merchantMessage`: what the store said when it refused a card purchase's payment after the card was sent. Send it with outcome `error`; the purchase then reads `closed` with reason `merchant_declined` and the store's words. The API rejects it on any other transaction.
