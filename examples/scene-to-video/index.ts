import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { VIDEO_RESULT_SIGNAL, type VideoResultPayload } from "@sapiom/tools";

/**
 * Scene → Images → Video — a real multi-step generative pipeline.
 *
 * From one scene description this exercises three metered capabilities together
 * and shows off the async pause/resume + per-shot fan-out machinery that
 * separates a Sapiom agent from a plain script:
 *
 *   decompose ─▶ keyframes ─▶ animate ⇄ collect ─▶ stitch ─▶ finalize
 *   (models.run) (images.create) (video.launch)   (drain)  (video.launch) (terminal)
 *
 *   1. decompose — an LLM (`ctx.sapiom.models.run`) turns the scene into a global
 *      style/identity "bible" plus an ordered shot list.
 *   2. keyframes — one keyframe image per shot (`images.create`), fanned out
 *      in-process, each persisted for a durable `fileId`.
 *   3. animate — one shot at a time: launch an async image-to-video job
 *      (`video.launch`) and `pauseUntilSignal` on it; the FAL webhook resumes
 *      `collect` when that clip is ready.
 *   4. collect — record the finished clip, then loop back to `animate` for the
 *      next shot, or advance to `stitch` once every clip is in.
 *   5. stitch — concat the N clips into one video (a FAL ffmpeg-merge job), again
 *      async: pause on it and resume at `finalize`.
 *   6. finalize — terminal; return the stitched video's durable `videoFileId` +
 *      `downloadUrl`.
 *
 * Why sequential animate rather than launching all clips at once: a paused step
 * waits on a single `(signal, correlationId)` pair. Launching every clip up front
 * and then draining would risk a clip finishing before we've paused on it (its
 * resume signal would have nowhere to land). Launching shot i only after shot
 * i-1 has resumed keeps a paused step always waiting before its job can complete.
 *
 * A `dryRun` guard short-circuits after `decompose` so authors can trace the
 * graph offline without incurring the (higher) image + video generation cost.
 */

/** A single planned shot, as the LLM returns it (see {@link parsePlan}). */
interface Shot {
  /** Full image prompt for the keyframe — repeats the identity bible verbatim. */
  image_prompt: string;
  /** Motion prompt for the clip: subject → action → camera → duration → lighting → style. */
  motion_prompt: string;
  /** Clip length in seconds (kept short, ≤10s). */
  duration: number;
  /** Transition into the next shot (e.g. "cut", "dissolve"). */
  transition: string;
}

/** The LLM's decomposition of the scene: a shared style bible + ordered shots. */
interface Plan {
  bible: string;
  shots: Shot[];
}

/** A generated keyframe, carried forward to `animate` as the clip's first frame. */
interface Keyframe {
  fileId?: string;
  url: string;
  downloadUrl?: string;
}

/** A finished clip, as recorded by `collect` from a resumed video job. */
interface Clip {
  fileId?: string;
  downloadUrl?: string;
}

/** Trigger input. Only `scene` is required. */
interface SceneInput {
  /** The scene / story to turn into a short video. */
  scene: string;
  /** How many shots to plan (default 3, clamped 1–6). */
  numShots?: number;
  /** Aspect ratio passed to image + video generation (default "16:9"). */
  aspectRatio?: string;
  /** Optional video model id, passed through verbatim to `video.launch`. */
  model?: string;
  /** When true, plan only — skip all image/video generation and return the plan. */
  dryRun?: boolean;
}

interface Shared extends Record<string, unknown> {
  scene: string;
  aspectRatio: string;
  model?: string;
  bible: string;
  shots: Shot[];
  keyframes: Keyframe[];
  clips: Clip[];
  /** Index of the next shot to animate; advanced by `collect`. */
  animateIndex: number;
}

/**
 * Default FAL image-to-video model. Kling 2.1 Pro is chosen for quality (the v1
 * default); swap for a budget model (Wan i2v, Seedance i2v) via the `model` input.
 */
const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v2.1/pro/image-to-video";
/** FAL ffmpeg merge endpoint used by `stitch` — concats the clips into one video. */
const MERGE_MODEL = "fal-ai/ffmpeg-api/merge-videos";
/** Fan-out bounds on the planned shot list. */
const DEFAULT_NUM_SHOTS = 3;
const MAX_SHOTS = 6;
/** Per-clip cap (seconds) — image-to-video models animate short clips best. */
const MAX_CLIP_SECONDS = 10;

function clampShots(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_NUM_SHOTS;
  return Math.max(1, Math.min(MAX_SHOTS, Math.floor(n)));
}

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

/**
 * Parse the LLM's minified-JSON decomposition defensively. A model may wrap the
 * JSON in prose or fences, so we slice to the outermost object before parsing and
 * fall back to a single generic shot when anything is off — the pipeline still
 * runs end to end rather than failing on a malformed plan. Mirrors `create-listing`'s
 * `parseDraft`.
 */
function parsePlan(
  output: string | null,
  scene: string,
  numShots: number,
): Plan {
  const fallbackBible =
    `Consistent cinematic style. Subject and setting from: "${scene}". ` +
    `Cohesive color grade, lighting, and lens across every shot.`;
  const fallback: Plan = {
    bible: fallbackBible,
    shots: Array.from({ length: numShots }, (_, i) => ({
      image_prompt: `${fallbackBible} Shot ${i + 1}: ${scene}. Photographic, no text.`,
      motion_prompt: `The scene from "${scene}"; a slow push-in; ${MAX_CLIP_SECONDS}s; natural light; cinematic.`,
      duration: MAX_CLIP_SECONDS,
      transition: "cut",
    })),
  };
  if (!output) return fallback;
  try {
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    const raw = JSON.parse(json) as Partial<Plan>;
    const bible =
      typeof raw.bible === "string" && raw.bible.trim()
        ? raw.bible
        : fallback.bible;
    const rawShots = Array.isArray(raw.shots) ? raw.shots : [];
    const shots: Shot[] = rawShots.slice(0, MAX_SHOTS).map((s, i): Shot => {
      const shot = (s ?? {}) as Partial<Shot>;
      const dflt = fallback.shots[Math.min(i, fallback.shots.length - 1)];
      const duration =
        typeof shot.duration === "number" && Number.isFinite(shot.duration)
          ? Math.max(1, Math.min(MAX_CLIP_SECONDS, shot.duration))
          : dflt.duration;
      return {
        image_prompt:
          typeof shot.image_prompt === "string" && shot.image_prompt.trim()
            ? shot.image_prompt
            : dflt.image_prompt,
        motion_prompt:
          typeof shot.motion_prompt === "string" && shot.motion_prompt.trim()
            ? shot.motion_prompt
            : dflt.motion_prompt,
        duration,
        transition:
          typeof shot.transition === "string" ? shot.transition : "cut",
      };
    });
    return shots.length > 0 ? { bible, shots } : fallback;
  } catch {
    return fallback;
  }
}

const decompose = defineStep({
  name: "decompose",
  next: ["keyframes"],
  terminal: true,
  async run(input: SceneInput, ctx: AgentExecutionContext<Shared>) {
    const scene = input.scene?.trim();
    if (!scene) throw new Error("`scene` is required");
    const numShots = clampShots(input.numShots);
    const aspectRatio = input.aspectRatio ?? "16:9";

    const system =
      "You are a cinematographer decomposing a scene into a shot list for a short video. " +
      "Write a global style/identity BIBLE (one paragraph fixing the look, subject identity, " +
      "color, lighting, and lens) and an ordered list of shots. Repeat the bible VERBATIM at " +
      "the start of every shot's image_prompt so keyframes stay consistent. Order each " +
      "motion_prompt as subject -> action -> camera -> duration -> lighting -> style. " +
      `Return between 1 and ${numShots} shots, each clip <= ${MAX_CLIP_SECONDS}s. ` +
      "Reply with ONLY minified JSON: " +
      '{"bible":string,"shots":[{"image_prompt":string,"motion_prompt":string,"duration":number,"transition":string}]}.';
    const prompt = `Scene: ${scene}\nNumber of shots: ${numShots}\nAspect ratio: ${aspectRatio}`;

    ctx.logger.info("decomposing scene", { numShots, aspectRatio });
    const res = await ctx.sapiom.models.run({
      prompt,
      system,
      maxTokens: 1200,
    });
    const plan = parsePlan(res.output, scene, numShots);

    ctx.shared.set("scene", scene);
    ctx.shared.set("aspectRatio", aspectRatio);
    if (input.model) ctx.shared.set("model", input.model);
    ctx.shared.set("bible", plan.bible);
    ctx.shared.set("shots", plan.shots);
    ctx.shared.set("clips", []);
    ctx.shared.set("animateIndex", 0);
    ctx.logger.info("planned shots", { shots: plan.shots.length });

    // dryRun: trace the graph without incurring image/video generation cost.
    if (input.dryRun) {
      ctx.logger.info("dryRun — returning plan only");
      return terminate({ dryRun: true, bible: plan.bible, shots: plan.shots });
    }
    return goto("keyframes", {});
  },
});

const keyframes = defineStep({
  name: "keyframes",
  next: ["animate"],
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    ctx.logger.info("generating keyframes", { shots: shots.length });

    // Fan-out: one keyframe image per shot, generated concurrently. `storage`
    // persists each output so we get a durable `fileId` + a ready-to-use URL to
    // hand the animation step as its first frame.
    const generated = await Promise.all(
      shots.map((shot) =>
        ctx.sapiom.contentGeneration.images.create({
          prompt: shot.image_prompt,
          numImages: 1,
          storage: { visibility: "private" },
        }),
      ),
    );
    const frames: Keyframe[] = generated.map((result, i) => {
      const img = result.images?.[0];
      if (!img) throw new Error(`no keyframe image returned for shot ${i + 1}`);
      return {
        ...(img.fileId !== undefined && { fileId: img.fileId }),
        url: img.url,
        ...(img.downloadUrl !== undefined && { downloadUrl: img.downloadUrl }),
      };
    });
    ctx.shared.set("keyframes", frames);
    ctx.logger.info("keyframes ready", { count: frames.length });
    return goto("animate", {});
  },
});

const animate = defineStep({
  name: "animate",
  next: [],
  // Async pause/resume: the launched video job fires VIDEO_RESULT_SIGNAL on
  // completion (the FAL webhook), resuming `collect` with the clip's result.
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "collect" },
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    const frames = must(ctx.shared.get("keyframes"), "keyframes");
    const index = must(ctx.shared.get("animateIndex"), "animateIndex");
    const shot = shots[index];
    const frame = frames[index];
    const imageUrl = frame.downloadUrl ?? frame.url;
    const model = ctx.shared.get("model") ?? DEFAULT_VIDEO_MODEL;

    ctx.logger.info("animating shot", { index: index + 1, of: shots.length });
    // Launch the image-to-video job and pause the step on its result signal. A
    // fixed seed + the shared aspect ratio keep the clips visually consistent.
    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model,
      prompt: shot.motion_prompt,
      params: {
        image_url: imageUrl,
        duration: shot.duration,
        aspect_ratio: must(ctx.shared.get("aspectRatio"), "aspectRatio"),
        seed: 42,
      },
      storage: { visibility: "private" },
    });
    return await pauseUntilSignal(handle, { resumeStep: "collect" });
  },
});

const collect = defineStep({
  name: "collect",
  next: ["animate", "stitch"],
  async run(result: VideoResultPayload, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    const clips = must(ctx.shared.get("clips"), "clips");
    const index = must(ctx.shared.get("animateIndex"), "animateIndex");

    const out = result.outputs?.[0];
    const clip: Clip = {
      ...(out?.fileId !== undefined && { fileId: out.fileId }),
      ...(out?.downloadUrl !== undefined && { downloadUrl: out.downloadUrl }),
    };
    const nextClips = [...clips, clip];
    const nextIndex = index + 1;
    ctx.shared.set("clips", nextClips);
    ctx.shared.set("animateIndex", nextIndex);
    ctx.logger.info("collected clip", {
      collected: nextClips.length,
      of: shots.length,
    });

    // More shots to animate? Loop back. Otherwise every clip is in — stitch them.
    return nextIndex < shots.length ? goto("animate", {}) : goto("stitch", {});
  },
});

const stitch = defineStep({
  name: "stitch",
  next: [],
  // Stitching is another async video job (FAL ffmpeg merge): pause on its result
  // and resume at `finalize` with the stitched video.
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "finalize" },
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const scene = must(ctx.shared.get("scene"), "scene");
    const clips = must(ctx.shared.get("clips"), "clips");
    // Ready-to-use URLs for the merge input. For a longer-lived reference re-mint
    // from each clip's `fileId` via `ctx.sapiom.fileStorage.getDownloadUrl(fileId)`.
    const videoUrls = clips
      .map((c) => c.downloadUrl)
      .filter((u): u is string => Boolean(u));
    ctx.logger.info("stitching clips", { clips: videoUrls.length });

    // `prompt` is required by the capability guard; the merge endpoint ignores it,
    // so we pass the scene for traceability. `video_urls` is the FAL merge input,
    // forwarded verbatim via `params`.
    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model: MERGE_MODEL,
      prompt: scene,
      params: { video_urls: videoUrls },
      storage: { visibility: "private" },
    });
    return await pauseUntilSignal(handle, { resumeStep: "finalize" });
  },
});

const finalize = defineStep({
  name: "finalize",
  next: [],
  terminal: true,
  async run(result: VideoResultPayload, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    const out = result.outputs?.[0];
    ctx.logger.info("pipeline complete", {
      shots: shots.length,
      hasVideo: Boolean(out?.fileId),
    });
    return terminate({
      videoFileId: out?.fileId ?? null,
      downloadUrl: out?.downloadUrl ?? null,
      shots,
    });
  },
});

export const agent = defineAgent<SceneInput, Shared>({
  name: "scene-to-video",
  entry: "decompose",
  steps: { decompose, keyframes, animate, collect, stitch, finalize },
});
