# Newsletter Autopilot

Research a niche, write the issue, illustrate it, and email it to your
subscribers — on a weekly cadence. The published-newsletter sibling of
[`scheduled-research-brief`](../scheduled-research-brief).

## What it does

```
search  ──▶  scrape  ──▶  write  ──▶  header  ──▶  deliver  (terminal)
(web.search)  (web.scrape)  (models.run)  (images)   (email)
```

1. **search** — takes a `niche`, calls `ctx.sapiom.search.webSearch` for
   candidate results.
2. **scrape** — reads the top candidates for full article text
   (`ctx.sapiom.search.scrape`), degrading per-item on failure. Bodies are
   truncated and stay bounded — they never enter shared state.
3. **write** — hands the ranked, scraped sources to an LLM
   (`ctx.sapiom.models.run` — the live x402-served model) to curate and write
   this week's issue: a subject, a markdown body, and a header-image prompt.
4. **header** — generates a header image for the issue
   (`ctx.sapiom.contentGeneration.images.create`). Best-effort: if nothing comes
   back, the issue still goes out without it.
5. **deliver** — emails each subscriber their own copy. A `dryRun` guard writes
   and renders the full issue but skips the real send; the subscriber list is
   read from the Sapiom vault at runtime, never persisted.

Input: `{ "niche": "indie game development", "newsletterName": "Pixel Weekly", "schedule": "0 8 * * 1", "subscribers": ["you@example.com"] }`.

- `niche` and `newsletterName` set what it writes about and the masthead.
- `schedule` is the cron cadence — it defaults to Mondays at 08:00.
- `subscribers` is the recipient list; omit it to use the vault-configured list.
- `dryRun: true` returns the finished issue as a preview without emailing anyone.

### `scheduled-research-brief` vs. this

Fork [`scheduled-research-brief`](../scheduled-research-brief) for a **private,
one-recipient brief** — search → scrape → curate → email, no image. Fork **this**
when the deliverable is a **published-feeling newsletter**: an LLM writes the
issue with a subject and a header image, and it goes out to a whole list.

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
   stubbed; pass `dryRun: true` to skip delivery, free) → `sapiom_dev_agents_link`
   → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real, billed
   search + scrape + LLM write + header image, and a delivered issue).

4. To run it weekly, attach the `schedule` as a cron trigger on the deployed
   agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
