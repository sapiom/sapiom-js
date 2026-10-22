# @sapiom/browser-pay

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
