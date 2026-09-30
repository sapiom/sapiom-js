import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  fail,
  type AgentExecutionContext,
} from "@sapiom/agent";
import {
  AGENTS_RESULT_SIGNAL,
  AgentDispatchError,
  VIDEO_RESULT_SIGNAL,
  fileStorage,
  type AgentRunResultPayload,
  type AspectRatio,
  type VideoResultPayload,
} from "@sapiom/tools";
import { z } from "zod/v4";

/**
 * Creative Studio — one scene in, a multi-shot video out, with the same character
 * in every shot and spoken lines rendered as native audio.
 *
 * One deployment plays two roles, chosen by whether the entry input carries a
 * `shot`:
 *
 *   coordinator:
 *     plan ─▶ plate ─▶ shots ─▶ gather ⇄ gather ─▶ stitch ─▶ finalize
 *    (llm.run) (image) (agents.launch ×N) (pause per child) (merge)
 *
 *   per-shot child (launched by `shots`, one per planned shot):
 *     plan ─▶ keyframe ⇄ check ─▶ animate ─▶ clip
 *            (kontext edit) (vision) (seedance-i2v, paused)
 *
 *   1. plan — one structured `llm.run`: a character description, a style bible,
 *      and a shot list (keyframe edit, motion prompt, optional spoken line,
 *      duration). `dryRun: true` stops here.
 *   2. plate — one `nano-banana-pro` image of the character alone on a plain
 *      background. Every keyframe is an edit of this image, which is what keeps
 *      the face and costume stable across shots.
 *   3. shots — launch one child run of this same agent per shot, all at once.
 *   4. gather — pause on each child in turn. A child agent's result is parked by
 *      the engine until its parent pauses on it, so a child that finishes before
 *      the coordinator gets to it resumes the coordinator at once. That is why
 *      the fan-out is over child runs and not over video jobs: a video job's
 *      completion webhook is dropped unless the run is paused on that exact job
 *      at the moment it fires.
 *   5. keyframe / check — the child edits the plate into its shot with
 *      `flux-pro-kontext-edit`, and a vision `llm.run` compares the result with
 *      the plate. A failing keyframe is redone once, then accepted with a warning.
 *   6. animate / clip — `seedance-i2v` animates the keyframe, with native audio
 *      when the shot has a line. The clip is kept in file storage before the
 *      child returns it.
 *   7. stitch — `merge-videos` joins the clips; a single shot skips the merge.
 *   8. finalize — returns the video, the plate, per-shot detail, warnings, the
 *      summed cost quotes and the wall-clock time.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** The character plate model. Renders a clean single figure at the requested aspect ratio. */
const PLATE_MODEL = "nano-banana-pro";
/** The keyframe model: edits the plate into a shot while holding the character's identity. */
const KEYFRAME_MODEL = "flux-pro-kontext-edit";
/**
 * Default image-to-video model: the cataloged image-to-video alias. It takes a
 * reference image, a duration and a native-audio flag. It rejects `aspectRatio`
 * (the clip follows the keyframe), so none is sent.
 */
const DEFAULT_VIDEO_MODEL = "seedance-i2v";
/**
 * The merge op. Raw provider id on purpose: the catalog has no merge alias, and
 * this is the only raw id in the template.
 */
const MERGE_MODEL = "fal-ai/ffmpeg-api/merge-videos";

const DEFAULT_NUM_SHOTS = 4;
const MAX_SHOTS = 6;
const MIN_CLIP_SECONDS = 4;
const MAX_CLIP_SECONDS = 15;
/** Spoken-line pacing, words per second (a line must fit its clip at a natural pace). */
const MAX_WORDS_PER_SECOND = 2.5;
/** A keyframe scoring below this against the plate is redone once. */
const CHECK_PASS_SCORE = 7;
/** Plate attempts: the first render plus one redo when it is not a single figure. */
const MAX_PLATE_ATTEMPTS = 2;
/** Keyframe attempts per shot: the first render plus one redo. */
const MAX_KEYFRAME_ATTEMPTS = 2;
/** `seedance-i2v` takes 3–9 min per clip; a pause that outlives this is a stuck job. */
const CLIP_PAUSE_TIMEOUT_MS = 30 * 60_000;
/** The coordinator waits on children that each wait on a clip, plus keyframe time. */
const CHILD_PAUSE_TIMEOUT_MS = 45 * 60_000;

const SAMPLE_SCENE =
  "an old lighthouse keeper climbs the spiral stairs at dusk, lights the great lamp, and speaks to the storm rolling in over the sea";

const ASPECT_RATIOS = [
  "16:9",
  "9:16",
  "1:1",
] as const satisfies readonly AspectRatio[];
type Ratio = (typeof ASPECT_RATIOS)[number];

// ─── Types ──────────────────────────────────────────────────────────────────

/** One planned shot, as `plan` returns it (see {@link readPlan}). */
export interface Shot {
  /** Instruction for editing the plate into this shot's keyframe. */
  edit_instruction: string;
  /** Motion prompt for the clip, without the spoken line. */
  motion_prompt: string;
  /** Who speaks the line, as seen on screen (e.g. "the keeper"). Empty when silent. */
  speaker: string;
  /** The spoken line, verbatim, or "" for a silent shot. */
  line: string;
  /** Clip length in whole seconds, 4–15. */
  duration: number;
}

export interface Plan {
  character: string;
  bible: string;
  shots: Shot[];
}

/** The vision check's verdict on one keyframe. */
export interface CheckVerdict {
  same_person: boolean;
  clothing_matches: boolean;
  palette_matches: boolean;
  composition_matches: boolean;
  score: number;
  issues: string;
}

/** What a child run returns to the coordinator. */
export interface ShotResult {
  index: number;
  clipFileId: string;
  clipUrl: string;
  keyframeFileId: string;
  keyframeUrl: string;
  keyframeAttempts: number;
  /** The verdict on the keyframe that was animated. */
  check: CheckVerdict | null;
  /** Every verdict, one per keyframe attempt, oldest first. */
  checks: Array<CheckVerdict | null>;
  duration: number;
  line: string;
  audio: boolean;
  clipSeconds: number;
  costUsd: number;
  warnings: string[];
}

/** The per-shot job the coordinator hands each child. */
interface ShotJob {
  index: number;
  shot: Shot;
  plateFileId: string;
  character: string;
  bible: string;
  model?: string;
}

interface StudioInput {
  scene?: string;
  numShots?: number;
  aspectRatio?: string;
  model?: string;
  dryRun?: boolean;
  /** Set only by the coordinator when it launches a per-shot child run. */
  shot?: ShotJob;
}

interface Shared extends Record<string, unknown> {
  // coordinator
  startedAt: number;
  scene: string;
  aspectRatio: Ratio;
  model?: string;
  plan: Plan;
  plateFileId: string;
  childIds: string[];
  gatherIndex: number;
  results: Array<ShotResult | null>;
  costUsd: number;
  warnings: string[];
  note?: string;
  // child
  job: ShotJob;
  keyframeAttempt: number;
  keyframeFileId: string;
  keyframeCostUsd: number;
  lastCheck: CheckVerdict | null;
  checks: Array<CheckVerdict | null>;
  /** One keyframe file per attempt, parallel to `checks`. */
  keyframeIds: string[];
  childWarnings: string[];
  clipCostUsd: number;
}

// ─── Pure helpers (exported for the unit tests) ─────────────────────────────

export function clampShots(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_NUM_SHOTS;
  return Math.max(1, Math.min(MAX_SHOTS, Math.floor(n)));
}

export function clampDuration(d: unknown): number {
  if (typeof d !== "number" || !Number.isFinite(d)) return 5;
  return Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, Math.round(d)));
}

export function normalizeRatio(r: string | undefined): Ratio {
  return (ASPECT_RATIOS as readonly string[]).includes(r ?? "")
    ? (r as Ratio)
    : "16:9";
}

export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/** The most words a line can have and still be spoken naturally in `seconds`. */
export function maxWordsFor(seconds: number): number {
  return Math.floor(seconds * MAX_WORDS_PER_SECOND);
}

/**
 * The clip prompt: the planned motion prompt, then the line quoted verbatim.
 * The line is appended here, in code, so the model cannot paraphrase it.
 */
export function buildClipPrompt(shot: Shot): string {
  const motion = shot.motion_prompt.trim();
  if (shot.line.trim() === "") return motion;
  const speaker = shot.speaker.trim() || "The character";
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  return `${motion} ${who} says, clearly and at a natural pace: "${shot.line.trim()}"`;
}

/** A raw provider id (`vendor/model/...`) rather than a cataloged alias. */
export function isRawModelId(model: string): boolean {
  return model.includes("/");
}

/** Trim and end with a full stop, so joined prompt parts stay separate sentences. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function buildPlatePrompt(
  plan: Pick<Plan, "character" | "bible">,
  retry = false,
): string {
  return [
    `One photograph of one person standing alone: ${sentence(plan.character)}`,
    "The whole body is in frame from head to feet, in a relaxed pose, on a plain seamless light grey studio background.",
    `Rendering style: ${sentence(plan.bible)}`,
    "Exactly one figure, seen once. Not a character sheet or turnaround: no multiple views, no panels, no text, no labels, no captions.",
    retry
      ? "A previous attempt drew several views of the person; draw the person once."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildKeyframePrompt(
  job: Pick<ShotJob, "shot" | "bible">,
  retryIssues?: string,
): string {
  return [
    sentence(job.shot.edit_instruction),
    "Keep the person from the reference image exactly: same face, hair, age, build and clothing.",
    `Style: ${sentence(job.bible)}`,
    "No text or captions.",
    retryIssues
      ? `A previous attempt drifted from the reference (${retryIssues}); correct that.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function passesCheck(v: CheckVerdict): boolean {
  return (
    v.same_person &&
    v.clothing_matches &&
    v.palette_matches &&
    v.composition_matches &&
    v.score >= CHECK_PASS_SCORE
  );
}

/**
 * The attempt to animate when every attempt failed the check: a passing one
 * first, then one that at least keeps the person and clothing, then the higher
 * score. A redo can come back worse than the first render, so the last attempt
 * is not automatically the best.
 */
export function pickBestAttempt(
  checks: ReadonlyArray<CheckVerdict | null>,
): number {
  // An unchecked attempt ranks below any frame known to keep the person and
  // clothing, and above one known to have lost them.
  const rank = (v: CheckVerdict | null): number =>
    v === null
      ? 50
      : (passesCheck(v) ? 1000 : 0) +
        (v.same_person && v.clothing_matches ? 100 : 0) +
        v.score;
  let best = 0;
  checks.forEach((v, i) => {
    if (rank(v) > rank(checks[best])) best = i;
  });
  return best;
}

/** The plate check's verdict: a usable plate is one person and nothing else. */
export interface PlateVerdict {
  people: number;
  has_text_or_panels: boolean;
}

export function plateUsable(v: PlateVerdict): boolean {
  return v.people === 1 && !v.has_text_or_panels;
}

export const PLATE_CHECK_TOOL = "inspect_plate";

const PLATE_CHECK_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "integer",
      minimum: 0,
      description:
        "How many human figures are drawn, counting every view of the same person separately (a turnaround sheet with three views is 3).",
    },
    has_text_or_panels: {
      type: "boolean",
      description:
        "True when the image has any text, labels, captions, borders or separate panels.",
    },
  },
  required: ["people", "has_text_or_panels"],
  additionalProperties: false,
};

// ─── Plan schema and reader ─────────────────────────────────────────────────

export const PLAN_TOOL = "emit_studio_plan";

export function buildPlanSchema(numShots: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      character: {
        type: "string",
        description:
          "The one recurring character: age, build, face, hair, and every item of clothing with its colour. Concrete enough to draw the same person twice.",
      },
      bible: {
        type: "string",
        description:
          "One paragraph fixing the look of every shot: medium, lens, lighting, colour palette, texture.",
      },
      shots: {
        type: "array",
        minItems: numShots,
        maxItems: numShots,
        items: {
          type: "object",
          properties: {
            edit_instruction: {
              type: "string",
              description:
                "An image-edit instruction that places the character from the reference image into this shot: the setting, the pose, the framing (wide / medium / close-up) and what they hold. Refer to them as 'the person'.",
            },
            motion_prompt: {
              type: "string",
              description:
                "Under 80 words. The subject and its visible action first, with concrete verbs; then the setting; then exactly ONE camera sentence on its own (e.g. 'Slow push-in at eye level.'); then lighting and palette. Do NOT include the spoken line.",
            },
            speaker: {
              type: "string",
              description:
                "Who speaks the line, as seen on screen (e.g. 'the keeper'). Empty string for a silent shot.",
            },
            line: {
              type: "string",
              description:
                "The words spoken on camera, verbatim, no quotation marks. Empty string for a silent shot.",
            },
            duration: {
              type: "integer",
              minimum: MIN_CLIP_SECONDS,
              maximum: MAX_CLIP_SECONDS,
              description: `Clip length in whole seconds, ${MIN_CLIP_SECONDS}–${MAX_CLIP_SECONDS}.`,
            },
          },
          required: [
            "edit_instruction",
            "motion_prompt",
            "speaker",
            "line",
            "duration",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["character", "bible", "shots"],
    additionalProperties: false,
  };
}

/**
 * The motion-prompt rules, ported from Polsia's content-gen video prompt: action
 * beats scale with duration, exactly one camera sentence, concrete verbs, and a
 * spoken line sized to the clip at 2–2.5 words per second.
 */
export function buildPlanSystem(numShots: number): string {
  return [
    "You are a director planning a short multi-shot video with ONE recurring character.",
    "Describe the character once, precisely, so an illustrator could draw the same person in every shot. Write a style bible that fixes the look of every shot.",
    `Plan exactly ${numShots} shots that tell the scene in order.`,
    "For each shot write an image-edit instruction that places the character into the shot, and a motion prompt for an image-to-video model.",
    "Motion prompt rules: lead with the subject and visible action, using concrete verbs with physical consequences, never abstract moods.",
    "Scale the action to the clip: a clip of 6 seconds or less gets exactly ONE beat of action, 7–9 seconds at most TWO, 10 seconds or more at most THREE.",
    "Then the setting, then exactly ONE camera instruction as its own short sentence, then lighting and palette. Do not script more action than fits.",
    "Spoken lines: give a line only where the scene calls for speech. Keep it to 2–2.5 words per second of clip (a 6-second clip holds 12–15 words), in one complete sentence, or two for clips over 6 seconds. Put the line in `line`, never in the motion prompt, and name who says it in `speaker`.",
    "If the user's scene quotes dialogue, use it verbatim.",
  ].join(" ");
}

export function readPlan(structured: unknown, maxShots: number): Plan {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "plan: the model returned no structured plan — refusing to render an invented one.",
    );
  }
  const raw = structured as Partial<Plan>;
  const need = (v: unknown, what: string): string => {
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(
        `plan: the model returned no ${what} — refusing to invent one.`,
      );
    }
    return v.trim();
  };
  const character = need(raw.character, "character description");
  const bible = need(raw.bible, "style bible");
  const rawShots = Array.isArray(raw.shots) ? raw.shots.slice(0, maxShots) : [];
  if (rawShots.length === 0) {
    throw new Error(
      "plan: the model returned no shots — refusing to invent a shot list.",
    );
  }
  const shots = rawShots.map((s, i): Shot => {
    const shot = (s ?? {}) as Partial<Shot>;
    return {
      edit_instruction: need(
        shot.edit_instruction,
        `edit instruction for shot ${i + 1}`,
      ),
      motion_prompt: need(
        shot.motion_prompt,
        `motion prompt for shot ${i + 1}`,
      ),
      speaker: typeof shot.speaker === "string" ? shot.speaker.trim() : "",
      line:
        typeof shot.line === "string"
          ? shot.line.trim().replace(/^["“]|["”]$/g, "")
          : "",
      duration: clampDuration(shot.duration),
    };
  });
  return { character, bible, shots };
}

/** Plan-level warnings: a spoken line longer than its clip can hold. */
export function planWarnings(plan: Plan): string[] {
  return plan.shots.flatMap((s, i) => {
    const words = countWords(s.line);
    const max = maxWordsFor(s.duration);
    return words > max
      ? [
          `Shot ${i + 1}: the line has ${words} words for a ${s.duration}s clip (about ${max} fit); it may be rushed or cut off.`,
        ]
      : [];
  });
}

// ─── Check schema ───────────────────────────────────────────────────────────

export const CHECK_TOOL = "score_keyframe";

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    same_person: {
      type: "boolean",
      description:
        "Is the person in image 2 recognisably the same person as in image 1 (face, hair, age, build)?",
    },
    clothing_matches: {
      type: "boolean",
      description:
        "Does image 2 keep the clothing and accessories of image 1 (items and colours)?",
    },
    palette_matches: {
      type: "boolean",
      description: "Does image 2 follow the style bible's palette and look?",
    },
    composition_matches: {
      type: "boolean",
      description:
        "Does image 2 show the shot the instruction asked for (setting, pose, framing)?",
    },
    score: {
      type: "integer",
      minimum: 0,
      maximum: 10,
      description:
        "Overall consistency with image 1 and the shot instruction, 0–10.",
    },
    issues: {
      type: "string",
      description: "Short list of what drifted, or an empty string.",
    },
  },
  required: [
    "same_person",
    "clothing_matches",
    "palette_matches",
    "composition_matches",
    "score",
    "issues",
  ],
  additionalProperties: false,
};

export function readVerdict(structured: unknown): CheckVerdict {
  const v = (structured ?? {}) as Partial<CheckVerdict>;
  if (typeof v.same_person !== "boolean" || typeof v.score !== "number") {
    throw new Error("check: the vision model returned no verdict");
  }
  return {
    same_person: v.same_person,
    clothing_matches: v.clothing_matches === true,
    palette_matches: v.palette_matches === true,
    composition_matches: v.composition_matches === true,
    score: v.score,
    issues: typeof v.issues === "string" ? v.issues : "",
  };
}

// ─── Small runtime helpers ──────────────────────────────────────────────────

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

function costOf(x: { cost?: { estimateUsd?: number } } | undefined): number {
  const n = x?.cost?.estimateUsd;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Hosts a generation result may point at: the media provider and file storage. */
const MEDIA_HOSTS = [
  "fal.media",
  "storage.googleapis.com",
  "file-storage.services.sapiom.ai",
];

/**
 * Refuse to fetch anything but an https URL on a known media host, so a
 * malformed or hostile result cannot point this step at an internal address.
 */
export function assertMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `refusing to fetch a malformed media URL: ${url.slice(0, 120)}`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (parsed.protocol !== "https:" || !allowed) {
    throw new Error(`refusing to fetch media from ${parsed.protocol}//${host}`);
  }
}

/**
 * Copy a provider-hosted file into Sapiom file storage and return its id. Used
 * when a generation comes back with a URL but no `fileId`: merging from a raw
 * provider URL would tie the final video to a link that expires.
 */
async function persistFromUrl(
  ctx: AgentExecutionContext<Shared>,
  url: string,
  contentType: string,
  fileName: string,
): Promise<string> {
  assertMediaUrl(url);
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `could not fetch ${fileName} to persist it: HTTP ${res.status}`,
    );
  const bytes = new Uint8Array(await res.arrayBuffer());
  const up = await ctx.sapiom.fileStorage.upload({
    contentType,
    fileName,
    fileSize: bytes.byteLength,
    visibility: "public",
  });
  const put = await fetch(up.uploadUrl, {
    method: "PUT",
    headers: up.requiredHeaders,
    body: bytes,
  });
  if (!put.ok)
    throw new Error(`could not upload ${fileName}: HTTP ${put.status}`);
  return up.fileId;
}

/** How many times a structured model call is tried before its caller gets nothing. */
const STRUCTURED_ATTEMPTS = 3;

type LlmRequest = Parameters<
  AgentExecutionContext<Shared>["sapiom"]["llm"]["run"]
>[0]["request"];

/**
 * One structured `llm.run` call, read back with `structuredOf`.
 *
 * `output` asks for a forced tool call, but when the served model thinks first
 * the tool call is not guaranteed: on prod the plate check came back as prose
 * in 7 of 10 calls with no system prompt, and 0 of 10 with the instruction
 * below. So the instruction is always added, and a reply without the tool call
 * is retried, as is a thrown call. Returns undefined when every attempt
 * answered in prose; rethrows when the last attempt threw.
 */
export async function runStructured(
  ctx: AgentExecutionContext<Shared>,
  request: LlmRequest,
  tool: { name: string; schema: Record<string, unknown> },
): Promise<unknown> {
  const system = [
    typeof request.system === "string" ? request.system : "",
    `Answer only by calling the ${tool.name} tool. Never answer in text.`,
  ]
    .filter(Boolean)
    .join(" ");
  let lastError: unknown;
  for (let attempt = 1; attempt <= STRUCTURED_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await ctx.sapiom.llm.run({
        request: { ...request, system },
        output: tool,
      });
    } catch (err) {
      // A gateway blip (a 502 "upstream_unavailable" was seen on prod) is worth
      // another try; the last error is rethrown if every attempt fails.
      lastError = err;
      ctx.logger.warn("structured model call failed", {
        tool: tool.name,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    lastError = undefined;
    const structured = ctx.sapiom.llm.structuredOf(res, tool.name);
    if (structured !== undefined) return structured;
    ctx.logger.warn("model answered without the tool call", {
      tool: tool.name,
      attempt,
      stopReason: (res as { stop_reason?: string }).stop_reason,
    });
  }
  if (lastError !== undefined) throw lastError;
  return undefined;
}

/**
 * Count the figures on the plate. Returns null when the check cannot run: the
 * plate is then used unchecked rather than blocking the run.
 */
async function inspectPlate(
  ctx: AgentExecutionContext<Shared>,
  plateFileId: string,
): Promise<PlateVerdict | null> {
  try {
    const v = (await runStructured(
      ctx,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  url: fileStorage.getPublicUrl(plateFileId),
                },
              },
              {
                type: "text",
                text: "This image should show one person, once, on a plain background. Count the figures and say whether there is any text or paneling.",
              },
            ],
          },
        ],
        max_tokens: 2000,
      },
      { name: PLATE_CHECK_TOOL, schema: PLATE_CHECK_SCHEMA },
    )) as Partial<PlateVerdict> | undefined;
    if (typeof v?.people !== "number") return null;
    return {
      people: v.people,
      has_text_or_panels: v.has_text_or_panels === true,
    };
  } catch (err) {
    ctx.logger.warn("plate check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Entry contract ─────────────────────────────────────────────────────────

const shotJobSchema = z.object({
  index: z.number(),
  shot: z.object({
    edit_instruction: z.string(),
    motion_prompt: z.string(),
    speaker: z.string(),
    line: z.string(),
    duration: z.number(),
  }),
  plateFileId: z.string(),
  character: z.string(),
  bible: z.string(),
  model: z.string().optional(),
});

const entryInput = z.object({
  scene: z
    .string()
    .optional()
    .describe(
      "The scene to film, with any dialogue quoted. Omit to use the built-in sample.",
    ),
  numShots: z
    .number()
    .default(DEFAULT_NUM_SHOTS)
    .describe(
      "How many shots to plan (1–6). A run with no `scene` always shoots one short silent shot.",
    ),
  aspectRatio: z
    .enum(ASPECT_RATIOS)
    .default("16:9")
    .describe(
      "Frame shape. The plate is rendered at this ratio and every shot follows it.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Optional image-to-video model alias (not a raw provider id). Defaults to seedance-i2v.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Plan only: return the character, bible and shot list without generating anything.",
    ),
  shot: shotJobSchema
    .optional()
    .describe(
      "Internal: set by the coordinator on each per-shot run. Leave empty.",
    ),
});

// ─── Coordinator steps ──────────────────────────────────────────────────────

const plan = defineStep({
  name: "plan",
  inputSchema: entryInput,
  next: ["plate", "keyframe"],
  terminal: true,
  async run(input: StudioInput, ctx: AgentExecutionContext<Shared>) {
    // A per-shot child run: skip planning and render the one shot it was given.
    if (input.shot) {
      ctx.shared.set("job", input.shot);
      ctx.shared.set("keyframeAttempt", 0);
      ctx.shared.set("keyframeCostUsd", 0);
      ctx.shared.set("lastCheck", null);
      ctx.shared.set("checks", []);
      ctx.shared.set("keyframeIds", []);
      ctx.shared.set("childWarnings", []);
      return goto("keyframe", {});
    }

    if (input.scene !== undefined && input.scene.trim() === "") {
      return terminate({
        status: "rejected",
        reason: "`scene` was empty — describe the scene to film.",
      });
    }
    if (input.model !== undefined && isRawModelId(input.model)) {
      return terminate({
        status: "rejected",
        reason: `\`model\` must be a cataloged image-to-video alias such as "seedance-i2v"; "${input.model}" is a raw provider id, which gets none of the neutral parameters (referenceImage, duration, audio) this agent sends.`,
      });
    }
    const usedSample = input.scene === undefined;
    const scene = usedSample ? SAMPLE_SCENE : input.scene!.trim();
    const numShots = usedSample ? 1 : clampShots(input.numShots);
    const aspectRatio = normalizeRatio(input.aspectRatio);
    if (usedSample) {
      ctx.shared.set(
        "note",
        "Shot the built-in sample scene as one short silent shot to keep the zero-setup run cheap. Pass your own `scene` for a full multi-shot video.",
      );
    }

    ctx.logger.info("planning", { numShots, aspectRatio });
    const structured = await runStructured(
      ctx,
      {
        system: buildPlanSystem(numShots),
        messages: [
          {
            role: "user",
            content: `Scene: ${scene}\nNumber of shots: ${numShots}\nAspect ratio: ${aspectRatio}`,
          },
        ],
        max_tokens: 8000,
      },
      { name: PLAN_TOOL, schema: buildPlanSchema(numShots) },
    );
    let p = readPlan(structured, numShots);
    if (usedSample) {
      // The zero-setup run is the cheapest real render: one 5s silent clip.
      p = {
        ...p,
        shots: [{ ...p.shots[0], duration: 5, line: "", speaker: "" }],
      };
    }

    ctx.shared.set("startedAt", Date.now());
    ctx.shared.set("scene", scene);
    ctx.shared.set("aspectRatio", aspectRatio);
    if (input.model) ctx.shared.set("model", input.model);
    ctx.shared.set("plan", p);
    ctx.shared.set("warnings", [
      ...(p.shots.length < numShots
        ? [
            `The plan has ${p.shots.length} shot(s) where ${numShots} were requested; the video has ${p.shots.length}.`,
          ]
        : []),
      ...planWarnings(p),
    ]);
    ctx.shared.set("costUsd", 0);

    if (input.dryRun === true) {
      return terminate({
        dryRun: true,
        character: p.character,
        bible: p.bible,
        shots: p.shots.map((s) => ({ ...s, clipPrompt: buildClipPrompt(s) })),
        warnings: ctx.shared.get("warnings"),
        ...(ctx.shared.get("note") ? { note: ctx.shared.get("note") } : {}),
      });
    }
    return goto("plate", {});
  },
});

const plate = defineStep({
  name: "plate",
  next: ["shots"],
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const p = must(ctx.shared.get("plan"), "plan");
    const aspectRatio = must(ctx.shared.get("aspectRatio"), "aspectRatio");
    const warnings = must(ctx.shared.get("warnings"), "warnings");
    let cost = 0;
    let fileId: string | undefined;
    // The plate is the reference for every keyframe, so a plate with several
    // figures (the model sometimes draws a turnaround sheet) is redone once.
    for (let attempt = 1; attempt <= MAX_PLATE_ATTEMPTS; attempt++) {
      ctx.logger.info("rendering character plate", { aspectRatio, attempt });
      const res = await ctx.sapiom.contentGeneration.images.create({
        model: PLATE_MODEL,
        prompt: buildPlatePrompt(p, attempt > 1),
        aspectRatio,
        // Public: the plate is returned to the caller and every child reads it.
        storage: { visibility: "public" },
        idempotencyKey: `${ctx.executionId}:plate:${attempt}`,
      });
      cost += costOf(res);
      const img = res.images?.[0];
      fileId = img?.fileId;
      if (!fileId && img?.url) {
        fileId = await persistFromUrl(ctx, img.url, "image/png", "plate.png");
      }
      if (!fileId) {
        throw new Error(
          `plate generation returned no usable image${img?.storageError ? `: ${img.storageError}` : ""}`,
        );
      }
      const verdict = await inspectPlate(ctx, fileId);
      ctx.logger.info("plate check", { attempt, verdict });
      if (verdict === null) {
        warnings.push(
          "The character plate could not be checked for extra figures or text; it was used unchecked.",
        );
        break;
      }
      if (plateUsable(verdict)) break;
      if (attempt === MAX_PLATE_ATTEMPTS) {
        warnings.push(
          `The character plate still shows ${verdict.people} figure(s)${verdict.has_text_or_panels ? " with text or panels" : ""} after a redo; it was used anyway.`,
        );
      }
    }
    ctx.shared.set("warnings", warnings);
    ctx.shared.set("plateFileId", must(fileId, "plateFileId"));
    ctx.shared.set("costUsd", cost);
    return goto("shots", {});
  },
});

const shots = defineStep({
  name: "shots",
  next: [],
  canFail: true,
  pause: { signal: AGENTS_RESULT_SIGNAL, resumeStep: "gather" },
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const p = must(ctx.shared.get("plan"), "plan");
    const plateFileId = must(ctx.shared.get("plateFileId"), "plateFileId");
    const model = ctx.shared.get("model");

    // Launch every shot at once. Each child renders its keyframe, checks it and
    // animates it on its own; `gather` collects them in order. The idempotency
    // key makes a retry of this step reattach to the same children.
    ctx.logger.info("launching shots", { shots: p.shots.length });
    let handles;
    try {
      handles = await Promise.all(
        p.shots.map((shot, index) =>
          ctx.sapiom.agents.launch({
            definition: ctx.agentName,
            idempotencyKey: `${ctx.executionId}:shot:${index}`,
            input: {
              shot: {
                index,
                shot,
                plateFileId,
                character: p.character,
                bible: p.bible,
                ...(model ? { model } : {}),
              } satisfies ShotJob,
            },
          }),
        ),
      );
    } catch (err) {
      if (err instanceof AgentDispatchError) {
        return fail(`could not launch a shot: ${err.message}`);
      }
      throw err;
    }
    const childIds = handles.map((h) =>
      must(h.executionId ?? undefined, "child executionId"),
    );
    ctx.shared.set("childIds", childIds);
    ctx.shared.set("gatherIndex", 0);
    ctx.shared.set("results", []);
    return await pauseUntilSignal(handles[0], {
      resumeStep: "gather",
      timeoutMs: CHILD_PAUSE_TIMEOUT_MS,
    });
  },
});

const gather = defineStep({
  name: "gather",
  next: ["stitch"],
  pause: { signal: AGENTS_RESULT_SIGNAL, resumeStep: "gather" },
  async run(
    result: AgentRunResultPayload<ShotResult>,
    ctx: AgentExecutionContext<Shared>,
  ) {
    const childIds = must(ctx.shared.get("childIds"), "childIds");
    const index = must(ctx.shared.get("gatherIndex"), "gatherIndex");
    const results = must(ctx.shared.get("results"), "results");
    const warnings = must(ctx.shared.get("warnings"), "warnings");

    let recorded: ShotResult | null = null;
    if (result?.status === "completed" && result.output?.clipFileId) {
      recorded = result.output;
      warnings.push(...result.output.warnings);
      ctx.shared.set(
        "costUsd",
        (ctx.shared.get("costUsd") ?? 0) + result.output.costUsd,
      );
    } else {
      const why =
        result?.status === "failed"
          ? JSON.stringify(result.error).slice(0, 300)
          : "no clip returned";
      warnings.push(
        `Shot ${index + 1} failed and was left out: ${why}. Its spend is not in costUsd, which covers delivered shots only.`,
      );
    }
    const nextResults = [...results, recorded];
    const nextIndex = index + 1;
    ctx.shared.set("results", nextResults);
    ctx.shared.set("warnings", warnings);
    ctx.shared.set("gatherIndex", nextIndex);
    ctx.logger.info("gathered shot", {
      shot: nextIndex,
      of: childIds.length,
      ok: Boolean(recorded),
    });

    if (nextIndex < childIds.length) {
      // A child that already finished has its result parked by the engine, so
      // this pause resumes at once; otherwise it waits for that child.
      return pauseUntilSignal({
        signal: AGENTS_RESULT_SIGNAL,
        correlationId: childIds[nextIndex],
        resumeStep: "gather",
        timeoutMs: CHILD_PAUSE_TIMEOUT_MS,
      });
    }
    return goto("stitch", {});
  },
});

const stitch = defineStep({
  name: "stitch",
  next: ["finalize"],
  canFail: true,
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const results = must(ctx.shared.get("results"), "results");
    const clips = results.filter((r): r is ShotResult => r !== null);
    if (clips.length === 0) {
      return fail("every shot failed; nothing to stitch", {
        output: { warnings: ctx.shared.get("warnings") },
      });
    }
    // Clips are always durable here: each child persisted its clip before returning.
    const urls = clips.map((c) => fileStorage.getPublicUrl(c.clipFileId));

    if (clips.length === 1) {
      ctx.logger.info("single shot — skipping the merge");
      return goto("finalize", { videoFileId: clips[0].clipFileId });
    }

    ctx.logger.info("merging clips", { clips: clips.length });
    const merged = await ctx.sapiom.contentGeneration.video.create({
      model: MERGE_MODEL,
      prompt: "merge",
      passthrough: { video_urls: urls },
      storage: { visibility: "public" },
      idempotencyKey: `${ctx.executionId}:merge`,
      timeoutMs: 12 * 60_000,
    });
    ctx.shared.set(
      "costUsd",
      (ctx.shared.get("costUsd") ?? 0) + costOf(merged),
    );
    let fileId = merged.video?.fileId;
    if (!fileId && merged.video?.url) {
      fileId = await persistFromUrl(
        ctx,
        merged.video.url,
        "video/mp4",
        "creative-studio.mp4",
      );
    }
    if (!fileId) {
      throw new Error(
        `merge returned no usable video${merged.video?.storageError ? `: ${merged.video.storageError}` : ""}`,
      );
    }
    return goto("finalize", { videoFileId: fileId });
  },
});

const finalize = defineStep({
  name: "finalize",
  next: [],
  terminal: true,
  async run(
    input: { videoFileId: string },
    ctx: AgentExecutionContext<Shared>,
  ) {
    const startedAt = must(ctx.shared.get("startedAt"), "startedAt");
    const plateFileId = must(ctx.shared.get("plateFileId"), "plateFileId");
    const p = must(ctx.shared.get("plan"), "plan");
    const results = must(ctx.shared.get("results"), "results");
    return terminate({
      downloadUrl: fileStorage.getPublicUrl(input.videoFileId),
      videoFileId: input.videoFileId,
      plateFileId,
      plateUrl: fileStorage.getPublicUrl(plateFileId),
      character: p.character,
      bible: p.bible,
      shots: p.shots.map((s, i) => ({ ...s, result: results[i] ?? null })),
      warnings: ctx.shared.get("warnings") ?? [],
      // Sum of the per-call quotes for the plate, the merge, and every delivered
      // shot's keyframes and clip. A failed shot's spend is not included (its
      // warning says so), nor are the model calls, which are not metered per run.
      costUsd: round2(ctx.shared.get("costUsd") ?? 0),
      wallClockSeconds: Math.round((Date.now() - startedAt) / 1000),
      ...(ctx.shared.get("note") ? { note: ctx.shared.get("note") } : {}),
    });
  },
});

// ─── Per-shot child steps ───────────────────────────────────────────────────

const keyframe = defineStep({
  name: "keyframe",
  next: ["check"],
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const job = must(ctx.shared.get("job"), "job");
    const attempt = (ctx.shared.get("keyframeAttempt") ?? 0) + 1;
    const last = ctx.shared.get("lastCheck");
    ctx.logger.info("rendering keyframe", { shot: job.index + 1, attempt });

    const res = await ctx.sapiom.contentGeneration.images.create({
      model: KEYFRAME_MODEL,
      prompt: buildKeyframePrompt(job, attempt > 1 ? last?.issues : undefined),
      referenceImage: job.plateFileId,
      // Public: the keyframe is returned per shot so a reviewer can see it.
      storage: { visibility: "public" },
      idempotencyKey: `${ctx.executionId}:keyframe:${attempt}`,
    });
    const img = res.images?.[0];
    let fileId = img?.fileId;
    if (!fileId && img?.url) {
      fileId = await persistFromUrl(
        ctx,
        img.url,
        "image/png",
        `keyframe-${job.index + 1}.png`,
      );
    }
    if (!fileId) {
      throw new Error(
        `keyframe for shot ${job.index + 1} returned no usable image${img?.storageError ? `: ${img.storageError}` : ""}`,
      );
    }
    ctx.shared.set("keyframeAttempt", attempt);
    ctx.shared.set("keyframeFileId", fileId);
    ctx.shared.set("keyframeIds", [
      ...(ctx.shared.get("keyframeIds") ?? []),
      fileId,
    ]);
    ctx.shared.set(
      "keyframeCostUsd",
      (ctx.shared.get("keyframeCostUsd") ?? 0) + costOf(res),
    );
    return goto("check", {});
  },
});

const check = defineStep({
  name: "check",
  next: ["keyframe", "animate"],
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const job = must(ctx.shared.get("job"), "job");
    const attempt = must(ctx.shared.get("keyframeAttempt"), "keyframeAttempt");
    const keyframeFileId = must(
      ctx.shared.get("keyframeFileId"),
      "keyframeFileId",
    );
    const warnings = must(ctx.shared.get("childWarnings"), "childWarnings");

    let verdict: CheckVerdict | null = null;
    try {
      const structured = await runStructured(
        ctx,
        {
          system:
            "You check storyboard frames for continuity. Image 1 is the character reference. Image 2 is a frame that must show the same character in a new shot. Judge strictly: a different face, a changed hat or coat, or a missing accessory is a failure, and so is a frame that ignores the shot instruction's setting, pose or framing.",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Image 1 (character reference):" },
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: fileStorage.getPublicUrl(job.plateFileId),
                  },
                },
                { type: "text", text: "Image 2 (shot keyframe):" },
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: fileStorage.getPublicUrl(keyframeFileId),
                  },
                },
                {
                  type: "text",
                  text: `Character: ${job.character}\nStyle bible: ${job.bible}\nShot instruction: ${job.shot.edit_instruction}`,
                },
              ],
            },
          ],
          max_tokens: 4000,
        },
        { name: CHECK_TOOL, schema: CHECK_SCHEMA },
      );
      verdict = readVerdict(structured);
    } catch (err) {
      // A check that cannot run must not block the shot: render it and say so.
      warnings.push(
        `Shot ${job.index + 1}: the keyframe check could not run (${err instanceof Error ? err.message : String(err)}); the keyframe was used unchecked.`,
      );
    }
    ctx.shared.set("lastCheck", verdict);
    ctx.shared.set("checks", [...(ctx.shared.get("checks") ?? []), verdict]);
    ctx.logger.info("keyframe check", {
      shot: job.index + 1,
      attempt,
      verdict,
    });

    if (verdict && !passesCheck(verdict) && attempt < MAX_KEYFRAME_ATTEMPTS) {
      return goto("keyframe", {});
    }
    const checks = ctx.shared.get("checks") ?? [];
    const passed = verdict !== null && passesCheck(verdict);
    if (!passed && checks.length > 1) {
      // A redo was made and did not pass (or could not be checked): animate
      // the best attempt, not simply the last one.
      const ids = ctx.shared.get("keyframeIds") ?? [];
      const best = pickBestAttempt(checks);
      const chosen = checks[best];
      if (ids[best]) ctx.shared.set("keyframeFileId", ids[best]);
      ctx.shared.set("lastCheck", chosen);
      warnings.push(
        chosen
          ? `Shot ${job.index + 1}: no keyframe passed the check after a redo; used attempt ${best + 1} of ${checks.length} (score ${chosen.score}/10: ${chosen.issues || "no detail"}).`
          : `Shot ${job.index + 1}: no keyframe passed the check after a redo; used attempt ${best + 1} of ${checks.length}, which could not be checked.`,
      );
    } else if (verdict && !passed) {
      warnings.push(
        `Shot ${job.index + 1}: the keyframe did not pass the check (score ${verdict.score}/10: ${verdict.issues || "no detail"}); it was used anyway.`,
      );
    }
    ctx.shared.set("childWarnings", warnings);
    return goto("animate", {});
  },
});

const animate = defineStep({
  name: "animate",
  next: [],
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "clip" },
  async run(_input: unknown, ctx: AgentExecutionContext<Shared>) {
    const job = must(ctx.shared.get("job"), "job");
    const keyframeFileId = must(
      ctx.shared.get("keyframeFileId"),
      "keyframeFileId",
    );
    const hasLine = job.shot.line.trim() !== "";
    ctx.logger.info("animating", {
      shot: job.index + 1,
      duration: job.shot.duration,
      audio: hasLine,
    });

    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model: job.model ?? DEFAULT_VIDEO_MODEL,
      prompt: buildClipPrompt(job.shot),
      referenceImage: keyframeFileId,
      duration: job.shot.duration,
      audio: hasLine,
      // No aspectRatio: seedance-i2v rejects it, and the clip follows the keyframe.
      storage: { visibility: "public" },
      idempotencyKey: `${ctx.executionId}:clip`,
    });
    ctx.shared.set("clipCostUsd", costOf(handle));
    return await pauseUntilSignal(handle, {
      resumeStep: "clip",
      timeoutMs: CLIP_PAUSE_TIMEOUT_MS,
    });
  },
});

const clip = defineStep({
  name: "clip",
  next: [],
  terminal: true,
  async run(result: VideoResultPayload, ctx: AgentExecutionContext<Shared>) {
    const job = must(ctx.shared.get("job"), "job");
    const warnings = must(ctx.shared.get("childWarnings"), "childWarnings");
    const out = result.outputs?.[0];
    if (out?.generationError) {
      throw new Error(
        `clip generation failed for shot ${job.index + 1}: ${out.generationError}`,
      );
    }
    // Never hand the coordinator a raw provider URL: keep the clip in file
    // storage first, so the merge and the final output use a durable link.
    let fileId = out?.fileId;
    if (!fileId && out?.downloadUrl) {
      fileId = await persistFromUrl(
        ctx,
        out.downloadUrl,
        "video/mp4",
        `shot-${job.index + 1}.mp4`,
      );
      warnings.push(
        `Shot ${job.index + 1}: the clip came back without a stored copy; it was re-uploaded.`,
      );
    }
    if (!fileId) {
      throw new Error(
        `clip for shot ${job.index + 1} came back with no usable output${out?.storageError ? `: ${out.storageError}` : ""}`,
      );
    }
    const keyframeFileId = must(
      ctx.shared.get("keyframeFileId"),
      "keyframeFileId",
    );
    const shotResult: ShotResult = {
      index: job.index,
      clipFileId: fileId,
      clipUrl: fileStorage.getPublicUrl(fileId),
      keyframeFileId,
      keyframeUrl: fileStorage.getPublicUrl(keyframeFileId),
      keyframeAttempts: must(
        ctx.shared.get("keyframeAttempt"),
        "keyframeAttempt",
      ),
      check: ctx.shared.get("lastCheck") ?? null,
      checks: ctx.shared.get("checks") ?? [],
      duration: job.shot.duration,
      line: job.shot.line,
      audio: job.shot.line.trim() !== "",
      clipSeconds: job.shot.duration,
      costUsd: round2(
        (ctx.shared.get("keyframeCostUsd") ?? 0) +
          (ctx.shared.get("clipCostUsd") ?? 0),
      ),
      warnings,
    };
    return terminate(shotResult);
  },
});

export const agent = defineAgent<StudioInput, Shared>({
  name: "creative-studio",
  entry: "plan",
  steps: {
    plan,
    plate,
    shots,
    gather,
    stitch,
    finalize,
    keyframe,
    check,
    animate,
    clip,
  },
});
