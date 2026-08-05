# Scene → Images → Video

Turn a single scene description into a stitched short video. The richest
onboarding template: a real multi-step generative pipeline that exercises three
metered capabilities together — LLM planning, image generation, and async video —
and shows off the async pause/resume + per-shot fan-out that separates a Sapiom
agent from a plain script.

## What it does

```
decompose ──▶ keyframe ⇄ collectKeyframe ──▶ animate ⇄ collect ──▶ stitch ──▶ finalize
(models.run)  (images.launch)  (drain)      (video.launch) (drain) (video.create) (terminal)
```

1. **decompose** — an LLM (`ctx.sapiom.models.run`) turns the scene into a global
   style/identity **bible** plus an ordered shot list (each shot: `image_prompt`,
   `motion_prompt`, `duration`, `transition`). Run it with no `scene` and it plans
   (and later shoots) the built-in sample scene as a single shot.
2. **keyframe** — launches an async keyframe-image job for one shot
   (`images.launch`) and pauses on it; the webhook resumes `collectKeyframe`
   when the image is ready.
3. **collectKeyframe** — records the finished keyframe, then loops back to
   `keyframe` for the next shot, or advances to `animate` once every keyframe
   is in.
4. **animate** — launches an async image-to-video job per shot (`video.launch`)
   and pauses on it; the completion webhook resumes `collect` when the clip is
   ready.
5. **collect** — records the clip, then loops back to `animate` for the next shot,
   or advances to `stitch` once every clip is in.
6. **stitch** — concats every clip through the synchronous video merge capability
   (a single-clip scene bypasses the merge). The SDK has a bounded polling
   fallback if the operation is unexpectedly queued.
7. **finalize** — terminal; returns `{ videoFileId, downloadUrl, shots }`.
   `videoFileId` is `null` when persistence did not produce a durable file.

Input: `{ "scene": "a paper boat drifting down a rain-soaked city gutter at night", "numShots": 3 }`.
Optional: `aspectRatio` (default `"16:9"`), `model` (image-to-video model id), and
`dryRun: true` (plan only — skip all image/video generation). Omit everything
and it shoots the built-in sample scene as a single real, cheap shot.

## Cost

⚠️ **This is the priciest template in the gallery once you go past one shot.**
A real multi-shot run bills an LLM call, N keyframe **images**, N image-to-
**video** clips, and a merge job — so the gallery's estimated per-run cost card
(derived from `capabilities`) is visibly higher than the other templates. A
zero-input run clamps to a single shot and skips the merge, so it stays cheap.
Use `dryRun` while iterating, and keep `numShots` small for a real multi-shot run.

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
   `{ "scene": "...", "dryRun": true }` (capabilities stubbed, free — traces the
   full graph offline) → `sapiom_dev_agents_link` → `sapiom_dev_agents_deploy` →
   `sapiom_dev_agents_run` (a real, billed image + video + stitch run).

## Model choice

`animate` defaults to Kling 2.1 Pro image-to-video (`fal-ai/kling-video/v2.1/pro/image-to-video`)
for quality. Pass a cheaper model via the `model` input (e.g. a Wan or Seedance
i2v id) to trade quality for cost. Model ids are passed through verbatim.

## Files

- `index.ts` — the agent (edit this).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `AGENTS.md` — the authoring loop and why `animate` runs sequentially.

Run `npm run typecheck` to confirm it compiles.
