---
"@sapiom/tools": minor
---

The tenant API key now only travels over HTTPS, or plain HTTP to a loopback
host, and never follows a redirect to another origin.

- A plain `http://` URL to a non-loopback host (for example `http://api:3000`)
  now fails before the request is sent. On a trusted private network, opt in
  with `createClient({ allowInsecureHttp: true })` or
  `SAPIOM_ALLOW_INSECURE_HTTP=1`. `localhost`, `*.localhost`, `127.0.0.1` and
  `[::1]` work as before.
- The transport follows redirects itself. The first hop to another origin
  drops the credential (`x-sapiom-api-key`, `x-api-key`), every `x-sapiom-*`
  header, and the headers `fetch` drops on its own (`authorization`, `cookie`,
  `proxy-authorization`). Same-origin redirects are unchanged, and a caller
  passing `redirect: "manual"` or `"error"` gets plain `fetch`.
