# Personalized Media at Scale

One personalized image or short clip per row of a table — stored and emailed, on
a cron cadence. A marketer keeps a list of leads or customers with a line of
context each; this turns every row into its own asset and mails it out.

## What it does

```
fetch ──▶ renderImages ─────────────────────▶ deliver  (terminal)
(database)  (contentGeneration.images)          (email)
      └──▶ renderClip  ⇄  collectClip ────────▶ deliver
           (contentGeneration.video)  (drain)
```

1. **fetch** — reads up to `limit` recipient rows from a Postgres table
   (`ctx.sapiom.database`), creating and seeding the table on first run so the
   template works out of the box. `dryRun` stops here and returns the rows plus
   the prompt each would get — nothing generated, nothing sent.
2. **renderImages** (image medium) — fans out one personalized image per row
   (`ctx.sapiom.contentGeneration.images`), all at once, each persisted with a
   durable `fileId`.
3. **renderClip ⇄ collectClip** (video medium) — one row at a time: launches an
   async text-to-video job (`ctx.sapiom.contentGeneration.video.launch`) and
   pauses on it; the FAL webhook resumes `collectClip`, which records the clip
   and loops back for the next row or advances once every row is done.
4. **deliver** — emails each recipient (`ctx.sapiom.email`) a link to their own
   asset, degrading per-recipient so one bad address doesn't sink the batch.

The per-row prompt is built deterministically from that row's `context`, so no
LLM is in the loop — this template generates media, not copy.

Input (everything is optional; it runs on seeded demo rows as-is):
`{ "medium": "image", "limit": 3, "style": "warm, editorial", "schedule": "0 9 * * *" }`.

- `medium` — `image` (default, sync, cheaper) or `video` (async, one row at a
  time, pricier).
- `limit` — rows per run (default 3, max 25). Keep it small for video.
- `dbHandle` — point it at your own table (columns `name`, `email`, `context`).
- `dryRun: true` — read the rows and prompts without generating or emailing.

> On a live run it emails each row's address. Use `dryRun` or a test table
> first.

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
   stubbed; pass `dryRun: true` to skip generation + delivery, free) →
   `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real, billed batch — images or clips generated and
   emailed).

4. To run it on a cadence, attach the `schedule` as a cron trigger on the
   deployed agent.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.

Run `npm run typecheck` to confirm it compiles.
