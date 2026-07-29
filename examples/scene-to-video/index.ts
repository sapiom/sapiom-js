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
 *   (models.run) (images.create) (video.launch)   (drain)  (video.create) (terminal)
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
 *   5. stitch — concat the N clips with FAL's synchronous merge endpoint; the
 *      SDK's bounded poll fallback handles an unexpected queue.
 *   6. finalize — terminal; return the stitched video's `videoFileId` when
 *      persistence succeeded, plus the available `downloadUrl`.
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
  /** Clip length in seconds (Kling 2.1 Pro accepts only 5 or 10). */
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
export interface Clip {
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
  /** Set when the run shot the built-in sample scene rather than the caller's. */
  note?: string;
}

/**
 * The scene a zero-input run plans. Concrete enough that the shot list is a real
 * artifact — the model needs something to decompose.
 */
const SAMPLE_SCENE =
  "a paper boat drifting down a rain-soaked city gutter at night";

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
const SHORT_CLIP_SECONDS = 5;

/** Normalize an authored/model-proposed duration to the nearest Kling enum. */
export function normalizeClipDuration(duration: number | undefined): number {
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return MAX_CLIP_SECONDS;
  }
  return duration < 7.5 ? SHORT_CLIP_SECONDS : MAX_CLIP_SECONDS;
}

function clampShots(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_NUM_SHOTS;
  return Math.max(1, Math.min(MAX_SHOTS, Math.floor(n)));
}

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

/** Resolve every clip without losing the identity associated with its URL. */
export async function resolveClipInputs(
  clips: readonly Clip[],
  getDownloadUrl: (fileId: string) => Promise<{ downloadUrl: string }>,
): Promise<Array<{ clip: Clip; url: string }>> {
  if (clips.length === 0) {
    throw new Error("cannot stitch scene: no clips were collected");
  }
  return await Promise.all(
    clips.map(async (clip, index) => {
      const url = clip.downloadUrl
        ? clip.downloadUrl
        : clip.fileId
          ? (await getDownloadUrl(clip.fileId)).downloadUrl
          : "";
      if (!url) {
        throw new Error(
          `cannot stitch scene: clip ${index + 1} has no usable download URL`,
        );
      }
      return { clip, url };
    }),
  );
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
      const duration = normalizeClipDuration(shot.duration);
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
    // An omitted scene shoots the sample one, so a zero-input run really plans and
    // renders. An explicitly-empty scene is a mistake worth naming.
    if (input.scene !== undefined && input.scene.trim().length === 0) {
      return terminate({
        status: "rejected",
        reason: "`scene` was empty — describe the scene to shoot.",
      });
    }
    const usedSampleScene = input.scene === undefined;
    const scene = usedSampleScene ? SAMPLE_SCENE : input.scene.trim();
    if (usedSampleScene) {
      ctx.shared.set(
        "note",
        `Shot the built-in sample scene ("${SAMPLE_SCENE}"). Pass your own \`scene\` to shoot yours.`,
      );
    }
    const numShots = clampShots(input.numShots);
    const aspectRatio = input.aspectRatio ?? "16:9";

    const system =
      "You are a cinematographer decomposing a scene into a shot list for a short video. " +
      "Write a global style/identity BIBLE (one paragraph fixing the look, subject identity, " +
      "color, lighting, and lens) and an ordered list of shots. Repeat the bible VERBATIM at " +
      "the start of every shot's image_prompt so keyframes stay consistent. Order each " +
      "motion_prompt as subject -> action -> camera -> duration -> lighting -> style. " +
      `Return between 1 and ${numShots} shots; duration must be exactly ${SHORT_CLIP_SECONDS} or ${MAX_CLIP_SECONDS} seconds. ` +
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

    // dryRun: trace the graph without incurring image/video generation cost. It
    // defaults on ONLY when the scene was defaulted too — image and video are the
    // priciest capabilities in the catalog, and a run nobody configured should not
    // be the most expensive one in the gallery. Supply a scene and it really renders.
    const dryRun = input.dryRun ?? usedSampleScene;
    if (dryRun) {
      ctx.logger.info("dryRun — returning plan only");
      return terminate({
        dryRun: true,
        bible: plan.bible,
        shots: plan.shots,
        note: [
          ctx.shared.get("note"),
          "No keyframes or clips were rendered — this is the shot plan only. Pass `dryRun: false` to render the video.",
        ]
          .filter(Boolean)
          .join(" "),
      });
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
    // Launch the image-to-video job and pause on its result signal when queued.
    // The shared aspect ratio keeps clips visually consistent. Kling 2.1 Pro
    // accepts duration only as "5" or "10" and does not accept a seed parameter.
    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model,
      prompt: shot.motion_prompt,
      params: {
        image_url: imageUrl,
        duration: String(normalizeClipDuration(shot.duration)),
        aspect_ratio: must(ctx.shared.get("aspectRatio"), "aspectRatio"),
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
    if (!out?.fileId && !out?.downloadUrl) {
      const storageError = out?.storageError ? `: ${out.storageError}` : "";
      throw new Error(
        `video generation completed without a usable output for shot ${index + 1}${storageError}`,
      );
    }
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
  next: ["finalize"],
  // FAL ffmpeg merge is contractually synchronous today. `create()` returns
  // immediately for that shape; its explicit 12-minute bound only covers an
  // unexpected queue and stays below the runner's 15-minute step deadline.
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const scene = must(ctx.shared.get("scene"), "scene");
    const clips = must(ctx.shared.get("clips"), "clips");
    // Ready-to-use URLs for the merge input. For a longer-lived reference re-mint
    // from each clip's `fileId` via `ctx.sapiom.fileStorage.getDownloadUrl(fileId)`.
    const resolved = await resolveClipInputs(
      clips,
      async (fileId) => await ctx.sapiom.fileStorage.getDownloadUrl(fileId),
    );
    const videoUrls = resolved.map(({ url }) => url);
    ctx.logger.info("stitching clips", { clips: resolved.length });

    // FAL's merge endpoint requires at least two URLs. A one-shot scene is
    // already a finished video, so bypass the merge rather than making an
    // invalid request.
    if (clips.length === 1) {
      const only = resolved[0];
      ctx.logger.info("single clip scene — bypassing merge");
      return goto("finalize", {
        outputs: [
          {
            ...(only.clip.fileId !== undefined && {
              fileId: only.clip.fileId,
            }),
            downloadUrl: only.url,
          },
        ],
      });
    }

    const merged = await ctx.sapiom.contentGeneration.video.create({
      model: MERGE_MODEL,
      prompt: scene,
      params: { video_urls: videoUrls },
      storage: { visibility: "private" },
      timeoutMs: 12 * 60_000,
    });
    if (
      !merged.video?.fileId &&
      !merged.video?.downloadUrl &&
      !merged.video?.url
    ) {
      throw new Error(
        `video merge completed without a usable output${merged.video?.storageError ? `: ${merged.video.storageError}` : ""}`,
      );
    }
    const downloadUrl = merged.video.downloadUrl ?? merged.video.url;
    return goto("finalize", {
      outputs: [
        {
          ...(merged.video.fileId !== undefined && {
            fileId: merged.video.fileId,
          }),
          ...(downloadUrl !== undefined && { downloadUrl }),
          ...(merged.video.downloadUrlExpiresAt !== undefined && {
            downloadUrlExpiresAt: merged.video.downloadUrlExpiresAt,
          }),
          ...(merged.video.storageError !== undefined && {
            storageError: merged.video.storageError,
          }),
        },
      ],
    });
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
      hasVideo: Boolean(out?.fileId || out?.downloadUrl),
      durable: Boolean(out?.fileId),
    });
    return terminate({
      videoFileId: out?.fileId ?? null,
      downloadUrl: out?.downloadUrl ?? null,
      shots,
      ...(ctx.shared.get("note") ? { note: ctx.shared.get("note") } : {}),
    });
  },
});

export const agent = defineAgent<SceneInput, Shared>({
  name: "scene-to-video",
  entry: "decompose",
  steps: { decompose, keyframes, animate, collect, stitch, finalize },
});
