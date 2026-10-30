# @sapiom/core

## 0.7.0

### Minor Changes

- 8df73a6: The SDK sends request idempotency keys as `Idempotency-Key`, the API's one idempotency header, instead of `X-Idempotency-Key`. `HttpClient` still treats a key you pass under either spelling as the request's key and never adds a second one; browser automation sends its key once instead of under both names. The API accepts `X-Idempotency-Key` with the same meaning, so code that sets it keeps working.

## 0.6.0

### Minor Changes

- a8068d8: Remove the exported `ListTransactionsParams` type. No client method accepted it, and its fields did not match `GET /v1/transactions`: the API paginates with `page[limit]` / `page[after]` cursors (no `offset`), and `filter[service]` takes a service ID (UUID), not a name. Code that imported the type should drop the import; nothing at runtime changes.
- a76b8bd: The tenant API key now only travels over HTTPS, or plain HTTP to a loopback
  host, from every SDK client, and never follows a redirect to another origin.
  One function, `credentialFetch` from the new `@sapiom/analytics-core/credential`
  subpath, is the only code that sets the key header.

  Behavior changes, shipped as 0.x minor bumps: a plain `http://` URL to a
  non-loopback host is now refused, and the key headers are stripped on a
  cross-origin redirect. `@sapiom/core` and `@sapiom/browser-pay` gain their
  first runtime dependency, `@sapiom/analytics-core`.

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
  - `@sapiom/browser-pay`: the payment relay uses the shared rule, so a
    `*.localhost` base URL and `SAPIOM_ALLOW_INSECURE_HTTP=1` are now accepted, and
    a refused base URL throws a `CredentialChannelError`. Redirects are still
    refused.
  - `@sapiom/tools`: no behavior change. A refused call now throws a
    `CredentialChannelError`, a `TypeError` subclass that keeps `name: "TypeError"`.

### Patch Changes

- Updated dependencies [1b9a5f6]
- Updated dependencies [a76b8bd]
  - @sapiom/analytics-core@0.3.0

## 0.5.0

### Minor Changes

- 658e8fb: New: SDK Identity Token Lifecycle. Adds automatic Sapiom-Identity JWT management across all SDK packages. The SDK lazily fetches identity tokens from POST /v1/auth/tokens, caches them in-memory, and attaches the Sapiom-Identity header to requests whose target hostname matches the token's aud claim (direct or subdomain match).

## 0.4.0

### Minor Changes

- c9ad2cb: add create transaction scoped API key functionality

## 0.3.0

### Minor Changes

- 8423815: implement `@sapiom/mcp`, minor code formatting

## 0.2.2

### Patch Changes

- 797d633: Fix ESM imports in Node.js by adding `{"type": "module"}` package.json to dist/esm folders

## 0.2.1

### Patch Changes

- fix: add .js extensions to ESM imports for Node.js compatibility

  Node.js ESM requires explicit .js extensions in relative imports. This change ensures all packages work correctly when imported as ES modules in Node.js environments.

## 0.2.0

### Minor Changes

- 19338bb: Add x402 V2 protocol support
  - Add V1/V2 union types (`X402ResponseV1`, `X402ResponseV2`, etc.) in `@sapiom/core`
  - Add type guards (`isV2Response`, `isV1Requirement`) and helpers (`getPaymentAmount`, `getResourceUrl`)
  - `PaymentRequiredError` now exposes `x402Version` and `isV2()`/`isV1()` methods
  - Axios/fetch interceptors send `PAYMENT-SIGNATURE` header for V2, `X-PAYMENT` for V1
  - Full backward compatibility with V1 protocol maintained

## 0.1.2

### Patch Changes

- 5593157: Update documentation links, sapiom.com to sapiom.ai

## 0.1.1

- First public release

## 0.1.0

### Initial Release

- Core transaction API client
- HTTP client adapters (Axios, Fetch, Node HTTP)
- Automatic 402 payment handling
- Pre-emptive authorization support
- Zero external dependencies
- Full TypeScript support
