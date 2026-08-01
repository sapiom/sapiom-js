# Logged-In Page Screenshots

Open a real hosted browser, optionally log in, visit the pages you list, and capture
each one as a hosted image — the rendered view a signed-in user sees, which a scraper
can't reach. Built on `ctx.sapiom.browserAutomation`.

## What it does

```
start ─▶ login (browser.identity) ─▶ capture (browser.session) ─▶ done
start ─────────────────────────────▶ capture (browser.session) ─▶ done
```

1. **start** — resolves the `urls` to capture and decides whether to log in. A login
   needs `loginUrl`, `loginUsername`, and the `BROWSER_LOGIN_PASSWORD` secret; miss
   any and it captures the public view and says so.
2. **login** — stores the credentials as a browser identity
   (`ctx.sapiom.browserAutomation.identities.create`, free) so the session opens
   signed in. If it fails, it degrades to a public capture rather than failing.
3. **capture** — opens ONE browser session (`ctx.sapiom.browserAutomation.withSession`)
   and screenshots every page in it. In-session screenshots have no per-shot charge,
   and the session always closes in a `finally`, so it never leaks. A page that fails
   becomes a failed row; the rest are still captured.
4. **done** — terminal; returns one row per requested URL (image URL or the failure),
   plus `authenticated` and the captured count.

Input:
`{ "urls": ["https://…"], "loginUrl": "https://…/login", "loginUsername": "you@…", "fullPage": false }`

- `urls` — the pages to capture. Defaults to two stable public pages.
- `loginUrl` + `loginUsername` + the `BROWSER_LOGIN_PASSWORD` secret — set all three
  to capture behind a login. Omit them for public capture.
- `fullPage: true` — capture the full scrollable height instead of the viewport.

## Run it

- **Use this template** in the app — Sapiom builds and deploys it, and a run with no
  input captures two public pages.
- **Locally:** `run_local` traces the flow for free (the browser capability is stubbed).
