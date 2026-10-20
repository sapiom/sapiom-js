# @sapiom/browser-pay

Browser-side payment interceptor. The agent types a governance placeholder into checkout. This package pauses that request over CDP and hands it to David's relay. The browser is fulfilled with the processor's response, or the request fails. The placeholder is never continued.

## Sequence

1. The agent creates a checkout (UCP `create_checkout`).
2. Governance arms a placeholder and returns it with `continue_url`.
3. The agent opens a browser session and drives checkout, typing the placeholder.
4. `attachInterceptor` pauses the card request, including inside a payment iframe.
5. A match is `POST /v1/transactions/{transactionId}/payment/relay`.
6. The page receives the processor status, headers, and body. A terminal refusal, an unknown outcome, or a relay error fails the paused request. `relay_in_progress` keeps the request paused and asks again with the same idempotency key.

## Relay contract

`POST /v1/transactions/{transactionId}/payment/relay` with `x-api-key`. `transactionId` is only in the path. The JSON body is:

```json
{
  "injectionRef": "550e8400-e29b-41d4-a716-446655440000",
  "profileId": "shopify-card-vault",
  "pageOrigin": "https://shop.example",
  "request": {
    "method": "POST",
    "url": "https://checkout.pci.shopifyinc.com/sessions",
    "headers": { "content-type": "application/json" },
    "body": "<paused request body, placeholder included>"
  },
  "idempotencyKey": "<sha256 hex of method, url, and body>"
}
```

`injectionRef` is a UUID. `pageOrigin` is the top-level page origin. `headers` is a lowercased string map. This client sends only `accept`, `content-type`, and `shopify-identification-signature`, and drops a value longer than 8192 characters. `idempotencyKey` is sha256 of method, URL, and body, separated by NUL. It is not sent as a header. Shopify's card iframe retries share one key. Do not log or persist `request.headers` or `request.body`.

Success:

```json
{
  "outcome": "relayed",
  "response": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "<processor body>"
  }
}
```

`response.body` is the string the page should read. `response.headers` is a string map. Hop-by-hop headers are dropped because CDP sends the body bytes itself.

Refusal, nothing forwarded:

```json
{ "outcome": "refused", "reason": "already_relayed" }
```

The `refused` event and logger pass through only these known reasons: `unknown_injection`, `injection_expired`, `payment_released`, `key_rotated`, `already_relayed`, `relay_in_progress`, `card_removed`, `payment_not_authorized`, `total_changed`, `destination_not_allowed`, `card_fields_invalid`, `merchant_mismatch`, and `provider_unavailable`. Any other reason becomes `unrecognized`. `relay_in_progress` is not terminal. The paused request stays open and the same idempotency key is posted again until the outcome is terminal or the deadline passes.

Event `url` is origin-only (`scheme://host[:port]`), with any held placeholder masked. An opaque origin uses its scheme (for example, `about:`); an unparseable URL is `""`. Paths, queries, fragments, and userinfo are never included. Attach errors use fixed messages and do not include transport details.

No answer after the send:

```json
{ "outcome": "unknown" }
```

The injection is consumed. The paused request fails and the same body is not sent again.

A redirect, a non-2xx HTTP status other than 502, 503, or 504, or an unreadable body fails the paused browser request. David's relay returns HTTP 200 for every outcome, so a 401 or 500 is not read as `unknown` or `refused`. It is not fulfilled with the error JSON. A transport error, a per-attempt timeout, and a router HTTP 502, 503, or 504 are posted again with the same idempotency key. If fulfill fails, the paused request is failed and the agent event is `relayed_unfulfilled`.

## What an agent does

```typescript
import { attachInterceptor, httpPaymentRelay } from "@sapiom/browser-pay";

const handle = await attachInterceptor(cdpUrl, {
  relay: httpPaymentRelay({
    baseUrl: process.env.SAPIOM_BASE_URL ?? "https://api.sapiom.ai",
    apiKey: process.env.SAPIOM_API_KEY,
    transactionId,
  }),
  profileId: "shopify-card-vault",
  placeholder,
});
```

Call `handle.on` after `attachInterceptor` resolves. Events emitted while attach was running, including a target that could not arm Fetch, are delivered to that first subscriber.

A request is relayed when the held placeholder number appears in the URL or body. An exact match counts, and so do digits split by spaces or dashes, including the URL-encoded and JSON-escaped forms of those separators. `placeholder` is `{ number, injectionRef }`. `injectionRef` is a UUID. The backend's `checkPlaceholderUse` decides whether the number is valid. A paused request that does not hold the placeholder is continued.

A relayed response fails the paused request only when that response contains the held placeholder number.

Identical in-flight retries (same method, URL, and body) share one relay poll, including the backoff. `AttachOptions.timeoutMs` is the total deadline. It defaults to 55 seconds: two 25 second attempts plus backoff, so a first attempt cut near the router limit can still be read back by a second POST. `AttachOptions.attemptTimeoutMs` is one POST. It defaults to 25 seconds so the client aborts before a router cuts the socket at 30 seconds. While the relay answers `relay_in_progress`, or an attempt times out, or the transport fails, or the router returns 502, 503, or 504, the same key is posted again after a bounded backoff. At the deadline the paused request fails with `timeout`. A relay that ignores abort still fails when the deadline passes. One waiter's timeout does not abort a later waiter of the same flight. A terminal refusal is logged once. `outcome: "unknown"` is not sent again. HTTP 502, 503, and 504 retries are how `httpPaymentRelay` classifies a failure. A custom relay is retried when the attempt abort rejects its promise.

Captcha widgets, extension pages, and workers are not paused. A blank iframe, including `about:blank`, stays paused so a navigation onto the card URL cannot slip through. A placeholder that shows up on any other page or iframe is relayed.

Child iframes are auto-attached with `waitForDebuggerOnStart`. `Fetch.enable` runs on each child session before it is resumed. An iframe that already exists is attached before `attachInterceptor` resolves. A paused request whose CDP session was never attached is failed.

`detach()` fails in-flight paused requests before it disables Fetch. A process crash or a dropped CDP socket can still let Chrome continue those requests. WebSocket frames, client-side-encrypted card payloads, and worklet targets are not visible to this check.

`examples/attach.ts` is the agent-side script. It is not published.
