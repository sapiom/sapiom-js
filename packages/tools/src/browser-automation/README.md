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
// Option A — withSession: opens + attempts close in a finally block.
const result = await sapiom.browserAutomation.withSession(async (session) => {
  session.cdpUrl; // pass to Playwright's browser.connectOverCDP(...)
  session.expiresAt; // payment-context expiry, including a settlement buffer
  session.maxDurationSec; // browser maximum duration in seconds
  session.liveViewUrl; // interactive view of the same browser, for a person to watch or take over
  session.liveViewMode; // "persistent" (whole session), or absent on older gateways

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
  settlement.capturedAmountUsd; // amount captured on successful settlement
}
```

`withSession` attempts to close the session in a `finally` block. It suppresses close errors
to preserve the callback result or error. Use `sessions.close` directly when your code must
check settlement success.

**Live view.** `session.liveViewUrl` opens an interactive view of the same browser in any web
browser, on any device. Use it to hand a step the agent should not do itself — a sign-in, a
one-time code, a payment confirmation — to a person: they act inside the same session, and your
code resumes over `cdpUrl` with cookies intact. Anyone holding the link can act in the browser, so
treat it like a credential: send it to one person over a channel you trust, and close the session
when the step is done. Current gateways return `session.liveViewMode: "persistent"`: the link
lasts for the whole session and can be reopened after a viewer disconnects. Single-use live
views are not supported. Older gateways omit `liveViewMode`. Local Run stub sessions do not
include `liveViewUrl`.

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
when finished to request settlement of actual usage.

`maxDurationSec` reports the configured browser maximum. `expiresAt` reports the gateway
payment-context expiry, which includes a settlement buffer. It does not prove the browser is
still active; the browser can end earlier due to the idle timeout or explicit close.

The gateway must support configurable session timeouts before you use these options. The
180-minute example above authorizes $3. The default 20-minute duration authorizes $1; see
[Billing](#billing) for the authorization policy and settlement limits.

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

| Operation                                         | Charge                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `sessions.create` / `sessions.createWithIdentity` | Authorizes $1 per started hour of the requested maximum duration; $1 by default, up to $4 |
| `sessions.close`                                  | Requests settlement of actual usage against the authorization                             |
| `screenshot` (one-shot)                           | `$0.01` per call                                                                          |
| `screenshot` (in-session)                         | No per-call charge                                                                        |
| `identities.create`                               | Free                                                                                      |

The authorization is `ceil(maxDurationMinutes / 60) × $1`, using 20 minutes when omitted.
For example, 60 minutes authorizes $1, 61 minutes authorizes $2, and 240 minutes authorizes $4.
This payment authorization does not impose a provider usage or traffic limit. Proxy usage can
exceed it, which can cause settlement to fail.

Sessions expire at the configured maximum duration, but expiry does not guarantee payment
settlement. Always close sessions when finished. `withSession` attempts to close the session;
use `sessions.close` directly and check `settled` when you must verify settlement success.

## Managed tasks

Managed tasks require the owned browser API in [Sapiom PR #5317](https://github.com/sapiom/Sapiom/pull/5317). Deploy that gateway before using these methods. The gateway uses the existing direct browser path. It selects the provider agent internally.

`sessions.createManaged` creates a tenant-owned session for `tasks`. The session also has a CDP connection. It has no permanent driver mode. Existing `sessions.create`, `createWithIdentity`, `close`, and `withSession` keep their current behavior. Use `closeManaged` for managed session cleanup and the session's CDP connection for screenshots.

```typescript
const browser = sapiom.browserAutomation;
// Save each mutation key before sending. Keep it for retries with the same input.
const createKey = crypto.randomUUID();
const taskKey = crypto.randomUUID();
const session = await browser.sessions.createManaged({
  idempotencyKey: createKey,
  recording: false,
  maxDurationMinutes: 20,
  idleTimeoutMinutes: 5,
});

try {
  const task = await browser.tasks.start({
    idempotencyKey: taskKey,
    sessionId: session.sessionId,
    instructions: "Read the public page title.",
    url: "https://example.com",
    maxSteps: 10,
    outputSchema: { type: "object", properties: { title: { type: "string" } } },
  });
  let current = await browser.tasks.get(task.taskId);
  while (["queued", "running"].includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await browser.tasks.get(task.taskId);
  }
  // Handle completed, failed, canceled, paused, or waiting_for_input here.
  console.log(current.status);
} finally {
  const closed = await browser.sessions.closeManaged(session.sessionId);
  // Persist a cleanup job and retry closeManaged if settlement is pending.
  console.log(closed.settlement);
}
```

Use `tasks.pause({ taskId, idempotencyKey })`, then read task state until it confirms pause before a CDP client or person acts. Use `tasks.interventions(taskId)` to read input requests. Reply with `tasks.respond({ taskId, idempotencyKey, requestId, response })`. Stop client CDP actions before `tasks.resume({ taskId, idempotencyKey })`. A stale task ID cannot control a newer task. The caller must prevent concurrent actions through a direct CDP connection.

Task states are `queued`, `running`, `paused`, `waiting_for_input`, `completed`, `failed`, and `canceled`. `result` and `error` are optional. `completed` means execution ended; inspect `result` to confirm that the task achieved its objective. Protected fields use `protectedValues`. They require `recording: false` and no persistent profile. Structured intervention responses have the same restriction.

After a lost response, retry the same operation with its original key and input. Do not create a new key for an uncertain operation. A completed session creation retry returns its connection URLs without another payment. For an uncertain creation, use `sessions.recover(createKey)`, even if no tags were supplied. A `cleanup_only` result permits `closeManaged` but does not permit tasks or return connection URLs. `unknown` means recovery has not confirmed a resource. `sessions.list({ tags, page })` lists owned resources; `sessions.get(sessionId)` reads session state.

Local Run has matching stub methods. Default stub tasks complete immediately. Use stub overrides to test waiting, failure, and cleanup paths.
