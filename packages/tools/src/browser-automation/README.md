# browserAutomation

Programmatic browser sessions, screenshots, and identity management. The same
browser automation tools your agents call over MCP, callable directly from your
code.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// One-shot screenshot — no session required:
const shot = await sapiom.browserAutomation.screenshot({
  url: "https://example.com",
});
shot.url; // absolute hosted image URL
shot.expiresAt; // ISO-8601 expiry (~1 hour)
```

Ambient import works too:

```typescript
import { browserAutomation } from "@sapiom/tools";
const shot = await browserAutomation.screenshot({ url: "https://example.com" });
```

## Sessions

A session gives you a CDP WebSocket (`cdpUrl`) that you can connect to with
Playwright or Puppeteer. Screenshots taken inside a session carry no per-call
charge — billing settles when you close the session.

```typescript
// Option A — withSession (recommended): opens + auto-closes in a finally block.
const result = await sapiom.browserAutomation.withSession(async (session) => {
  session.cdpUrl; // pass to Playwright's browser.connectOverCDP(...)
  session.expiresAt; // ISO-8601 max lifetime
  session.liveViewUrl; // interactive view of the same browser, for a person to watch or take over
  session.liveViewMode; // "single-use" (link dies after the first viewer disconnects), "persistent", or absent on older gateways

  // session-bound screenshot — sessionId injected automatically:
  const shot = await session.screenshot({ url: "https://example.com" });
  return shot.url;
});

// Option B — manual open/close:
const session = await sapiom.browserAutomation.sessions.create();
try {
  const shot = await sapiom.browserAutomation.screenshot({
    url: "https://example.com",
    sessionId: session.sessionId, // no per-call charge
  });
} finally {
  const settlement = await sapiom.browserAutomation.sessions.close(
    session.sessionId,
  );
  settlement.settled; // true on success
  settlement.capturedAmountUsd; // exact amount charged (≤ $1.00)
}
```

`withSession` is strongly recommended: it guarantees the session is always
closed — preventing the auto-expiry $1.00 ceiling charge if the session leaks.

**Live view.** `session.liveViewUrl` opens an interactive view of the same browser in any web
browser, on any device. Use it to hand a step the agent should not do itself — a sign-in, a
one-time code, a payment confirmation — to a person: they act inside the same session, and your
code resumes over `cdpUrl` with cookies intact. Anyone holding the link can act in the browser, so
treat it like a credential: send it to one person over a channel you trust, and close the session
when the step is done. `session.liveViewMode` reports the lifetime of that link: `"single-use"`
(the gateway default) expires after the first viewer disconnects, `"persistent"` lasts for the whole
session; older gateways omit the field. Local Run stub
sessions do not include `liveViewUrl`.

## Sessions with identity

When you have a stored identity, open a session pre-authenticated:

```typescript
const result = await sapiom.browserAutomation.withSession(
  async (session) => {
    // browser starts logged in to the identity's site
    const shot = await session.screenshot({
      url: "https://app.example.com/dashboard",
    });
    return shot;
  },
  { identityId: "id_abc123" },
);
```

## Session lifetime

Pass integer-minute timeout options to `sessions.create`, `sessions.createWithIdentity`, or
`withSession`:

```typescript
const session = await sapiom.browserAutomation.sessions.create({
  idleTimeoutMinutes: 30,
  maxDurationMinutes: 180,
});
```

`idleTimeoutMinutes` defaults to 5 and accepts 1–60; `maxDurationMinutes` defaults to 20 and
accepts 1–240. Values outside those ranges are rejected by the gateway with HTTP 400. The idle
timer starts only when all CDP/live-view clients disconnect. Reconnecting resets idle but never
extends maximum duration, so idle 30 / max 20 still ends at 20 minutes. Always close sessions
when finished to settle usage early.

## Screenshot options

```typescript
const shot = await sapiom.browserAutomation.screenshot({
  url: "https://example.com",
  width: 1280, // viewport width in pixels
  height: 800, // viewport height in pixels
  fullPage: true, // capture full scrollable height
  format: "jpeg", // "png" (default) or "jpeg"
  imageQuality: 85, // JPEG quality 0–100 (only for format: "jpeg")
  waitMs: 1000, // wait 1 s after load before capturing
});
```

## Identities

Store credentials once; reuse them across sessions:

```typescript
const identity = await sapiom.browserAutomation.identities.create({
  source: "https://app.example.com/login", // login page URL (required)
  name: "My App Account", // optional label
  credentials: [
    {
      type: "username_password",
      username: "user@example.com",
      password: "secret",
    },
  ],
  shouldCache: true,
});

identity.id; // pass as identityId to sessions.createWithIdentity / withSession
identity.status; // lifecycle status
```

Supported credential types: `"profile"`, `"username_password"`, `"authenticator"`,
`"custom"`.

## Error handling

Failed requests throw `BrowserAutomationHttpError` (carries `status` + parsed
`body`), exported from `@sapiom/tools`.

```typescript
import { BrowserAutomationHttpError } from "@sapiom/tools";

try {
  await sapiom.browserAutomation.screenshot({ url: "https://example.com" });
} catch (err) {
  if (err instanceof BrowserAutomationHttpError) {
    console.error(err.status, err.body);
    // 401 — missing or invalid API key
    // 400 — bad parameters
    // 404 — session not found or expired
  }
}
```

## Billing

| Operation                                         | Charge                                          |
| ------------------------------------------------- | ----------------------------------------------- |
| `sessions.create` / `sessions.createWithIdentity` | `upto $1.00` (pre-authorized; settled on close) |
| `sessions.close`                                  | Settles actual cost (≤ $1.00)                   |
| `screenshot` (one-shot)                           | `$0.01` per call                                |
| `screenshot` (in-session)                         | No per-call charge                              |
| `identities.create`                               | Free                                            |

Sessions auto-expire at the configured maximum duration; if never explicitly closed, billing
settles at the applicable authorization ceiling. Use `withSession` to guarantee close-on-exit.
