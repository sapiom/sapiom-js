# Website QA Crawler

Point it at a site and it crawls a bounded set of pages, checks that each one
renders, audits the content and structure with a model, and verifies link
integrity — including whether Terms and Privacy links exist and resolve —
then compiles a QA report with screenshots and a plain list of what's broken.
Built on `ctx.sapiom.search.scrape`, `ctx.sapiom.browserAutomation`, and
`ctx.sapiom.models.run`.

## What it does

```
crawl (web.scrape) ─▶ render (browser.session) ─▶ audit (models.run)
  ─▶ linkCheck (compute) ─▶ report ─▶ done
crawl ───────────────────────────────────────────▶ rejected, when `siteUrl`
  isn't a usable URL
```

1. **crawl** — reads the homepage's markdown and links
   (`ctx.sapiom.search.scrape`), picks a bounded set of internal pages
   (prioritizing anything that looks like a Terms or Privacy link), and reads
   each page's markdown. Capped at `MAX_PAGES` (5) total.
2. **render** — opens ONE browser session
   (`ctx.sapiom.browserAutomation.withSession`) and screenshots every crawled
   page in it. A page that fails to render becomes a failed row; the rest are
   still captured.
3. **audit** — asks a model (`ctx.sapiom.models.run`) to read every crawled
   page's content in one call and flag concrete issues: placeholder text,
   thin sections, missing or duplicate titles.
4. **linkCheck** — turns the already-collected data into a link-integrity
   verdict: which pages didn't resolve, and whether Terms and Privacy are
   present and resolve.
5. **report** — terminal; compiles the screenshots, content findings, and
   link integrity into one QA report.

Input: `{ "siteUrl": "https://…" }`

- `siteUrl` — the site to crawl and QA-check. Defaults to `https://sapiom.ai`.

## Run it

- **Use this template** in the app — Sapiom builds and deploys it, and a run
  with no input QA-checks `https://sapiom.ai`.
- **Locally:** `run_local` traces the flow for free (every capability is
  stubbed).
