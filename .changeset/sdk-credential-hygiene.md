---
"@sapiom/core": patch
"@sapiom/analytics-core": patch
"@sapiom/axios": patch
"@sapiom/fetch": patch
"@sapiom/node-http": patch
"@sapiom/tools": patch
---

Credential hygiene across the HTTP wrappers and the tools client:

- The `Sapiom-Identity` header is attached only over https (or http to a loopback host), is checked against the URL axios actually requests, and is dropped when a request is redirected to another origin.
- `@sapiom/fetch` honours `__sapiom` set on `init` as well as on a `Request`, including `enabled: false`.
- Transaction facts recorded by the axios, fetch and node-http wrappers no longer include credential, cookie or payment headers, and query values are emptied.
- A `Transport` (and the sandbox and repository handles holding one) serializes and logs without its API key or resume token.
- Ids used as URL path segments reject an empty string, `.` and `..`.
- URLs returned by a Sapiom service (LLM grant links, media poll URLs) must stay within the configured Sapiom deployment, and Google connector bare paths stay inside the proxy route.
