# Research → Micro-Site Publisher

Research a topic across the web, synthesize a cited report, then build and deploy
a shareable **live site** for it — not just a document.

## What it does

```
search  ─▶  scrape  ─▶  synthesize  ─▶  build  ─▶  publish  ─▶  mapDomain  ─▶  live
(web.search) (web.scrape) (models.run) (models.coding) (deployPreview) (domains.dns)  (terminal)
```

1. **search** — takes a `topic`, calls `ctx.sapiom.search.webSearch` for candidate
   sources.
2. **scrape** — reads the top candidates for full article text
   (`ctx.sapiom.search.scrape`), degrading per-item on failure. Bodies are
   truncated and stay bounded — they never enter shared state.
3. **synthesize** — hands the sources to an LLM (`ctx.sapiom.models.run`, the live
   x402-served model) to write a structured, cited report (title, tagline,
   summary, sections). `dryRun` stops here and returns the report via `drafted`.
4. **build** — launches a coding agent (`ctx.sapiom.models.coding`) that turns the
   report into a self-contained static site (`index.html` + a zero-dependency
   `server.js`), then pauses until it finishes — costing nothing while it works.
5. **publish** — re-attaches the coding agent's sandbox and deploys the site
   (`box.deployPreview`), exposing it at a stable public URL. `deployPreview` only
   serves from a Blaxel cloud sandbox, so this needs the coding run to have landed
   in one — which it does on the deployed Sapiom stack. On the **local** stack the
   coding run executes in host mode, whose files aren't in a deployable sandbox, so
   `publish` degrades honestly to the `builtNotPublished` terminal (the site is
   built, it just can't be served locally) instead of failing on a
   `404 Sandbox not found`. Run it deployed to get a live URL.
6. **mapDomain** — if you set a `customDomain` you own in Sapiom, points
   `<subdomain>.<domain>` at the preview host with a free CNAME
   (`ctx.sapiom.domains.dns`). Skipped when no domain is set.
7. **live** — terminal; returns the live URL, the custom URL (if mapped), the
   report title, and the sources.

Input:
`{ "topic": "the state of on-device AI", "audience": "developers", "customDomain": "your-domain.dev", "subdomain": "report" }`.

- `topic` and `audience` are the two content knobs — what to research, and who
  it's for.
- `customDomain` (optional) maps the site onto a domain you already own; omit it
  to publish at the preview URL only. `subdomain` defaults to `www`.
- `dryRun: true` returns the report as a preview without building or deploying.

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
   search → scrape → synthesize and get the report back, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`
   (a real research → build → deploy that returns a live URL).

4. To map a custom domain, first register/own it in Sapiom
   (`ctx.sapiom.domains`), then pass `customDomain` (and optionally `subdomain`)
   on the run.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `template.json` — gallery detail (manifest v1).
- `AGENTS.md` — the authoring loop.

Run `npm run typecheck` to confirm it compiles.
