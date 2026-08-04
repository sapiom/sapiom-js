# Content Pack

Turn one blog post or transcript into a whole content pack: a tweet thread, a
LinkedIn post, a newsletter, quote graphics, and a short teaser clip — packaged
and fanned out by email to every recipient you name. Built for marketers and
creators who write once and want to publish everywhere.

## What it does

```
repurpose ──▶ graphics ⇄ collectGraphic ──▶ clip ⇄ collectClip ──▶ package ──▶ deliver
(models.run)  (images.launch)  (drain)      (video.launch) (drain) (fileStorage) (email.send × N)
```

1. **repurpose** — an LLM (`ctx.sapiom.models.run`) rewrites the source into every
   channel at once: the tweet thread, the LinkedIn post, the newsletter, the
   pull-quotes to render, and a short video script. `dryRun` stops here with the
   copy only (no paid media).
2. **graphics ⇄ collectGraphic** — one quote-graphic image at a time
   (`images.launch`, async): launch the job, pause until the webhook resumes
   `collectGraphic`, record it, then loop back for the next quote or advance.
3. **clip ⇄ collectClip** — animates the first quote graphic into a short
   teaser: launches an async image-to-video job (`video.launch`) and pauses on
   it; the video-generation webhook resumes `collectClip` when the clip is ready.
4. **package** — assembles the whole pack as one markdown document and uploads it
   to file storage (`fileStorage.upload`) for a durable `fileId` + download URL.
5. **deliver** — fans the pack out to every `deliverTo` recipient
   (`email.messages.send`), one message each, and returns a summary of
   everything produced plus how many recipients it delivered to.

Input: `{ "source": "<your blog post or transcript>", "title": "..." }`. With no
`source` at all, the run repurposes a built-in sample post and says so in its output.
Optional: `audience`, `numQuotes` (default 2, max 4), `deliverTo` (one or more
recipient emails), `schedule` (a cron string), `model` (an advanced image-to-video
model id), and `dryRun` (copy only).

## Delivery: fan-out per recipient

`deliverTo` takes a list. `deliver` maps over it — one `email.messages.send` per
recipient — then reduces the results into one `delivered` count: a bad or
placeholder address degrades that one recipient rather than sinking the whole
run. Leave `deliverTo` empty and the run returns the pack inline and says
nothing was sent.

## Cost

A full run bills an LLM call, one **image** per quote, one image-to-**video** clip,
and one email per recipient — so the estimated per-run cost card (derived from
`capabilities`) is higher than the text-only templates. Use `dryRun` while
iterating on the copy, and keep `numQuotes` small for real runs.

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

`clip` defaults to a high-quality image-to-video model. Pass a cheaper model via
the `model` input to trade quality for cost. Model ids are an advanced, evolving
surface and are passed through verbatim; most callers omit `model` and take the
default.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `AGENTS.md` — the authoring loop and why the async steps pause.

Run `npm run typecheck` to confirm it compiles.
