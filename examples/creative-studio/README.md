# Creative Studio

Film one scene as a short multi-shot video with the same character in every
shot. A model plans the shots, one image of the character becomes the reference
for every keyframe, a vision check catches keyframes that drift, and every shot
renders at the same time with its spoken line as native audio.

This is a fork of `scene-to-video`. That template holds a look across shots
with a written style bible alone, and its character drifts: in a 3-shot
lighthouse run the keeper's hat changed from a flat cap to a sou'wester to none.
Here every keyframe is an edit of the same character image.

## What it does

```
coordinator:  plan ─▶ plate ─▶ shots ─▶ gather ⇄ gather ─▶ stitch ─▶ finalize
per-shot:     plan ─▶ keyframe ⇄ check ─▶ animate ─▶ clip
```

| Step       | Capability                                | What it does                                                                                                     |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `plan`     | `llm.run`                                 | Character description, style bible, and exactly `numShots` shots (edit instruction, motion prompt, line, 4–15s). |
| `plate`    | `images.create` (`nano-banana-pro`)       | The character alone, full body, plain background, at the requested aspect ratio.                                 |
| `shots`    | `agents.launch`                           | One child run of this agent per shot, all at once.                                                               |
| `gather`   | pause on `agents.result`                  | Collects each child in order. A child that finished early has its result parked, so the pause resumes at once.   |
| `keyframe` | `images.create` (`flux-pro-kontext-edit`) | Edits the plate into the shot.                                                                                   |
| `check`    | `llm.run` (vision)                        | Scores the keyframe against the plate. Redoes a failing keyframe once, then accepts it with a warning.           |
| `animate`  | `video.launch` (`seedance-i2v`)           | Animates the keyframe for the planned duration; native audio only when the shot has a line.                      |
| `clip`     | `fileStorage`                             | Keeps the clip in file storage and returns it.                                                                   |
| `stitch`   | `video.create` (`merge-videos`)           | Joins the clips in order. One shot skips the merge.                                                              |
| `finalize` |                                           | Returns the result below.                                                                                        |

Output:

```json
{
  "downloadUrl": "https://file-storage.services.sapiom.ai/public/…",
  "videoFileId": "…",
  "plateFileId": "…",
  "plateUrl": "…",
  "character": "…",
  "bible": "…",
  "shots": [
    {
      "edit_instruction": "…",
      "motion_prompt": "…",
      "line": "…",
      "duration": 7,
      "result": {
        "clipFileId": "…",
        "keyframeFileId": "…",
        "keyframeAttempts": 1,
        "check": { "same_person": true, "score": 9 },
        "checks": [],
        "costUsd": 1.9,
        "warnings": []
      }
    }
  ],
  "warnings": [],
  "costUsd": 7.1,
  "wallClockSeconds": 540
}
```

## Input

| Field         | Default | Notes                                                                             |
| ------------- | ------- | --------------------------------------------------------------------------------- |
| `scene`       | sample  | The scene to film. Quote any dialogue; quoted lines are spoken verbatim.          |
| `numShots`    | 4       | 1–6. A run with no `scene` always films one 5-second silent shot.                 |
| `aspectRatio` | `16:9`  | `16:9`, `9:16` or `1:1`. The plate is rendered at this ratio; every shot follows. |
| `model`       |         | Image-to-video override. Defaults to `seedance-i2v`.                              |
| `dryRun`      |         | Return the plan only, with each shot's final clip prompt. Generates nothing.      |
| `shot`        |         | Internal: set by the coordinator on each per-shot run. Leave it empty.            |

## Prompt rules

The planning prompt carries the motion-prompt rules from Polsia's content-gen
video prompt:

- The subject and its visible action come first, with concrete verbs.
- Action scales with duration: one beat up to 6s, at most two up to 9s, at most three beyond.
- Exactly one camera instruction, as its own sentence.
- A spoken line fits its clip at 2–2.5 words per second. A longer line is kept and flagged in `warnings`.

The line is appended to the motion prompt in code, quoted, so the model cannot
paraphrase it.

## Parallel shots

`seedance-i2v` takes 3–9 minutes per clip. Rendered one after another, as
`scene-to-video` does, 4 shots would take up to about 36 minutes.

Each shot therefore renders as its own run. The alternative, launching every
video job from one step and pausing on them in turn, loses clips: the engine
drops an image or video completion webhook unless the run is paused on that
exact job when it fires. A child agent's result is instead parked until the
parent pauses on it, in either order. See `AGENTS.md` for the detail.

## Measured on prod

Runs in a personal prod org, 2026-09-27. Cost is the sum of the per-call quotes.

| Input                                   | Runs | Wall clock     | Cost          |
| --------------------------------------- | ---- | -------------- | ------------- |
| 4 shots, 2 spoken lines, ~27s of video  | 4    | 6m00s – 11m40s | $6.39 – $7.41 |
| 3 shots, same scene as `scene-to-video` | 4    | 5m10s – 7m25s  | $4.62 – $5.35 |
| `{}` (one 5s silent shot)               | 6    | 4m04s – 8m59s  | $1.40 – $1.44 |
| `{ "aspectRatio": "9:16" }`             | 1    | 4m19s          | $1.40         |

Wall clock is set by the slowest `seedance-i2v` clip, which took 3.5 to 10.5
minutes in these runs. The same 3-shot scene through `scene-to-video`, which
renders clips one after another, took 13m43s.

`costUsd` sums the per-call quotes for the plate, keyframes, clips and merge.
The two model calls per shot (plan, check) are not included: agent `llm.run`
calls are not metered per run yet (SAP-3613).

## Known limits

- **One recurring character.** The plate is one person. In a scene with two speaking characters, the planner describes both in `character`, and only one can be drawn on the plate; the second is not held consistent.
- **The plate call is synchronous.** `nano-banana-pro` usually takes 16–20s, but one prod call hit the 30s router cap (504). The step retries, and its idempotency key means a completed render is not billed twice.
- **No narration track.** Speech (`speech.textToSpeech`) returned 502 on every call during development, so lines are spoken in-shot by `seedance-i2v` rather than as a voice-over.
- **No last-frame chaining.** `extract-frame` is not reachable through the public API, so each shot starts from its own keyframe.
- **Merge is a raw provider id** (`fal-ai/ffmpeg-api/merge-videos`); the catalog has no merge alias.

## Run it with Claude + the Sapiom MCP

1. Add the MCP: `claude mcp add sapiom -- npx -y @sapiom/mcp`.
2. Authenticate with `sapiom_authenticate`, then confirm with `sapiom_status`.
3. From this directory: `npm install`, then `sapiom_dev_agents_check` →
   `sapiom_dev_agents_run_local` with `{ "dryRun": true }` → `sapiom_dev_agents_link` →
   `sapiom_dev_agents_deploy` → `sapiom_dev_agents_run`.

`run_local` cannot exercise the pauses. Test the full graph in the cloud:
`{ "dryRun": true }` for the plan, `{}` for one cheap real shot, then a
multi-shot scene with dialogue.

## Files

- `index.ts` — the agent (edit this).
- `index.test.mjs` — unit tests for the plan reader, prompt builders and step branching (`npm test`).
- `package.json` / `tsconfig.json` — pinned SDK deps and typecheck config.
- `AGENTS.md` — the graph, why shots are child runs, and the authoring loop.
