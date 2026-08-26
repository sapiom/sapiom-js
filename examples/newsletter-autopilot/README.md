# Newsletter Autopilot

Research a niche, dedupe and rank the sources, write and self-edit the issue
against a quality bar, illustrate it, and email it to your subscribers — on a
weekly cadence. This template absorbs two siblings that used to ship
separately: `news-roundup` (the dedupe/rank discipline) and
`scheduled-research-brief` (the honest zero-setup, demo-inbox delivery). Fork
this one instead of either.

## What it does

```
research  ──▶  dedupe   ──▶  write      ─▶ selfEdit ─┬─▶ illustrate ──▶ deliver  (terminal)
(web.search)  (web.scrape)  (llm.run)  (llm.run) │  (images)       (email.send)
                                 ▲______loop, bounded___┘
```

1. **research** — takes a `niche`, calls `ctx.sapiom.search.webSearch` for
   candidate results.
2. **dedupe** — reads the top candidates for full article text
   (`ctx.sapiom.search.scrape`), degrading per-item on failure, then drops
   near-duplicate stories (same URL, or titles that overlap heavily) and
   ranks the survivors, capped to the strongest few.
3. **write** — hands the deduped, ranked sources to an LLM
   (`ctx.sapiom.llm.run` — the live x402-served model) to curate and write
   this week's issue: a subject, a markdown body, and a header-image prompt.
   On a revision, it also gets its own rejected draft and the judge's
   critique.
4. **selfEdit** — grades the draft against a fixed quality bar with a second,
   chained `llm.run` call. At or above the bar, or once the attempt cap is
   hit, it moves on; otherwise it sends the draft and the critique back to
   `write` for one revision. Bounded, so the run always reaches a terminal.
5. **illustrate** — generates a header image for the issue
   (`ctx.sapiom.contentGeneration.images.create`). Best-effort: if nothing
   comes back, the issue still goes out without it.
6. **deliver** — emails each subscriber their own copy. With no `subscribers`
   set, it instead emails the issue to this agent's own Sapiom-hosted demo
   inbox, so a zero-setup run still delivers something real. A `dryRun` guard
   writes, self-edits, and renders the full issue but skips the real send
   entirely.

Input: `{ "niche": "indie game development", "newsletterName": "Pixel Weekly", "schedule": "0 8 * * 1", "subscribers": ["you@example.com"] }`.

- `niche` and `newsletterName` set what it writes about and the masthead.
- `schedule` is the cron cadence — it defaults to Mondays at 08:00.
- `subscribers` is the recipient list; omit it and the issue is emailed to
  this agent's own demo inbox instead of your list.
- `dryRun: true` returns the finished issue as a preview without emailing
  anyone at all.

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
   search + scrape + two-model write/self-edit + header image, and a
   delivered issue).

4. To run it weekly, attach the `schedule` as a cron trigger on the deployed
   agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
