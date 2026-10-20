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

The reason string is passed through. Reasons David returns include `already_relayed`, `total_changed`, `key_rotated`, `card_removed`, `unknown_injection`, `injection_expired`, `payment_released`, `relay_in_progress`, `payment_not_authorized`, `destination_not_allowed`, `card_fields_invalid`, `merchant_mismatch`, and `provider_unavailable`. `relay_in_progress` is not terminal. The paused request stays open and the same idempotency key is posted again until the outcome is terminal or the deadline passes.

No answer after the send:

```json
{ "outcome": "unknown" }
```

The injection is consumed. The paused request fails and the same body is not sent again.

A transport error, a redirect, a non-2xx HTTP status, or an unreadable body fails the paused browser request. David's relay returns HTTP 200 for every outcome, so a 401 or 500 is not read as `unknown` or `refused`. It is not fulfilled with the error JSON. If fulfill fails, the paused request is failed and the agent event is `relayed_unfulfilled`.

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

Identical in-flight retries (same method, URL, and body) share one relay poll, including the backoff between `relay_in_progress` answers. `AttachOptions.timeoutMs` is the deadline for a terminal outcome. It defaults to 20 seconds. While the relay answers `relay_in_progress`, the same key is posted again after a bounded backoff. At the deadline the paused request fails with `timeout`. A relay that ignores abort still fails when the deadline passes, and one waiter's timeout does not abort a later waiter of the same flight. A terminal refusal is logged once. A transport failure drops the key so a later retry can resend. `outcome: "unknown"` does not.

Captcha widgets, extension pages, and workers are not paused. A blank iframe, including `about:blank`, stays paused so a navigation onto the card URL cannot slip through. A placeholder that shows up on any other page or iframe is relayed.

Child iframes are auto-attached with `waitForDebuggerOnStart`. `Fetch.enable` runs on each child session before it is resumed. An iframe that already exists is attached before `attachInterceptor` resolves. A paused request whose CDP session was never attached is failed.

`detach()` fails in-flight paused requests before it disables Fetch. A process crash or a dropped CDP socket can still let Chrome continue those requests. WebSocket frames, client-side-encrypted card payloads, and worklet targets are not visible to this check.

`examples/attach.ts` is the agent-side script. It is not published.
