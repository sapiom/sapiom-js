import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import {
  IMAGE_RESULT_SIGNAL,
  VIDEO_RESULT_SIGNAL,
  type ImageResultPayload,
  type VideoResultPayload,
} from "@sapiom/tools";
import { z } from "zod/v4";

/**
 * Scene → Images → Video — a real multi-step generative pipeline.
 *
 * From one scene description this exercises three metered capabilities together
 * and shows off the async pause/resume + per-shot fan-out machinery that
 * separates a Sapiom agent from a plain script:
 *
 *   decompose ─▶ keyframe ⇄ collectKeyframe ─▶ animate ⇄ collect ─▶ stitch ─▶ finalize
 *   (models.run) (images.launch)  (drain)     (video.launch) (drain) (video.create) (terminal)
 *
 *   1. decompose — an LLM (`ctx.sapiom.models.run`) turns the scene into a global
 *      style/identity "bible" plus an ordered shot list.
 *   2. keyframe — one shot at a time: launch an async keyframe-image job
 *      (`images.launch`) and `pauseUntilSignal` on it; the webhook resumes
 *      `collectKeyframe` when that image is ready.
 *   3. collectKeyframe — record the finished keyframe, then loop back to
 *      `keyframe` for the next shot, or advance to `animate` once every
 *      keyframe is in.
 *   4. animate — one shot at a time: launch an async image-to-video job
 *      (`video.launch`) and `pauseUntilSignal` on it; the completion webhook
 *      resumes `collect` when that clip is ready.
 *   5. collect — record the finished clip, then loop back to `animate` for the
 *      next shot, or advance to `stitch` once every clip is in.
 *   6. stitch — concat the N clips with the synchronous video merge capability;
 *      the SDK's bounded poll fallback handles an unexpected queue.
 *   7. finalize — terminal; return the stitched video's `videoFileId` when
 *      persistence succeeded, plus the available `downloadUrl`.
 *
 * Why sequential rather than launching every job at once: a paused step waits
 * on a single `(signal, correlationId)` pair. Launching every job up front and
 * then draining would risk one finishing before we've paused on it (its resume
 * signal would have nowhere to land). Launching job i only after job i-1 has
 * resumed keeps a paused step always waiting before its job can complete. Both
 * fan-outs (`keyframe`⇄`collectKeyframe`, `animate`⇄`collect`) follow this same
 * shape, and `images.launch` — like `video.launch` — submits and returns
 * immediately rather than holding a routed request open for the full
 * generate+store, which is what a concurrent `Promise.all` of `images.create`
 * risked tripping past Core's 30s router cap.
 *
 * A zero-input run (no `scene`) shoots the built-in sample as a single shot —
 * real generation, kept cheap. Set `dryRun: true` explicitly to stop right
 * after planning and skip all image/video generation.
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

/**
 * A generated keyframe, carried forward to `animate` as the clip's first frame.
 * Crossed the wire from a resumed `images.launch` job, so — like {@link Clip} —
 * it carries only the durable/short-lived references, never a bare `url`.
 */
interface Keyframe {
  fileId?: string;
  downloadUrl?: string;
}

/** A finished clip, as recorded by `collect` from a resumed video job. */
export interface Clip {
  fileId?: string;
  downloadUrl?: string;
}

/** Trigger input. Only `scene` is required. */
interface SceneInput {
  /** The scene / story to turn into a short video. Omit ⇒ the sample scene. */
  scene?: string;
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
  /** Index of the next shot to render a keyframe for; advanced by `collectKeyframe`. */
  keyframeIndex: number;
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
 * Default image-to-video model. Kling 2.1 Pro is chosen for quality (the v1
 * default); swap for a budget model (Wan i2v, Seedance i2v) via the `model` input.
 */
const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v2.1/pro/image-to-video";
/** Video merge model used by `stitch` — concats the clips into one video. */
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

/** Resolve a single keyframe's usable URL, re-minting from `fileId` when needed. */
async function resolveFrameUrl(
  frame: Keyframe,
  getDownloadUrl: (fileId: string) => Promise<{ downloadUrl: string }>,
): Promise<string> {
  if (frame.downloadUrl) return frame.downloadUrl;
  if (frame.fileId) return (await getDownloadUrl(frame.fileId)).downloadUrl;
  throw new Error("keyframe has no usable download URL");
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

/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `scene` stays optional so the
 * tri-state holds: omitted ⇒ shoot the built-in sample scene, explicitly empty
 * ⇒ a reported mistake, present ⇒ shoot it.
 */
const entryInput = z.object({
  scene: z
    .string()
    .optional()
    .describe(
      "The scene / story to turn into a short video. Omit to use the built-in sample.",
    ),
  numShots: z
    .number()
    .default(3)
    .describe(
      "How many shots to plan (clamped 1–6). Ignored in favor of a single shot when `scene` is omitted, to keep a zero-input run cheap.",
    ),
  aspectRatio: z
    .string()
    .default("16:9")
    .describe("Aspect ratio passed to image + video generation."),
  model: z
    .string()
    .optional()
    .describe("Optional video model id, passed through to video.launch."),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Plan only — skip all image/video generation and return the plan.",
    ),
});

const decompose = defineStep({
  name: "decompose",
  inputSchema: entryInput,
  next: ["keyframe"],
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
    const scene = input.scene === undefined ? SAMPLE_SCENE : input.scene.trim();
    // A zero-input run must reach a real, cheap terminal — not a dry run. Clamp
    // the fan-out to a single shot whenever the scene itself was defaulted, so
    // `{}` in pays for exactly one LLM call, one keyframe, and one clip rather
    // than ballooning across `numShots`. Supply your own `scene` to shoot more.
    const numShots = usedSampleScene ? 1 : clampShots(input.numShots);
    if (usedSampleScene) {
      ctx.shared.set(
        "note",
        `Shot the built-in sample scene ("${SAMPLE_SCENE}") as a single shot to keep the zero-setup run cheap. Pass your own \`scene\` (and \`numShots\`) to shoot more.`,
      );
    }
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
    ctx.shared.set("keyframes", []);
    ctx.shared.set("keyframeIndex", 0);
    ctx.shared.set("clips", []);
    ctx.shared.set("animateIndex", 0);
    ctx.logger.info("planned shots", { shots: plan.shots.length });

    // dryRun is an explicit opt-in — trace the graph without incurring image/video
    // generation cost. It is never the default: image and video are the priciest
    // capabilities in the catalog, and a zero-input run should still really render.
    if (input.dryRun === true) {
      ctx.logger.info("dryRun — returning plan only");
      return terminate({
        dryRun: true,
        bible: plan.bible,
        shots: plan.shots,
        note: [
          ctx.shared.get("note"),
          "No keyframes or clips were rendered — this is the shot plan only. Omit `dryRun` to render the video.",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
    return goto("keyframe", {});
  },
});

const keyframe = defineStep({
  name: "keyframe",
  next: [],
  // Async pause/resume: the launched image job fires IMAGE_RESULT_SIGNAL on
  // completion, resuming `collectKeyframe` with the image's result. `launch`
  // submits and returns immediately rather than holding the routed request
  // open for the full generate+store, so a shot's keyframe never risks Core's
  // 30s router cap the way a concurrent `images.create` fan-out did.
  pause: { signal: IMAGE_RESULT_SIGNAL, resumeStep: "collectKeyframe" },
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    const index = must(ctx.shared.get("keyframeIndex"), "keyframeIndex");
    const shot = shots[index];

    ctx.logger.info("generating keyframe", {
      index: index + 1,
      of: shots.length,
    });
    const handle = await ctx.sapiom.contentGeneration.images.launch({
      prompt: shot.image_prompt,
      numImages: 1,
      storage: { visibility: "private" },
    });
    return await pauseUntilSignal(handle, { resumeStep: "collectKeyframe" });
  },
});

const collectKeyframe = defineStep({
  name: "collectKeyframe",
  next: ["keyframe", "animate"],
  async run(result: ImageResultPayload, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    const frames = must(ctx.shared.get("keyframes"), "keyframes");
    const index = must(ctx.shared.get("keyframeIndex"), "keyframeIndex");

    const img = result.outputs?.[0];
    if (!img?.fileId && !img?.downloadUrl) {
      const storageError = img?.storageError ? `: ${img.storageError}` : "";
      throw new Error(
        `keyframe generation completed without a usable output for shot ${index + 1}${storageError}`,
      );
    }
    const frame: Keyframe = {
      ...(img?.fileId !== undefined && { fileId: img.fileId }),
      ...(img?.downloadUrl !== undefined && { downloadUrl: img.downloadUrl }),
    };
    const nextFrames = [...frames, frame];
    const nextIndex = index + 1;
    ctx.shared.set("keyframes", nextFrames);
    ctx.shared.set("keyframeIndex", nextIndex);
    ctx.logger.info("collected keyframe", {
      collected: nextFrames.length,
      of: shots.length,
    });

    // More shots need a keyframe? Loop back. Otherwise every keyframe is in —
    // start animating.
    return nextIndex < shots.length
      ? goto("keyframe", {})
      : goto("animate", {});
  },
});

const animate = defineStep({
  name: "animate",
  next: [],
  // Async pause/resume: the launched video job fires VIDEO_RESULT_SIGNAL on
  // completion (the routed webhook), resuming `collect` with the clip's result.
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "collect" },
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const shots = must(ctx.shared.get("shots"), "shots");
    const frames = must(ctx.shared.get("keyframes"), "keyframes");
    const index = must(ctx.shared.get("animateIndex"), "animateIndex");
    const shot = shots[index];
    const frame = frames[index];
    const imageUrl = await resolveFrameUrl(frame, async (fileId) => {
      return await ctx.sapiom.fileStorage.getDownloadUrl(fileId);
    });
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
  // Video merge is contractually synchronous today. `create()` returns
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

    // The merge endpoint requires at least two URLs. A one-shot scene is
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
  steps: {
    decompose,
    keyframe,
    collectKeyframe,
    animate,
    collect,
    stitch,
    finalize,
  },
});
