---
"@sapiom/core": minor
"@sapiom/fetch": patch
"@sapiom/axios": patch
"@sapiom/node-http": patch
---

Request and response facts now share one header and URL sanitizer. `@sapiom/fetch`, `@sapiom/axios` and `@sapiom/node-http` leave out the same credential headers (`authorization`, cookies, `x-api-key`, `api-key`, `bt-api-key` and other `*-api-key` / `*token*` / `*secret*` / `*password*` headers, payment signatures, `x-sapiom-*` key and token headers), and mask credential query values (`key`, `api_key`, `token`, `access_token`, `signature`, `sig`, `password`, …) and `user:pass@` in the reported `url` and `urlParsed.search`. Only the facts change: the outgoing request is sent exactly as before. `@sapiom/core` exports the helpers (`sanitizeHeadersForFacts`, `sanitizeUrlForFacts`, `isSensitiveHeaderName`, `isSensitiveQueryParam`).
