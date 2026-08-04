# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Logged-In Page
Screenshots** — authored against `@sapiom/agent`. It drives a real hosted browser to
(optionally) log in and capture the pages you list as hosted images:
`start` → `login` → `capture` → `done`, where `login` is skipped for public capture.
Inside a step's `run`, Sapiom capabilities are pre-auth'd on `ctx.sapiom` (here:
`ctx.sapiom.browserAutomation.identities.create`,
`ctx.sapiom.browserAutomation.withSession`, and the session-bound `session.screenshot`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined
  by `@sapiom/tools` — read the types / use autocomplete rather than guessing.
- **One session captures every page.** `capture` uses
  `ctx.sapiom.browserAutomation.withSession` and calls `session.screenshot({ url })`
  per page inside it. In-session screenshots carry no per-shot charge — billing
  settles once when the session closes — so don't replace them with per-URL one-shot
  `browserAutomation.screenshot({ url })` calls, which bill each time.
- **`withSession` always closes.** It runs your `fn` and closes the session in a
  `finally`, so the session can't leak at the $1.00 ceiling. Keep the capture loop
  inside the `withSession` callback.
- **Login is optional and honest.** A login needs `loginUrl`, `loginUsername`, and
  the `BROWSER_LOGIN_PASSWORD` secret (read from `process.env`, never an input). Miss
  any of them, or let `identities.create` fail, and the run captures the PUBLIC view
  and reports `authenticated: false` — it must never claim a logged-in capture it
  didn't make.
- **Every URL yields a row.** A page that fails to capture becomes a
  `{ ok: false }` row, and if the session itself can't open, every requested URL is
  recorded as a miss. That keeps the run terminal and the account complete — keep it.
- **Runs with nothing.** `start` defaults `urls` to two stable public pages, so `{}`
  in produces real screenshots with no login.

## Test it

- `run_local` traces the flow with no Sapiom capability spend — the browser capability is stubbed,
  so `session.screenshot` returns a stub image URL.
- Deployed, a run with `{}` opens a session and captures two public pages.
