# @sapiom/browser-pay

## 0.3.0

### Minor Changes

- 5b00bdb: `AttachOptions.profileId` is optional. Without it the interceptor relays a paused request to any checkout: the relay sends it to its own URL when that is https to a public host and finds the card fields by the placeholder's values. Without a profile every header is forwarded except the connection's, `cookie`, and the browser's `sec-fetch-*` and `sec-ch-*` hints. A paused request with a header the relay can't take (more than 32 headers, a name over 128 characters or a value over 8192), with or without a profile, fails with the new `FailureReason` `headers_unrelayable` instead of being relayed without that header. An empty `profileId` is refused at attach.

## 0.2.0

### Minor Changes

- b386258: Interceptor event URLs are origin-only, and refusal reasons on events are sanitized. CDP attach errors use fixed messages to avoid forwarding transport details.
- 8d77192: A refused event may include optional `retryable` and `requestId`. When `retryable` is missing, the event leaves it unset. The SDK does not invent it, and polling still follows only `relay_in_progress`.

  A reason on that event passes through when it matches `/^[a-z]+(_[a-z]+)*$/` and is at most 48 characters, including a reason this package does not list. Every other reason is `unrecognized`. `RefusalReason` is that open set. `KnownRefusalReason` names the reasons the relay emits today.

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

- 150bbd7: Better debug logging for browser-pay: an optional logger now receives browser step failures, and CDP errors name the method.
- Updated dependencies [1b9a5f6]
- Updated dependencies [a76b8bd]
  - @sapiom/analytics-core@0.3.0

## 0.1.1

### Patch Changes

- 28d38d7: Document that `injectionRef` is a UUID.
- 2129006: Hold a paused card request and post the same idempotency key again when the relay returns `relay_in_progress`, until the outcome is terminal or the relay deadline passes.
- dacee97: Retry a paused card relay on attempt timeout, transport failure, and router HTTP 502, 503, or 504, using the same idempotency key, until the total deadline. One attempt defaults to 25 seconds. The total wait defaults to 55 seconds.

## 0.1.0

### Minor Changes

- 9883adf: Add `@sapiom/browser-pay`. It pauses a held placeholder over CDP and posts David's relay body to `POST /v1/transactions/{id}/payment/relay`. The idempotency key is sha256 of method, URL, and body.

  The placeholder is `{ number, injectionRef }`. `PayLogger` only has `warn`. `failed.reason` is a closed set, and a match seen after detach is `detached`. `HttpRelayOptions` has no `timeoutMs`. `AttachOptions.timeoutMs` is the relay deadline. A non-2xx relay HTTP status is a transport failure and is not read as an outcome.

## 0.0.0

Initial package. The first published version is cut by Changesets. Pauses a held placeholder over CDP and relays it to `POST /v1/transactions/{id}/payment/relay`.
