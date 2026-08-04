# Research → Micro-Site Publisher

Research a topic across the web, self-critique and revise the write-up
against an editorial rubric, illustrate it, then have a coding agent build
and deploy it as a **live site** — not just a document. (The deployed
preview is currently short-lived; a durable public URL is tracked in
SAP-2211 — see **publish** below.)

This template absorbs and replaces `web-research-digest`: a plain search →
cited digest is a strict subset of what `gather` → `synthesize` does here
(multiple queries, deduped, full-text scraped).

## What it does

```
plan  ─▶  gather  ─▶  synthesize  ⇄  critique  ─▶  illustrate  ⇄  collectIllustration  ─▶  build  ─▶  publish  ─▶  mapDomain  ─▶  live
(compute) (web.search × N, web.scrape) (models.run) (models.run, bounded revise loop) (contentGeneration.images, bounded fan-out) (models.coding) (deployPreview) (domains.dns)  (terminal)
```

1. **plan** — takes a `topic`, plans a couple of complementary search queries
   (deterministic, no model call).
2. **gather** — runs each query (`ctx.sapiom.search.webSearch`), dedupes the
   combined hits by normalized URL, then reads the survivors for full article
   text (`ctx.sapiom.search.scrape`), degrading per-item on failure. Bodies
   are truncated and stay bounded.
3. **synthesize** — hands the sources to an LLM (`ctx.sapiom.models.run`) to
   write a structured, cited report (title, tagline, summary, sections).
   Nothing gathered → stops here via `drafted`.
4. **critique** — a second, independent model call (chained judgment) grades
   the report against a fixed editorial rubric (citation coverage, no
   redundant sections, tone fits the audience) — folded in from the
   eval-gate idiom (`examples/eval-gate`). Below the bar, with attempts
   remaining, it hands the rejected report and the critique back to
   `synthesize` for a revision, bounded by `maxDraftAttempts`. `dryRun`
   stops here and returns the report via `drafted` either way.
5. **illustrate** ⇄ **collectIllustration** — generates up to
   `illustrationCount` section illustrations
   (`ctx.sapiom.contentGeneration.images.launch`), one at a time, pausing on
   each job's result signal — the same fan-out shape `scene-to-video` uses
   for its keyframes. Best-effort: `illustrationCount: 0`, a failed launch,
   or a job with no usable output never fails the run — just fewer pictures.
6. **build** — launches a coding agent (`ctx.sapiom.models.coding`) that
   turns the report (and any illustrations, with freshly re-minted download
   URLs) into a self-contained static site (`index.html` + a
   zero-dependency `server.js`), then pauses until it finishes — costing
   nothing while it works.
7. **publish** — re-attaches the coding agent's sandbox and deploys the site
   (`box.deployPreview`), exposing it at a live **preview** URL. `deployPreview` only
   serves from a Blaxel cloud sandbox, so this needs the coding run to have landed
   in one — which it does on the deployed Sapiom stack. On the **local** stack the
   coding run executes in host mode, whose files aren't in a deployable sandbox, so
   `publish` degrades honestly to the `builtNotPublished` terminal (the site is
   built, it just can't be served locally) instead of failing on a
   `404 Sandbox not found`. Run it deployed to get a live preview URL.
   > **Heads-up — the preview is currently short-lived.** `deployPreview` starts the
   > site's process once with no supervisor, and the platform recycles it, so the URL
   > returns 502 shortly after (measured: ~2 min). Open it promptly. A durable,
   > non-expiring public URL for the built page is tracked in **SAP-2211**; until it
   > lands this template publishes a live _preview_, not a durable shareable site.
8. **mapDomain** — if you set a `customDomain` you own in Sapiom, points
   `<subdomain>.<domain>` at the preview host with a free CNAME
   (`ctx.sapiom.domains.dns`). Skipped when no domain is set.
9. **live** — terminal; returns the live URL, the custom URL (if mapped), the
   report title, the sources, and the self-critique score/verdict.

Input:
`{ "topic": "the state of on-device AI", "audience": "developers", "customDomain": "your-domain.dev", "subdomain": "report", "reviewThreshold": 0.7, "maxDraftAttempts": 2, "illustrationCount": 2 }`.

- `topic` and `audience` are the two content knobs — what to research, and who
  it's for.
- `reviewThreshold` (default 0.7) and `maxDraftAttempts` (default 2) control
  the self-critique loop; `illustrationCount` (default 2, max 3, 0 skips it)
  controls the illustrations.
- `customDomain` (optional) maps the site onto a domain you already own; omit it
  to publish at the preview URL only. `subdomain` defaults to `www`.
- `dryRun: true` returns the report — after self-critique — as a preview
  without illustrating, building, or deploying.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities
   stubbed; pass `{ "topic": "...", "dryRun": true }` to trace
   plan → gather → synthesize → critique and get the report back, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real research → critique → illustrate → build → deploy that returns a
   live URL).

4. To map a custom domain, first register/own it in Sapiom
   (`ctx.sapiom.domains`), then pass `customDomain` (and optionally `subdomain`)
   on the run.

## Files

- `index.ts` — the agent (edit this).
- `critique.ts` — the self-critique judge prompt + score parser (mirrors
  `eval-gate/judge.ts`).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `template.json` — gallery detail (manifest v1).
- `AGENTS.md` — the authoring loop.
- `index.test.mjs` — unit tests against individual step `run` functions.

Run `npm run typecheck` to confirm it compiles, and `npm test` to run the
unit tests.
