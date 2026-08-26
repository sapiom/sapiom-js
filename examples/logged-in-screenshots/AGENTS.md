# Working in this agent

This project defines exactly one Sapiom agent in `index.ts` — **Website QA
Crawler** — authored against `@sapiom/agent`. It crawls a bounded set of a
site's pages, render-checks and screenshots each one, audits content with a
model, and checks link integrity (broken pages, Terms/Privacy present and
resolving):
`crawl` → `render` → `audit` → `linkCheck` → `report`, with a `rejected`
off-ramp when `siteUrl` isn't a usable URL. Inside a step's `run`, Sapiom
capabilities are pre-auth'd on `ctx.sapiom` (here: `ctx.sapiom.search.scrape`,
`ctx.sapiom.browserAutomation.withSession` + the session-bound
`session.screenshot`, and `ctx.sapiom.llm.run`).

## Authoring

- An agent is `defineAgent({ entry, steps })`; each step is
  `defineStep({ name, next, run })`. Keep exactly one `defineAgent(...)` export.
- **Capabilities come from the types.** What's available on `ctx.sapiom` is defined
  by `@sapiom/tools` — read the types / use autocomplete rather than guessing.
- **The crawl is bounded.** `crawl` caps the pages it reads at `MAX_PAGES`
  (homepage + a handful more), so cost and runtime stay capped regardless of
  how large the target site is. Legal-looking links (Terms/Privacy) are
  prioritized into that budget so link integrity gets a real answer whenever
  one exists.
- **One session captures every page.** `render` uses
  `ctx.sapiom.browserAutomation.withSession` and calls `session.screenshot({ url })`
  per page inside it. In-session screenshots carry no per-shot charge — billing
  settles once when the session closes — so don't replace them with per-URL one-shot
  `browserAutomation.screenshot({ url })` calls, which bill each time.
- **`withSession` always closes.** It runs your `fn` and closes the session in a
  `finally`, so the session can't leak at the $1.00 ceiling. Keep the render
  loop inside the `withSession` callback.
- **The audit is one model call.** `audit` reads every crawled page's content
  in a single `ctx.sapiom.llm.run` call rather than one call per page —
  keep it that way; chaining per-page model calls would compound drift and
  cost with no benefit here.
- **Every page yields a row.** A page that fails to crawl, render, or resolve
  becomes a `{ ok: false }` / `{ rendered: false }` row, never a thrown error —
  that keeps the run terminal and the report complete. Keep it.
- **Runs with nothing.** `crawl` defaults `siteUrl` to `https://sapiom.ai`, so
  `{}` in produces a real crawl, real screenshots, and a real report.

## Test it

- `run_local` traces the flow offline for free — every capability is stubbed,
  so `search.scrape` and `session.screenshot` return stub content.
- Deployed, a run with `{}` crawls `https://sapiom.ai` and produces a QA
  report.
