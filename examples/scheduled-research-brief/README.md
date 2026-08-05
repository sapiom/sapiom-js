# Scheduled Research Brief

Research a topic and email a short, sourced brief — on a cron cadence. The
scheduled, LLM-curated, delivered sibling of
[`web-research-digest`](../web-research-digest).

## What it does

```
search  ──▶  scrape  ──▶  curate  ──▶  deliver  (terminal)
(web.search)  (web.scrape)  (models.run)  (email)
```

1. **search** — takes a `topic`, calls `ctx.sapiom.search.webSearch` for
   candidate results.
2. **scrape** — reads the top candidates for full article text
   (`ctx.sapiom.search.scrape`), degrading per-item on failure. Bodies are
   truncated and stay bounded — they never enter shared state.
3. **curate** — hands the ranked, scraped sources to an LLM
   (`ctx.sapiom.models.run` — the live x402-served model) to synthesize a short
   sourced brief. This is the step `web-research-digest` deliberately omits (it
   formats in-process, no LLM).
4. **deliver** — emails the brief to the recipient. A `dryRun` guard computes the
   brief but skips the real send; so does a run with no recipient set. The recipient is
   runtime, never persisted.

Input: `{ "topic": "AI agent reliability incidents", "schedule": "0 8 * * *", "deliverTo": "you@example.com" }`.

- `topic` and `schedule` are the two knobs — what to research, and how often.
- `deliverTo` sets the recipient; omit it and the brief is returned in the run's
  output instead of emailed.
- `dryRun: true` returns the brief as a preview without emailing anyone.

### `web-research-digest` vs. this

Fork [`web-research-digest`](../web-research-digest) for a **one-shot** digest
that formats in-process — no LLM, no delivery. Fork **this** for a **standing**
brief: LLM-curated, emailed, on a cron cadence.

## Run it with your coding agent + Sapiom Project MCP

1. Add Project MCP to Claude Code or Codex:

   ```bash
   claude mcp add sapiom-project -- npx -y @sapiom/mcp
   codex mcp add sapiom-project -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call its metered capability.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` (capabilities
   stubbed; pass `dryRun: true` to skip delivery, free) → `sapiom_dev_agents_link`
   → `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run` (a real, billed
   search + scrape + LLM curation, and a delivered brief).

4. To run it on a cadence, attach the `schedule` as a cron trigger on the
   deployed agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
