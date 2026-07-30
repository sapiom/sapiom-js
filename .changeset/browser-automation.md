---
"@sapiom/tools": minor
---

Add the `browserAutomation` capability with sessions, screenshots, and identity management:

- `browserAutomation.sessions.create()` — open a browser session; returns a `BrowserSession` with a CDP WebSocket (`cdpUrl`) for Playwright/Puppeteer.
- `browserAutomation.sessions.createWithIdentity({ identityId })` — open a session pre-authenticated with a stored identity.
- `browserAutomation.sessions.close(sessionId)` — close a session and settle its billing; returns a `SessionSettlement` with `capturedAmountUsd` and `creditsUsed`.
- `browserAutomation.screenshot(input)` — one-shot screenshot (`url` required, billed at `$0.01`) or session-mode screenshot (`sessionId` provided, no per-call charge). The returned `url` is an absolute hosted image URL.
- `browserAutomation.withSession(fn, opts?)` — the recommended pattern: opens a session, invokes `fn(activeSession)`, and always closes in a `finally` block so sessions never leak at the $1.00 ceiling. The `activeSession` carries all `BrowserSession` fields plus a session-bound `screenshot` convenience.
- `browserAutomation.identities.create(input)` — store credentials for automatic login during sessions (free).
- `BrowserAutomationHttpError` (`{ status, body }`) — thrown on non-2xx responses; re-exported from the barrel.
- `"./browser-automation"` subpath export added to `package.json`.
- `createStubClient()` wires a deterministic `browserAutomation` stub for every operation, including `withSession` invoking `fn` with a stub `ActiveSession`.
