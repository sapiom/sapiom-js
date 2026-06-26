---
"@sapiom/tools": minor
---

Add the `search` namespace with provider-agnostic operations:

- `search.webSearch` — web search returning normalized `{ query, answer?, results }`.
- `search.scrape` — fetch a URL as clean Markdown/HTML with page metadata.
- `search.emailSearch.findEmail` / `verifyEmail` / `domainSearch` — find, verify, and discover professional email addresses for a domain.

Results use normalized camelCase types, and a typed `SearchHttpError` (`{ status, body }`) is thrown on non-2xx responses.
