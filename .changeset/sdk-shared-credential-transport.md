---
"@sapiom/analytics-core": minor
"@sapiom/core": minor
"@sapiom/agent-core": minor
"@sapiom/mcp": patch
"@sapiom/tools": patch
---

The tenant API key now only travels over HTTPS, or plain HTTP to a loopback
host, from every SDK client, and never follows a redirect to another origin.
One function, `credentialFetch` from the new `@sapiom/analytics-core/credential`
subpath, is the only code that sets the key header.

- `@sapiom/core`, `@sapiom/agent-core` and `@sapiom/mcp`: a plain `http://`
  URL to a non-loopback host (for example a Docker service name or a LAN IP)
  now fails before the request is sent. On a trusted private network, opt in
  with `new SapiomClient({ allowInsecureHttp: true })` (core),
  `createClient({ allowInsecureHttp: true })` (agent-core) or
  `SAPIOM_ALLOW_INSECURE_HTTP=1` (all clients). `localhost`, `*.localhost`,
  `127.0.0.1` and `[::1]` work as before. Core does not retry a refused channel.
- `@sapiom/analytics-core`: on such an endpoint the batch is still sent, without
  the key. A redirect to a refused channel drops the batch.
- Every client follows redirects itself: the first hop to another origin drops
  `x-api-key`, `x-sapiom-api-key` and every `x-sapiom-*` header.
- `@sapiom/core`: `getHttpClient().defaults.headers` no longer carries the key;
  read `defaults.credential` instead.
- `@sapiom/tools`: no behavior change; a refused call is now reported as a
  `CredentialChannelError` (still a `TypeError`).
