# @sapiom/browser-pay

Browser-side payment interceptor for a card checkout in the agent's own Chromium.

The agent types a placeholder card into the checkout. This module attaches over CDP, pauses the request whose body contains that placeholder, and sends it to the relay. The relay's response fulfills the paused request. The browser never sees a real card value.

M0 pauses page and iframe requests and inspects the body. Captcha widgets, extension pages, and workers are left running so a session captcha solver is not held on the debugger. Injection profiles (which URLs to pause) are deferred. A request without the placeholder is continued. A match is relayed once. A mismatch, refusal, timeout, or network error fails the paused request; the placeholder is never sent on.

## Attach

`attachInterceptor` opens its own CDP connection. Pass a websocket URL, or a Playwright/Puppeteer browser or page that exposes one. The same function is what a later hosted-attach mode would call.

An agent platform that already uses Sapiom for the browser creates a session, then attaches. Captcha solving is the browser capability's `captchaSolver` flag. The provider turns that solver off unless `proxy` is also set; `stealth` and `headless: false` match the headful residential session the solver expects. This package does not solve captchas.

```typescript
import { randomUUID } from "node:crypto";
import { createClient } from "@sapiom/tools";
import { attachInterceptor, httpPaymentRelay } from "@sapiom/browser-pay";

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
const session = await sapiom.browserAutomation.sessions.createManaged({
  idempotencyKey: randomUUID(),
  recording: false,
  captchaSolver: true,
  proxy: true,
  stealth: true,
  headless: false,
});
const handle = await attachInterceptor(session.cdpUrl, {
  relay: httpPaymentRelay({
    baseUrl: process.env.SAPIOM_BASE_URL ?? "https://api.sapiom.ai",
    apiKey: process.env.SAPIOM_API_KEY,
  }),
  transactionId: process.env.TRANSACTION_ID!,
  placeholder: {
    number: process.env.PLACEHOLDER_NUMBER!,
    expMonth: Number(process.env.PLACEHOLDER_EXP_MONTH),
    expYear: Number(process.env.PLACEHOLDER_EXP_YEAR),
    cvc: process.env.PLACEHOLDER_CVC!,
    injectionRef: process.env.INJECTION_REF!,
  },
});
handle.on((event) => {
  // paused, relayed, refused, failed. Card numbers are masked if one appears in a URL.
});
```

A platform that already has a CDP URL skips session create:

```typescript
await attachInterceptor(process.env.CDP_URL!, {
  relay,
  transactionId,
  placeholder,
});
```

`examples/attach.ts` is that script. The HTTP relay calls `POST /v1/transactions/:id/payment/relay` with the `x-api-key` header. That route may not be deployed yet. Swap a demo relay in without changing the interceptor: both implement `PaymentRelay`.

`merchantOrigin` on the relay request is the top-level page origin (scheme + host), not the card iframe's host.

## Relay contract

Types and fixtures live in this package (`RelayRequest`, `RelayResponse`, `shopifyCardSessionRoundTrip`, `relayRefusalFixtures`). The Shopify fixture posts to `https://checkout.pci.shopifyinc.com/sessions`. A refusal is `{ ok: false, reason }` and does not echo the request. Reasons: `wrong_key`, `unknown_placeholder`, `closed_placeholder`, `expired_placeholder`, `off_profile_destination`, `replay`, `merchant_origin`, `changed_total`, `cancelled`.

Placeholder detection matches the backend's placeholder-detection rules (separators, 13–19 digits, Luhn, then expiry and CVC when those fields are present). It is duplicated here so a browser bundle does not import the backend. It should move to a shared package.

## Shopify dev-store script

`examples/shopify-e2e.ts` is opt-in and is not part of `pnpm test`. It launches headless Chromium with a CDP port, or `BROWSER=sapiom` to create a Sapiom browser session (`captchaSolver`, `proxy`, `stealth`, and `headless: false`) and attach to the returned CDP URL. A second Playwright connection drives the dev store. The store is `https://1a2uh3-r7.myshopify.com`, variant `67652208394372`, Shopify Payments test mode.

Demo relays live under `examples/relays/` and are not published:

- `RELAY=bogus` substitutes Shopify Payments' published test card (Visa ending 4242, expiry 12/2030, any CVC) and forwards.
- `RELAY=bt` vaults that test card in Basis Theory and sends the paused request through the ephemeral proxy with token expressions. `BT_PRIVATE_KEY` may be a private application key or a test-tenant management key. A management key cannot create tokens, so the script creates a private application for the run and deletes it afterwards. The card token is deleted too. `BT_TOKEN_ID` is not required.
- `RELAY=http` uses `httpPaymentRelay` (`SAPIOM_BASE_URL` + `SAPIOM_API_KEY`).

```bash
cd packages/browser-pay
RELAY=bogus npx tsx examples/shopify-e2e.ts
BROWSER=sapiom RELAY=bt SAPIOM_API_KEY=… BT_PRIVATE_KEY=… npx tsx examples/shopify-e2e.ts
MODE=refuse RELAY=bogus npx tsx examples/shopify-e2e.ts
```

`MODE=refuse` fails the card request closed so the placeholder is not forwarded and no order is confirmed. The script clicks pay once. With `BROWSER=sapiom` it waits for the session's captcha solver. It does not bypass a captcha itself, and it stops if one is still showing.
