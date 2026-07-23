# Content Repurposing Pipeline

Turn one blog post or transcript into a whole content pack: a tweet thread, a
LinkedIn post, a newsletter, quote graphics, and a short teaser clip — packaged
and emailed to you. Built for marketers and creators who write once and want to
publish everywhere.

## What it does

```
repurpose ──▶ graphics ──▶ clip ──▶ collectClip ──▶ package ──▶ deliver
(models.run) (images.create) (video.launch) (drain) (fileStorage) (email.send)
```

1. **repurpose** — an LLM (`ctx.sapiom.models.run`) rewrites the source into every
   channel at once: the tweet thread, the LinkedIn post, the newsletter, the
   pull-quotes to render, and a short video script. `dryRun` stops here with the
   copy only (no paid media).
2. **graphics** — one quote-graphic image per pull-quote (`images.create`),
   **fanned out** concurrently, each persisted for a durable `fileId`.
3. **clip** — animates the first quote graphic into a short teaser: launches an
   async image-to-video job (`video.launch`) and pauses on it; the FAL webhook
   resumes `collectClip` when the clip is ready.
4. **collectClip** — records the finished clip.
5. **package** — assembles the whole pack as one markdown document and uploads it
   to file storage (`fileStorage.upload`) for a durable `fileId` + download URL.
6. **deliver** — emails the pack to your recipient (`email.messages.send`), and
   returns a summary of everything produced.

Input: `{ "source": "<your blog post or transcript>", "title": "..." }`.
Optional: `audience`, `numQuotes` (default 2, max 4), `deliverTo`, `schedule`
(a cron string), `model` (a FAL image-to-video id), and `dryRun` (copy only).

## Delivery

Set `deliverTo`, or store a `RECIPIENT` key under the `content-repurposing-pipeline`
Vault ref, and the pack is emailed. With neither set, the run returns the pack
without sending. The full pack is always in the email body; the file-storage copy
is a durable convenience link.

## Cost

A full run bills an LLM call, one **image** per quote, one image-to-**video** clip,
and the email — so the estimated per-run cost card (derived from `capabilities`) is
higher than the text-only templates. Use `dryRun` while iterating on the copy, and
keep `numQuotes` small for real runs.

## Run it with Claude + the Sapiom MCP

1. Add the MCP:

   ```bash
   claude mcp add sapiom -- npx -y @sapiom/mcp
   ```

2. In your client, authenticate: run `sapiom_authenticate`, then confirm with
   `sapiom_status`. Your agent becomes an API-key principal; each step inherits
   that authority to call the metered capabilities.

3. From this directory: `npm install`, then drive the lifecycle via the MCP —
   `sapiom_dev_agents_check` → `sapiom_dev_agents_run_local` with
   `{ "source": "...", "dryRun": true }` (capabilities stubbed, free — traces the
   copy step offline) → `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real, billed copy + images + clip + email run).

## Model choice

`clip` defaults to Kling 2.1 Pro image-to-video (`fal-ai/kling-video/v2.1/pro/image-to-video`)
for quality. Pass a cheaper model via the `model` input (e.g. a Wan or Seedance
i2v id) to trade quality for cost. Model ids are passed through verbatim.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `AGENTS.md` — the authoring loop and why the clip step pauses.

Run `npm run typecheck` to confirm it compiles.
