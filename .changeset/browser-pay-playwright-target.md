---
"@sapiom/browser-pay": patch
---

`attachInterceptor` no longer says it accepts a Playwright browser or page.
They have no `wsEndpoint()`, so they were always refused. With Playwright, pass
the browser's CDP URL.
