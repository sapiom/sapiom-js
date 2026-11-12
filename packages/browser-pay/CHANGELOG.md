# @sapiom/browser-pay

## 0.6.1

### Patch Changes

- 15613e6: Forward Cookie headers for generic payment relays so merchant endpoints can use the browser session. Keep the Shopify profile header allowlist unchanged.
- 15613e6: Apply merchant `Set-Cookie` values from the relay response's optional `setCookies` field to the fulfilled payment response.

## 0.6.0

### Minor Changes

- 5cee5c4: Remove managed bank verification. `attachInterceptor` no longer registers a verification observer with the backend before a Shopify checkout, so attaching makes no extra request. `handle.verification`, the `verificationAdapter` option, the relay's `verification` transport and the `VerificationState`, `VerificationHandle` and `VerificationAdapterFactory` types are removed. Sapiom's backend never enabled the capability, so `handle.verification` was always absent with `httpPaymentRelay` or any relay that forwards to Sapiom. A custom `PaymentRelay` that supplied its own `verification` transport should drop it: the interceptor no longer reads it. A bank prompt stays in the checkout browser for the agent and the buyer to handle.

## 0.5.0

### Minor Changes

- 148d520: Add purchase-bound bank verification to the existing browser interceptor and relay credential
  channel, plus typed purchase verification responses and bounded transaction reads. Browser
  creation and ownership remain with the existing checkout integration.

  Match the backend's whole-number `maxWaitSeconds` range of 0 to 25 and keep HTTP
  deadlines active through response-body reads. Report body-read aborts as timeouts
  without retrying. Skip polling timers for verification sessions that register in
  a terminal state, and keep the adapter hook internal for now.

- 427aa77: Automatically observe supported Shopify merchant challenges on the existing browser, wait for the native completion callback and reconcile the same card-session receipt without repeating the checkout submission.

  Refuse another checkout submission when durable verification state already records a captured or launched challenge.

  Validate and bound the captured URL and single-field CReq form before reporting, preserve accepted protocol data exactly, and match the backend's 255-character card-session limit.

  Validate the CReq encoding, padding and supported message schema before capture. If optional verification registration fails, keep the existing checkout relay path available without a verification observer.

  Keep the native checkout on every registration error, including observer mismatches. With no optional observer, the interceptor preserves native Shopify submissions without blocking other merchant tabs. A registered observer retains its capture and takeover fences; the SDK never initiates another Pay to resolve uncertainty.

  Resolve challenge ancestry across browser sessions and support the verified current Shopify receipt query alongside the prior version. Before managed capture, unsupported checkout shapes and definite capture refusals preserve the native browser flow. Ambiguous reports retain the capture fence even when a later retry is refused.

  Bind the native callback to the tracked checkout and cancel oversized callback/receipt response streams before buffering their complete bodies.

  Allow the tracked checkout to navigate within its merchant origin before opening its callback, and leave definite backend termination before capture to the native checkout.

  Keep subsequent bank requests native when polling has already ended an uncaptured observation. Captured or launched challenges and ambiguous in-flight capture reports retain their submission fences.

  Discard a pending receipt read when inspection switches to native checkout before that read completes.

## Unreleased

- Documentation only: clarify hosted Pay MCP tenant defaults for new transactions,
  pinned-card retries with the same idempotency key, and the
  `no_saved_card`, `card_unavailable`, and `no_card_route` creation refusals.
  See [hosted MCP card selection](README.md#hosted-mcp-card-selection).
  This describes hosted-backend compatibility pending the corresponding
  [backend deployment](https://github.com/sapiom/Sapiom/pull/6539) and adds no SDK
  method or runtime change. Deployment is not confirmed by this documentation
  update.

- Discard receipt reconciliation that finishes after the checkout has returned to native handling.

- Preserve native bank requests when polling has already ended an uncaptured checkout observation, while retaining captured and ambiguous-capture fences.

- Preserve managed callback binding across checkout navigation within its merchant origin, and preserve native checkout when the backend ends observation without capturing a challenge.

- Bind the merchant callback to its original checkout frame tree, bound streamed callback/receipt responses, and clean up browser regression fixtures when setup fails.

- Follow merchant authentication frame ancestry across browser sessions, support the verified current Shopify receipt query, and retain native checkout on definite non-captures. Ambiguous captures and durable bank handoffs remain fenced.

- Preserve native checkout on every optional registration failure, including HTTP 409 observer mismatches. An unavailable observer does not block this purchase or other merchant tabs; registered observers retain their capture and takeover fences.

- Preserve the existing checkout relay path when optional verification registration fails, including a timeout or an observer mismatch.

- Validate CReq base64url encoding, padding and the supported message schema before capturing a bank challenge.

- Block repeat Shopify submissions using the backend's durable challenge flags, including after an adapter instance is replaced.

- Bound and validate captured bank forms before reporting, preserve accepted payloads unchanged, and align card-session identifiers with the backend's 255-character limit.

- Continue supported Shopify bank verification on the original browser with a one-use native callback and correlated receipt observation.

- Add transaction-bound verification observation over the existing browser CDP and relay credential channel. Preserve card-send retry fences and separate interaction from authentication and payment evidence.
- Keep the verification adapter hook internal for now, and avoid starting a polling timer when registration already returns a terminal session.

## 0.4.0

### Minor Changes

- 5b0eb88: `attachInterceptor` now takes a DevTools discovery URL (`http://` or
  `https://`), as `chromium.connectOverCDP` does. It reads the WebSocket URL from
  `json/version/` under the URL's path, with the query kept. An `https://`
  discovery URL uses TLS and must name a `wss://` WebSocket URL. Before, an
  `https://` URL went out as plain HTTP to port 80, query string included.

  An `http://` or `https://` URL whose path ends in `/devtools/browser/<id>` or
  `/devtools/page/<id>` is connected directly over `ws://` or `wss://`, so an
  `http://` DevTools URL that worked before still works, also behind a proxy path
  prefix. Any other `http://` URL is now read as a discovery URL: if it pointed at
  a WebSocket at another path, pass it as `ws://` instead. A URL with any other
  scheme is now refused before a connection opens.

### Patch Changes

- 5b0eb88: `attachInterceptor` no longer says it accepts a Playwright browser or page.
  They have no `wsEndpoint()`, so they were always refused. With Playwright, pass
  the browser's CDP URL.

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
