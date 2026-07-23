# news-roundup

A Sapiom agent, authored as code against [`@sapiom/agent`](https://www.npmjs.com/package/@sapiom/agent), that builds a small news-roundup website for a company. Given a company name, it searches the web for recent news, asks a model to pick the 3–5 most relevant articles and write a plain-language summary and an illustration prompt for each, generates one image per article, and publishes a dated roundup page to a per-company site. Each run adds a new dated page to that company's site without touching prior runs.

## Steps

`search` → `select` → `illustrate` → `publish` (defined in `index.ts`, backed by `lib/`):

1. **search** — `ctx.sapiom.search.webSearch` for `"<companyName>" company news from the last 7 days`. If nothing comes back, the agent terminates gracefully (see "No news" below) instead of failing.
2. **select** — `ctx.sapiom.models.run` picks 3–5 articles from the search results and returns, per article, a title/url/summary/imagePrompt.
3. **illustrate** — `ctx.sapiom.contentGeneration.images.create` generates one image per selected article; each image is uploaded public to Sapiom file storage. A failed generation degrades that article to a text-only card (two attempts, then move on) rather than failing the run.
4. **publish** — renders the dated HTML page, uploads it to file storage, then rebuilds the company's sandbox site entirely from what's in storage (see "Storage" and "Serving" below) and returns the live URLs.

## Entry input

```json
{ "companyName": "Polsia" }
```

`companyName` is the only input; it's slugified (e.g. `Polsia` → `polsia`) to key storage paths and the sandbox name.

## Output

On success (`publish` terminates with):

```json
{
  "status": "published",
  "siteUrl": "https://news-roundup-polsia-<id>.sandbox.sapiom.ai",
  "pageUrl": "https://news-roundup-polsia-<id>.sandbox.sapiom.ai/pages/2026-07-22.html",
  "articles": [
    { "title": "...", "sourceUrl": "...", "summary": "...", "imageUrl": "https://.../images/2026-07-22-1.png" }
  ]
}
```

`imageUrl` is `null` for an article whose illustration generation failed — the site still renders it as a text-only card.

### No news

If `search` finds zero results for the company, the agent terminates early with:

```json
{ "status": "no-news", "companyName": "Polsia" }
```

No page is published and the sandbox is left untouched for that run.

## Storage layout

Everything durable lives in Sapiom file storage under a per-company prefix, uploaded with `visibility: "public"`:

```
news-roundup/<companySlug>/
  pages/<runDate>.html        # one dated roundup page per run
  images/<runDate>-<n>.png    # one image per illustrated article that run
```

This is the source of truth. The sandbox (below) is a disposable, rebuildable view over it — losing the sandbox loses nothing; the next run (or a manual `deployPreview`) reconstructs the whole site from these files.

## Sandbox naming & serving

- Sandbox name: `news-roundup-<companySlug>` (find-or-create — reused across runs for the same company).
- `ttl: "24h"`, `tier: "xs"`.
- **Stateless**: on every `publish`, the agent lists all files under the company's storage prefix, mirrors them into the sandbox as `site/pages/...` and `site/images/...`, writes a generated `site/index.html` (links to every dated page) and `site/server.mjs` (a tiny static file server), then calls `deployPreview({ start: "node site/server.mjs", port: 3000 })`.
- Because the TTL is 24h, the sandbox — and its preview URL — disappear roughly a day after the last run and get recreated (with a **new** preview URL) on the next run. Don't hardcode or bookmark a `siteUrl`/`pageUrl` long-term; re-run or check the latest execution's output for the current one.

## Testing locally (free — no real capability calls)

```sh
npm run typecheck && npm test
```

Then validate the step graph and bundle offline:

- MCP `sapiom_dev_agents_check` — bundles `index.ts`, derives the manifest, checks the step graph. Offline, instant.

To exercise the real step code end-to-end against stubs:

1. Start the local upload sink (services the presigned-PUT calls `uploadPublicFile` makes): `node test/upload-sink.mjs`
2. In another terminal, MCP `sapiom_dev_agents_run_local` with input `{"companyName": "Polsia"}`. It reads the committed `.sapiom-dev/stubs.json` (stubbed search results, model selection output, image generation, and file-storage/sandbox responses for a `polsia` run) and runs every step's real code against those stubs — zero spend, no live Sapiom calls.

## Running for real

MCP `sapiom_dev_agents_run` with input `{ "companyName": "Polsia" }` runs the deployed agent (slug `news-roundup`) live: real web search, real model call, real image generation, and a real sandbox rebuild/deploy. Inspect the execution's output for the current `siteUrl`/`pageUrl`.

## Schedule

A weekly cron schedule is active for this agent: **every Monday at 08:00 UTC**, input `{ "companyName": "Polsia" }` (schedule id `78`, `definition` slug `news-roundup`). Inspect or manage it with `sapiom_dev_agents_schedule_inspect` / `sapiom_dev_agents_schedule_cancel`.

## Authoring

The orchestration is defined with `defineAgent({ steps })`; each step is a `defineStep({ name, next, run })`. The `run` body is ordinary code — inside it, the full Sapiom tool catalog is available, pre-auth'd and tenant-scoped, on `ctx.sapiom`. No credentials to wire — a per-execution tenant credential is injected when the orchestration runs.

See `AGENTS.md` for the full authoring loop (`check` → `run_local` → `deploy`).
