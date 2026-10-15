---
"@sapiom/core": minor
---

Remove the exported `ListTransactionsParams` type. No client method accepted it, and its fields did not match `GET /v1/transactions`: the API paginates with `page[limit]` / `page[after]` cursors (no `offset`), and `filter[service]` takes a service ID (UUID), not a name. Code that imported the type should drop the import; nothing at runtime changes.
