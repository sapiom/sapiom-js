# @sapiom/browser-pay

Browser-side payment interceptor. The agent types a governance placeholder into checkout. This package pauses that request over CDP and hands it to the relay. The browser is fulfilled with the processor's response, or the request fails. The placeholder is never continued.

## Sequence

1. The agent creates a checkout (UCP `create_checkout`).
2. Governance arms a placeholder and returns it with `continue_url`.
3. The agent opens a browser session and drives checkout, typing the placeholder.
4. `attachInterceptor` pauses the card request, including inside a payment iframe.
5. A match is `POST /v1/transactions/{transactionId}/payment/relay`.
6. The page receives the processor status, headers, and body. A refusal or a relay error fails the paused request.

## What David implements

`POST /v1/transactions/{transactionId}/payment/relay` with `x-api-key` and `idempotency-key`.

Request JSON:

```json
{
  "transactionId": "tx_…",
  "injectionRef": "inj_…",
  "merchantOrigin": "https://shop.example",
  "url": "https://checkout.pci.shopifyinc.com/sessions",
  "method": "POST",
  "headers": [["content-type", "application/json"], ["cookie", "…"]],
  "body": "<paused request body, placeholder included>",
  "idempotencyKey": "<sha256 hex of method, url, and body>"
}
```

`merchantOrigin` is the top-level page origin. `headers` is `[name, value][]` so repeated `Set-Cookie` values on the way back survive. `idempotencyKey` is also the `idempotency-key` header. Shopify's card iframe retries share one key. The body can contain the placeholder number. Do not log or persist `headers` (they can include HttpOnly cookies) or the body.

Success:

```json
{
  "kind": "relayed",
  "status": 200,
  "headers": [["content-type", "application/json"], ["set-cookie", "a=1"]],
  "body": "<processor body>",
  "bodyEncoding": "utf8"
}
```

`bodyEncoding` is optional and defaults to `utf8`. Use `base64` when the processor body is not UTF-8 text.

Refusal, nothing forwarded:

```json
{ "kind": "refused", "reason": "already_relayed" }
```

Reasons this client accepts: `already_relayed`, `total_changed`, `key_rotated`, `card_removed`, `expired`, `closed`, `refused`, `unknown`. Any other string is reported as `unknown`. A transport error, a redirect, or an unreadable body fails the paused browser request. It is not fulfilled with the refusal JSON.

The same `idempotencyKey` after a successful forward should return the stored processor response. A new key after the placeholder was consumed is `already_relayed`.

The page is fulfilled with `status`, `headers`, and `body`. `content-length`, `content-encoding`, and other hop-by-hop headers are dropped because CDP sends the body bytes itself. Return the body the page should read, not a gzip wrapper. If that fulfill fails, the paused request is failed and the placeholder is not continued. The agent event is `relayed_unfulfilled`.

## What an agent does

```typescript
import { attachInterceptor, httpPaymentRelay } from "@sapiom/browser-pay";

const handle = await attachInterceptor(cdpUrl, {
  relay: httpPaymentRelay({
    baseUrl: process.env.SAPIOM_BASE_URL ?? "https://api.sapiom.ai",
    apiKey: process.env.SAPIOM_API_KEY,
  }),
  transactionId,
  placeholder, // number, expMonth, expYear, cvc, injectionRef
  pauseOnlyUrls: ["checkout.pci.shopifyinc.com"],
});
```

`pauseOnlyUrls` limits Fetch to the payment host so a captcha solver on the checkout page is not paused. Omit it to pause every page and iframe.

Matching is a Luhn check on the held number, then an exact search for that digit sequence anywhere in the raw body. Spaces, dashes, and their URL-encoded or JSON-escaped forms count. Expiry and CVC are not compared. A different Luhn-valid number is continued, not relayed.

Identical in-flight retries (same method, URL, and body) share one relay call. A refusal is logged once. A transport failure drops the key so a later retry can resend.

Missing `Sec-Fetch-Site`, `Sec-Fetch-Dest`, `Accept-Language`, and `Cookie` are filled the way Chrome would, without overriding a header the request already has. `Sec-Fetch-Site` uses the schemeful same-site check with the last two hostname labels as the registrable domain. This package has no public suffix list, so a multi-label suffix such as `co.uk` is classified too broadly. Shopify's card hosts are not in that set.

Child iframes are auto-attached with `waitForDebuggerOnStart`. `Fetch.enable` runs on each child session before it is resumed. An iframe already on the payment host is attached before `attachInterceptor` resolves. A paused request whose CDP session was never attached is failed.

`detach()` fails in-flight paused requests before it disables Fetch. A process crash or a dropped CDP socket can still let Chrome continue those requests. WebSocket frames, client-side-encrypted card payloads, and worklet targets are not visible to this check.

`examples/attach.ts` is the agent-side script. It is not published.
