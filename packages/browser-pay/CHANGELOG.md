# @sapiom/browser-pay

## 0.1.0

### Minor Changes

- 9883adf: Add `@sapiom/browser-pay`. It pauses a held placeholder over CDP and posts David's relay body to `POST /v1/transactions/{id}/payment/relay`. The idempotency key is sha256 of method, URL, and body.

  The placeholder is `{ number, injectionRef }`. `PayLogger` only has `warn`. `failed.reason` is a closed set, and a match seen after detach is `detached`. `HttpRelayOptions` has no `timeoutMs`. `AttachOptions.timeoutMs` is the relay deadline. A non-2xx relay HTTP status is a transport failure and is not read as an outcome.

## 0.0.0

Initial package. The first published version is cut by Changesets. Pauses a held placeholder over CDP and relays it to `POST /v1/transactions/{id}/payment/relay`.
