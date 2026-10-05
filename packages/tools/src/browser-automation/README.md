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

## Managed sessions and tasks

Use `browserAutomation.sessions.createManaged` to open a browser for either your own
model and CDP driver or a task submitted through `browserAutomation.tasks`. Sapiom
selects the task implementation internally. No provider credential or selection is
needed. Existing `sessions.create`, `createWithIdentity`, `close`, and `withSession`
keep their current API. Close managed sessions with `closeManaged`.

Supply `recording` explicitly. Omitted timeouts default to 5 minutes idle and 20
minutes maximum duration. The same timeout ranges and disconnect rules documented
above apply. Connection URLs are opaque: pass them to a CDP driver or live viewer;
do not parse their host, path, or query parameters.

Treat `sessionId`, `taskId`, `profileId`, and connection URLs as credentials. Your
application must enforce access for each user and conversation. Do not log them.
The SDK's usage analytics records route templates such as `/v1/browser/tasks/:taskId`,
never these IDs or creation keys.
Save returned IDs; there is no session-list endpoint. Tags are metadata, not a
session discovery or access mechanism.

### Control with your own model and driver

```typescript
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createClient } from "@sapiom/tools";

const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
const browser = sapiom.browserAutomation;
// Store this key before sending, so a lost response can be retried with the same key.
const createKey = randomUUID();
const session = await browser.sessions.createManaged({
  idempotencyKey: createKey,
  recording: false,
});
try {
  const driver = await chromium.connectOverCDP(session.cdpUrl);
  try {
    const page = driver.contexts()[0].pages()[0];
    await page.goto("https://example.com");
    console.log(await page.title());
    // Your model can choose further actions for this driver.
  } finally {
    await driver.close();
  }
} finally {
  const closed = await browser.sessions.closeManaged(session.sessionId);
  if (closed.settlement === "pending") {
    // Store a cleanup job to retry closeManaged until settlement is completed.
    console.error("Browser settlement is pending");
  }
  await sapiom.shutdown();
}
```

### Submit instructions and handle human input

The following function accepts an application callback that asks the user for a
response. Put a deadline on that callback as well. Save each mutation key before
sending and retain it for retries of the same input. The function keeps each answer
with its key and resends both until the response is confirmed.

```typescript
import { randomUUID } from "node:crypto";
import { BrowserAutomationHttpError, createClient } from "@sapiom/tools";

async function readTitle(askUser: (message: string) => Promise<string>) {
  const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
  const browser = sapiom.browserAutomation;
  const createKey = randomUUID();
  const taskKey = randomUUID();
  const session = await browser.sessions.createManaged({
    idempotencyKey: createKey,
    recording: false,
  });
  const deadline = Date.now() + 120_000;
  const answers = new Map<
    string,
    { key: string; response: string; confirmed: boolean }
  >();
  try {
    const task = await browser.tasks.start({
      idempotencyKey: taskKey,
      sessionId: session.sessionId,
      instructions: "Read the public page title.",
      url: "https://example.com",
      maxSteps: 10,
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    });
    while (Date.now() < deadline) {
      const current = await browser.tasks.get(task.taskId);
      if (current.status === "completed") {
        // Inspect and validate the result before using it. Completion alone is not success.
        return current.result;
      }
      if (["failed", "canceled"].includes(current.status)) {
        throw new Error(`Browser task ${current.status}`);
      }
      if (current.status === "paused") {
        throw new Error("Browser task needs an explicit resume decision");
      }
      if (current.status === "waiting_for_input") {
        const pending = await browser.tasks.interventions(task.taskId);
        for (const request of pending.requests) {
          let answer = answers.get(request.requestId);
          if (!answer) {
            const response = await askUser(
              request.message ?? "Browser input required",
            );
            answer = { key: randomUUID(), response, confirmed: false };
            answers.set(request.requestId, answer);
          }
          // A confirmed response can stay visible for a while. Do not send it again.
          if (answer.confirmed) continue;
          try {
            await browser.tasks.respond({
              taskId: task.taskId,
              requestId: request.requestId,
              response: answer.response,
              idempotencyKey: answer.key,
            });
            answer.confirmed = true;
          } catch (error) {
            // Resend an uncertain outcome on the next poll with the same key and answer.
            const uncertain =
              !(error instanceof BrowserAutomationHttpError) ||
              error.code === "browser_outcome_unknown";
            if (!uncertain) throw error;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Browser task wait limit reached");
  } finally {
    const closed = await browser.sessions.closeManaged(session.sessionId);
    if (closed.settlement === "pending") {
      // Store a cleanup job to retry closeManaged with this session ID.
      console.error("Browser settlement is pending");
    }
    await sapiom.shutdown();
  }
}
```

Task states are `queued`, `running`, `paused`, `waiting_for_input`, `completed`,
`failed`, and `canceled`. `result` and `error` are optional and are not assumed to
match your output schema automatically. Inspect the returned content and validate
it in your application. `maxSteps` accepts 1–80.

A session has no permanent driver mode. Stop CDP actions before starting or resuming
a task. To take control, call `tasks.pause({ taskId, idempotencyKey })`, then read
task state until pause is confirmed. `waiting_for_input` can remain visible after
pause; confirm the pause receipt before acting. An unconfirmed control returns
HTTP 409. The caller must prevent concurrent CDP actions. A stale task ID cannot
control a newer task.

### Profiles

Profiles save browser state for a later session. They use generated secret IDs,
not caller-chosen names. Save only from an unrecorded session without protected
inputs. Finish any task first. Close the source session to complete the save, then
poll `profiles.get` until its status is `ready` before restoring it. Bound the poll
and keep the ID for cleanup if readiness is delayed.

```typescript
const profile = await browser.profiles.save({
  sessionId: session.sessionId,
  idempotencyKey: savedProfileKey,
});
await browser.sessions.closeManaged(session.sessionId);
const state = await browser.profiles.get(profile.profileId);
if (state.status === "ready") {
  const restored = await browser.sessions.createManaged({
    idempotencyKey: savedRestoreKey,
    recording: false,
    profileId: profile.profileId,
  });
  // Use restored.cdpUrl or tasks, then close restored.sessionId.
}
await browser.profiles.delete({
  profileId: profile.profileId,
  idempotencyKey: savedDeleteKey,
});
```

### Recordings

Recording methods require a session created with `recording: true`. Pause and
resume apply while it is active. List, fetch, and delete use the same secret session
ID. `fetch` streams the primary video through Sapiom and returns a standard
`Response`, including HTTP 206 and range headers when requested. It does not return
a provider download URL. Consume or cancel the body; supply `signal` to abort.

```typescript
await browser.recordings.pause({ sessionId, idempotencyKey: savedPauseKey });
await browser.recordings.resume({ sessionId, idempotencyKey: savedResumeKey });
await browser.sessions.closeManaged(sessionId);
const recordings = await browser.recordings.list(sessionId);
const video = await browser.recordings.fetch({
  sessionId,
  range: "bytes=0-1023",
});
const bytes = await video.arrayBuffer();
await browser.recordings.delete({ sessionId, recordingId: "primary" });
```

A delete response acknowledges deletion. It does not prove physical file removal.
A later video read can return HTTP 502; do not use that response or a stale listing
as proof of deletion. Protected inputs and profile saves are not allowed on recorded
sessions. `protectedValues` and structured intervention responses require an
unrecorded session with no persistent profile.

### Retries, recovery, and billing

After a lost response, retry the same operation with its original key and input.
Do not generate a new key for an uncertain operation. The SDK makes one request per
call; it does not automatically repeat mutations. `BrowserAutomationHttpError`
exposes HTTP `status`, an optional Sapiom `code`, and `body` for inspection. Its
message omits the response body. Do not log the body: it can contain sensitive data.
A `browser_outcome_unknown` code means that execution is not confirmed; retain the
key even if the task later completes. A confirmed local rejection can be retried
with the same key after the blocking condition clears.

A completed session creation retry returns the saved connection URLs without
another payment. `sessions.recover(createKey)` uses the original Sapiom API key and
returns session IDs and states, not connection URLs. Retry the original creation
to retrieve a completed receipt. A rotated API key cannot recover an old creation.
Direct HTTP callers using a payment proof must retain the same proof for recovery.
`cleanup_only` permits cleanup, not tasks; `unknown` means no resource is confirmed.

Session creation authorizes a spending limit. Closing captures actual usage; the
limit is not the final charge. Check `settlement` and retain a cleanup job when it
is `pending`. Session expiry alone does not guarantee settlement.

Local Run has matching stub methods, including profiles and recordings. Default
tasks complete immediately and default video responses have an empty body. Use
stub overrides to test human input, delayed readiness, range responses, errors,
and pending settlement.
