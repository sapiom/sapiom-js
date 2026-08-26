import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import {
  EmailHttpError,
  IMAGE_RESULT_SIGNAL,
  VIDEO_RESULT_SIGNAL,
  fileStorage,
  type AspectRatio,
  type ImageResultPayload,
  type VideoResultPayload,
} from "@sapiom/tools";
import { z } from "zod/v4";

/**
 * Content Pack — one long-form source into a multi-channel pack, fanned out to
 * every recipient on your list.
 *
 * Feed it a blog post or a transcript and it fans that single source out into a
 * tweet thread, a LinkedIn post, a newsletter, quote graphics, and a short video
 * clip — then packages the lot into one markdown brief and emails it to every
 * recipient you name. It ships with a `schedule` input so it reads as a standing
 * "repurpose the latest post" agent you point at a cron cadence, not just a
 * one-shot.
 *
 *   repurpose ─▶ graphics ⇄ collectGraphic ─▶ clip ⇄ collectClip ─▶ package ─▶ deliver
 *   (llm.run) (images.launch)  (drain)     (video.launch) (drain) (fileStorage) (email.send × N)
 *
 *   1. repurpose — an LLM (`ctx.sapiom.llm.run`) rewrites the source into every
 *      channel at once: the tweet thread, the LinkedIn post, the newsletter, the
 *      pull-quotes to render as graphics, and a short visual prompt for the teaser
 *      clip.
 *   2. graphics — launch an async quote-graphic image job (`images.launch`) for the
 *      next pull-quote and `pauseUntilSignal` on it; the image-generation webhook
 *      resumes `collectGraphic` when it's ready. The launch prompt is composed in
 *      code (`buildGraphicPrompt`) so the quote text is ALWAYS rendered into the
 *      graphic, on a typography-capable model (`ideogram-v3`).
 *   3. collectGraphic — record the finished graphic, then loop back to `graphics`
 *      for the next quote, or advance once every quote graphic is in.
 *   4. clip — render a short decorative teaser clip: launch an async text-to-video
 *      job (`video.launch`, cataloged alias) with a purpose-written short visual
 *      prompt (`buildClipPrompt`, deliberately no on-screen text) and
 *      `pauseUntilSignal` on it; the video-generation webhook resumes
 *      `collectClip` when the clip is ready.
 *   5. collectClip — record the finished clip.
 *   6. package — assemble the whole pack as one markdown document and upload it to
 *      file storage (`fileStorage.upload`) for a durable `fileId` + download URL.
 *   7. deliver — fan the pack out to every `deliverTo` recipient (`email.messages.send`),
 *      one message each; terminal.
 *
 * Why `graphics` and `clip` launch-and-pause one at a time rather than a concurrent
 * `Promise.all`: a paused step waits on a single `(signal, correlationId)` pair, so
 * launching job N only after job N-1 has resumed keeps a paused step always waiting
 * before its job can complete (the `scene-to-video` / `personalized-media-at-scale`
 * lesson — a concurrent fan-out of the routed sync image call also risks Core's 30s
 * router cap; `launch` enqueues and returns immediately, so that wall doesn't apply).
 *
 * `deliver`'s recipient loop is the map-reduce fan-out this template absorbs from
 * `personalized-media-at-scale`: map over the recipient list, send each
 * independently, then reduce into one delivered/skipped summary — a bad address
 * degrades that one recipient rather than sinking the batch.
 *
 * A run with no `deliverTo` recipients skips every send and returns the pack instead.
 */

/** One pull-quote plus the art direction used to render it as a graphic. */
interface QuoteGraphicSpec {
  /** The short, punchy line pulled from the source. */
  quote: string;
  /**
   * Art direction ONLY (palette, background, typography style) for the graphic that
   * frames {@link quote}. The quote text itself is composed into the final launch
   * prompt by {@link buildGraphicPrompt} — never trusted to the LLM, which is how
   * SAP-2781's blank "quote graphic" shipped.
   */
  imagePrompt: string;
}

/** The LLM's repurposing of the source into every channel at once. */
interface Pack {
  /** Ordered tweets, each meant to stand alone but read as a thread. */
  tweetThread: string[];
  /** A single LinkedIn post (longer, first-person, no hashtags spam). */
  linkedInPost: string;
  /** A short newsletter section in markdown. */
  newsletter: string;
  /** Pull-quotes to render as graphics. */
  quoteGraphics: QuoteGraphicSpec[];
  /**
   * Short single-shot VISUAL prompt for the teaser clip — decorative motion with
   * no on-screen text, not a narrated timeline. Guarded by
   * {@link buildClipPrompt}: a narration-script-shaped value is replaced with a
   * purpose-written prompt (feeding a 45s narration script to a 5s video model is
   * how SAP-2781's garbled clip was made).
   */
  videoScript: string;
}

/**
 * A generated quote graphic, carried forward to `clip` and into the pack. Crossed
 * the wire from a resumed `images.launch` job, so it carries only the
 * durable/short-lived references, never a bare synchronous `url`.
 */
interface Graphic {
  quote: string;
  fileId?: string;
  downloadUrl?: string;
}

/** The finished teaser clip, as recorded by `collectClip`. */
interface Clip {
  fileId?: string;
  downloadUrl?: string;
}

/** Trigger input. Only `source` is required. */
interface RepurposeInput {
  /** The blog post or transcript to repurpose (raw text). Omit ⇒ the sample. */
  source?: string;
  /** Optional title/topic for context in the generated copy. */
  title?: string;
  /** Who the content is for; steers tone (default a general professional audience). */
  audience?: string;
  /** How many quote graphics to make (default 2, clamped 1–4). */
  numQuotes?: number;
  /** Recipient email address(es). Omit and the pack is returned inline instead of emailed. */
  deliverTo?: string[];
  /** Cron cadence this pipeline is meant to run on (carried + reported). */
  schedule?: string;
  /** Optional video model — a Sapiom semantic alias (e.g. `"veo3-fast"`); cataloged aliases only. */
  model?: string;
  /** Render the teaser clip. Defaults to true for your own `source`, false for the built-in sample. */
  renderClip?: boolean;
  /** When true, generate the copy only — skip graphics, clip, upload, and email. */
  dryRun?: boolean;
}

interface Shared extends Record<string, unknown> {
  title: string;
  audience: string;
  schedule: string;
  deliverTo: string[];
  aspectRatio: AspectRatio;
  model?: string;
  /** Whether to render the (pricey) teaser clip. Off for the built-in sample run. */
  renderClip: boolean;
  pack: Pack;
  graphics: Graphic[];
  /** Index of the next pull-quote to render a graphic for; advanced by `collectGraphic`. */
  graphicIndex: number;
  clip: Clip | null;
  packFileId: string | null;
  packDownloadUrl: string | null;
  /** Set when the run repurposed the built-in sample post rather than the caller's. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;

/**
 * Quote-graphic image model: a typography-capable CATALOGED semantic alias, because
 * the quote text is rendered INTO the graphic (`gpt-image-2` also fits; the default
 * fast image model has weak typography and shipped SAP-2781's blank background).
 */
const IMAGE_MODEL = "ideogram-v3";
/**
 * Default teaser-clip model — a cataloged semantic alias (silent 5s text-to-video),
 * swappable via the `model` input. Raw provider ids are off the menu: only cataloged
 * models get neutral-param normalization (`aspectRatio`/`duration`), and allowlist
 * enforcement (SAP-2582/E8) will reject uncataloged ids with `400 unknown_model`
 * once it lands. At the time of writing no cataloged alias advertises
 * `referenceImage` (image-to-video), so the teaser is a decorative text-free motion
 * piece rather than an animation of a finished graphic.
 */
const DEFAULT_VIDEO_MODEL = "kling-standard";
/** Aspect ratio shared by the graphics + teaser clip so the pack reads as one set. */
const ASPECT_RATIO: AspectRatio = "16:9";
/** Teaser clip length in seconds — short video models render short clips best. */
const CLIP_SECONDS = 5;
/** Default cadence when the caller doesn't pass one: 09:00 every Monday. */
const DEFAULT_SCHEDULE = "0 9 * * 1";
/** Fan-out bounds on the pull-quote list. */
const DEFAULT_NUM_QUOTES = 2;
const MAX_QUOTES = 4;

/** Title paired with `SAMPLE_SOURCE`. */
const SAMPLE_TITLE = "Why small teams ship faster";
/**
 * The post a zero-input run repurposes. Real prose, because the model output is
 * the artifact — a one-line placeholder produces a content pack about nothing.
 */
const SAMPLE_SOURCE = `Small teams ship faster, and it is not because they work harder.

Every additional person on a project adds communication paths, not just capacity. Three people have three pairs to keep in sync; ten people have forty-five. That arithmetic is why a team of ten rarely produces three times what a team of three does — most of the extra effort is spent on staying aligned rather than on the work itself.

The second reason is that small teams cannot afford process theatre. There is no room for a weekly status meeting whose only output is a document nobody reads, or a design review whose purpose is to distribute blame. When four people can see the whole system, coordination happens in the code and in a two-minute conversation. Process gets added when trust or context runs out, and small teams have plenty of both.

The third reason is the one people miss: small teams make smaller decisions. A large team has to plan far ahead, because reversing course means re-aligning everyone. A small team can try something on Tuesday and abandon it on Thursday, so it takes more shots and learns faster. Speed here is a consequence of cheap reversal, not of typing quickly.

None of this means small is always right. Some problems genuinely need more hands, and a team of four cannot staff an on-call rotation without burning out. The useful question is not "how do we grow?" but "what is the smallest team that can own this end to end?" Answer that honestly, and the shipping speed follows.`;

function clampQuotes(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_NUM_QUOTES;
  return Math.max(1, Math.min(MAX_QUOTES, Math.floor(n)));
}

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

/**
 * True for an address RFC 2606 reserves for documentation. Mail to these is
 * guaranteed not to arrive; a caller who pastes a placeholder recipient gets an
 * honest per-recipient skip rather than a false "delivered".
 */
export function isReservedAddress(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return (
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain === "example" ||
    domain.endsWith(".example") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}

/**
 * Compose the final launch prompt for one quote graphic. The quote TEXT is the
 * artifact, so the render-the-text directive is built here in code rather than
 * trusted to the LLM: SAP-2781 shipped a blank navy background
 * as the "quote graphic" because the LLM's imagePrompt asked for "negative space
 * for text overlay … no text in the image" and no overlay step exists. The LLM's
 * `imagePrompt` is demoted to art direction appended after the text directive.
 */
export function buildGraphicPrompt(spec: QuoteGraphicSpec): string {
  const quote = spec.quote.trim();
  const style = spec.imagePrompt.trim();
  return (
    `Typography-forward quote graphic. Render this exact text, large, legible, ` +
    `and centered, as the visual centerpiece of the image: "${quote}". ` +
    (style ||
      "Clean, modern, solid dark background, generous margins, no watermark.")
  );
}

/**
 * The explicit `renderClip` input always wins; the sample-source heuristic is
 * only the default for callers who didn't say (SAP-2858 — the field used to be
 * absent from the schema, so an explicit `false` was stripped and a clip was
 * rendered and billed anyway).
 */
export function resolveRenderClip(
  explicit: boolean | undefined,
  usedSampleSource: boolean,
): boolean {
  return explicit ?? !usedSampleSource;
}

/**
 * System prompt for the repurpose step. Exported so tests can pin the rules
 * that keep shipping-quality output: art-direction-only imagePrompts, text-free
 * videoScript, tweet length, and — SAP-2858 — no placeholders: the model is told
 * it has no author/reader identity to fill in, so it stops writing sign-offs
 * that need one (a run delivered "More soon, [Your name]" verbatim to an inbox).
 */
export function buildRepurposeSystem(
  audience: string,
  numQuotes: number,
): string {
  return (
    "You are a content strategist repurposing one long-form SOURCE (a blog post " +
    "or transcript) into a multi-channel content pack for " +
    `${audience}. Keep the author's meaning; do not invent facts. ` +
    `Write ${numQuotes} short, punchy pull-quote(s). Each quote's "imagePrompt" ` +
    "is ART DIRECTION ONLY for its quote graphic (palette, background, " +
    "typography style) — the quote text itself is composed into the image " +
    "prompt by the pipeline, so never request empty space or say the image " +
    'should contain no text. "videoScript" is a short single-shot visual ' +
    `prompt (under 300 characters) for a ${CLIP_SECONDS}-second silent teaser ` +
    "clip — describe decorative motion with NO on-screen text (video models " +
    "render text illegibly; the quote lives in the graphics), never a " +
    "narrated timeline or script sections. Tweets must each be <= 280 " +
    "characters. " +
    "You do not know the author's name, company, or the reader's name, and " +
    "nothing is filled in later — so no greetings or sign-offs that need one, " +
    "and no bracketed fill-ins anywhere in the pack. End the newsletter on its " +
    "takeaway line."
  );
}

/**
 * The forced tool call `repurpose` reads the pack out of. `llm.run`'s `output`
 * appends this tool to the request and pins `tool_choice` to it, so the pack
 * arrives as a typed `tool_use` block.
 *
 * This replaced a "reply with ONLY minified JSON" prompt plus a
 * first-`{`-to-last-`}` slice. That slice caught the model echoing this very
 * schema back to itself mid-reasoning, `JSON.parse` threw, and the customer was
 * emailed a canned pack — a tweet thread reading `"<title>: a quick thread. 🧵"`
 * over the first 240 characters of their own source — on a run that reported
 * `succeeded`. There is now no prose to slice.
 */
export const REPURPOSE_TOOL = "emit_content_pack";

export function buildRepurposeSchema(
  numQuotes: number,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      tweetThread: {
        type: "array",
        items: { type: "string" },
        description:
          "Ordered tweets, each <= 280 characters, each standing alone but reading as a thread.",
      },
      linkedInPost: {
        type: "string",
        description: "A single LinkedIn post — longer, first-person.",
      },
      newsletter: {
        type: "string",
        description:
          "A short newsletter section in markdown, ending on its takeaway line.",
      },
      quoteGraphics: {
        type: "array",
        minItems: numQuotes,
        maxItems: numQuotes,
        items: {
          type: "object",
          properties: {
            quote: {
              type: "string",
              description: "A short, punchy pull-quote.",
            },
            imagePrompt: {
              type: "string",
              description:
                "ART DIRECTION ONLY for this quote's graphic (palette, background, typography style) — never ask for empty space or a text-free image.",
            },
          },
          required: ["quote", "imagePrompt"],
          additionalProperties: false,
        },
        description: `Exactly ${numQuotes} pull-quote(s) to render as graphics.`,
      },
      videoScript: {
        type: "string",
        description: `Short single-shot VISUAL prompt (under 300 characters) for a ${CLIP_SECONDS}-second silent teaser clip — decorative motion, NO on-screen text, never a narrated timeline.`,
      },
    },
    required: [
      "tweetThread",
      "linkedInPost",
      "newsletter",
      "quoteGraphics",
      "videoScript",
    ],
    additionalProperties: false,
  };
}

/**
 * True when a videoScript reads like a narration script rather than a short
 * single-shot visual prompt: timeline markers ("HOOK (0-5s)"), script section
 * headers, multi-paragraph structure, or simply far too much direction for a
 * {@link CLIP_SECONDS}-second silent clip. Feeding one to a short video model is
 * how SAP-2781's garbled clip was made — the model hallucinates text-panel UI
 * trying to depict the script.
 */
export function isNarrationScript(script: string): boolean {
  return (
    script.length > 300 ||
    /\(\s*\d+\s*[-–]\s*\d+\s*s(?:ec(?:onds)?)?\s*\)/i.test(script) ||
    /\b(HOOK|PROBLEM|SOLUTION|CTA|CALL TO ACTION|NARRATOR|VOICE ?OVER|SCENE \d)\b/.test(
      script,
    ) ||
    script.split("\n").filter((line) => line.trim()).length > 3
  );
}

/**
 * The teaser clip's visual prompt: the LLM's `videoScript` when it is genuinely a
 * short visual prompt, else a purpose-written decorative fallback — never a
 * narration script (see {@link isNarrationScript}). Deliberately NO on-screen
 * text either way: a general video model renders text illegibly (the garbled-clip
 * half of SAP-2781), so the quote lives in the typography-model graphics and the
 * teaser stays abstract. The system prompt asks the LLM for a text-free visual,
 * but the guarantee lives here — an accepted script that doesn't already forbid
 * text gets the directive appended.
 */
export function buildClipPrompt(pack: Pack): string {
  const script = pack.videoScript.trim();
  if (script && !isNarrationScript(script)) {
    return /\bno (?:on-screen )?text\b/i.test(script)
      ? script
      : `${script.replace(/[.\s]+$/, "")}. No text, no watermark.`;
  }
  return (
    `Abstract, elegant ${CLIP_SECONDS}-second social teaser: slow camera ` +
    `push-in over a deep-navy gradient with a soft light sweep and drifting ` +
    `bokeh particles, a single continuous shot, no text, no watermark.`
  );
}

/** Non-blank strings only — a blank tweet is not a tweet. */
function nonBlankStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

/**
 * Read the forced tool call back into a `Pack`.
 *
 * Every field here IS the deliverable — the tweet thread, the post, the
 * newsletter, the quotes that get rendered into graphics and emailed. So this
 * throws rather than substituting anything: an incomplete pack is a failed run,
 * and the run has to say so. The `numQuotes` check is part of that — a pack
 * short of the quotes the caller paid for is not a pack with a default in it,
 * it is a short pack.
 *
 * `videoScript` is still passed through {@link buildClipPrompt}, which replaces
 * a narration-shaped script with a purpose-written visual prompt. That is not a
 * fallback for a missing answer: it is a guard on an answer the model did give,
 * for a downstream model that renders text illegibly.
 */
export function readPack(structured: unknown, numQuotes: number): Pack {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "repurpose: the model returned no structured content pack — refusing to ship invented content.",
    );
  }
  const raw = structured as Partial<Pack>;

  const tweetThread = nonBlankStrings(raw.tweetThread).slice(0, 10);
  if (tweetThread.length === 0) {
    throw new Error(
      "repurpose: the model returned no tweet thread — refusing to ship an invented one.",
    );
  }

  const requireText = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `repurpose: the model returned no ${field} — refusing to ship invented copy.`,
      );
    }
    return value;
  };

  const rawQuotes = Array.isArray(raw.quoteGraphics) ? raw.quoteGraphics : [];
  const quoteGraphics: QuoteGraphicSpec[] = rawQuotes
    .slice(0, numQuotes)
    .map((q, i): QuoteGraphicSpec => {
      const spec = (q ?? {}) as Partial<QuoteGraphicSpec>;
      if (typeof spec.quote !== "string" || spec.quote.trim() === "") {
        throw new Error(
          `repurpose: pull-quote ${i + 1} came back empty — refusing to invent a quote from the source.`,
        );
      }
      if (
        typeof spec.imagePrompt !== "string" ||
        spec.imagePrompt.trim() === ""
      ) {
        throw new Error(
          `repurpose: pull-quote ${i + 1} came back with no art direction.`,
        );
      }
      return { quote: spec.quote, imagePrompt: spec.imagePrompt };
    });
  if (quoteGraphics.length < numQuotes) {
    throw new Error(
      `repurpose: asked for ${numQuotes} pull-quote(s), got ${quoteGraphics.length}.`,
    );
  }

  return {
    tweetThread,
    linkedInPost: requireText(raw.linkedInPost, "LinkedIn post"),
    newsletter: requireText(raw.newsletter, "newsletter section"),
    quoteGraphics,
    videoScript: requireText(raw.videoScript, "teaser clip prompt"),
  };
}

/** Render the whole pack as one markdown document for storage + email. */
function renderPackMarkdown(
  title: string,
  pack: Pack,
  graphics: Graphic[],
  clip: Clip | null,
): string {
  const thread = pack.tweetThread.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const graphicLinks = graphics
    .map(
      (g, i) =>
        `- Quote ${i + 1}: "${g.quote}"` +
        (g.downloadUrl ? ` — [graphic](${g.downloadUrl})` : ""),
    )
    .join("\n");
  const clipLink = clip?.downloadUrl
    ? `[teaser clip](${clip.downloadUrl})`
    : "_(not generated)_";
  return [
    `# Content pack: ${title}`,
    ``,
    `## Tweet thread`,
    thread,
    ``,
    `## LinkedIn post`,
    pack.linkedInPost,
    ``,
    `## Newsletter`,
    pack.newsletter,
    ``,
    `## Quote graphics`,
    graphicLinks || "_(none)_",
    ``,
    `## Teaser clip`,
    clipLink,
    ``,
  ].join("\n");
}

/** Escape the small set of characters that would break out of HTML text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the pack as a minimal HTML email so the graphics actually show in the
 * inbox — a plain-text `[graphic](url)` markdown link never renders (SAP-2781's
 * fourth finding). Graphics embed as `<img>` permalinks; the clip stays a link
 * (inline `<video>` is stripped by most mail clients). Kept deliberately small,
 * mirroring `newsletter-autopilot`'s `renderHtml`.
 */
export function renderPackHtml(
  title: string,
  pack: Pack,
  graphics: Graphic[],
  clip: Clip | null,
  packDownloadUrl: string | null,
): string {
  const section = (heading: string, body: string) =>
    `<h2 style="font-size:16px;margin:24px 0 8px;">${escapeHtml(heading)}</h2>` +
    body;
  const pre = (text: string) =>
    `<div style="white-space:pre-wrap;line-height:1.5;">${escapeHtml(text)}</div>`;
  const graphicCards = graphics
    .map((g) => {
      const caption = `<figcaption style="font-size:13px;color:#555;margin-top:4px;">“${escapeHtml(g.quote)}”</figcaption>`;
      const image = g.downloadUrl
        ? `<img src="${escapeHtml(g.downloadUrl)}" alt="${escapeHtml(g.quote)}" style="max-width:100%;border-radius:8px;" />`
        : `<em>(graphic unavailable)</em>`;
      return `<figure style="margin:0 0 16px;">${image}${caption}</figure>`;
    })
    .join("");
  const clipHtml = clip?.downloadUrl
    ? `<a href="${escapeHtml(clip.downloadUrl)}">Watch the teaser clip</a>`
    : `<em>(not generated)</em>`;
  const packLink = packDownloadUrl
    ? `<p style="margin-top:24px;"><a href="${escapeHtml(packDownloadUrl)}">Download the full pack (markdown)</a></p>`
    : "";
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;">` +
    `<h1 style="font-size:20px;margin:0 0 16px;">Content pack: ${escapeHtml(title)}</h1>` +
    section("Quote graphics", graphicCards || "<em>(none)</em>") +
    section("Teaser clip", `<p style="margin:0;">${clipHtml}</p>`) +
    section(
      "Tweet thread",
      pre(pack.tweetThread.map((t, i) => `${i + 1}. ${t}`).join("\n")),
    ) +
    section("LinkedIn post", pre(pack.linkedInPost)) +
    section("Newsletter", pre(pack.newsletter)) +
    packLink +
    `</div>`
  );
}

/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `source` stays optional so the
 * tri-state holds: omitted ⇒ repurpose the built-in sample, explicitly empty ⇒
 * a reported mistake, present ⇒ repurpose it.
 */
const entryInput = z.object({
  source: z
    .string()
    .optional()
    .describe(
      "The blog post or transcript to repurpose (raw text). Omit to use the built-in sample.",
    ),
  title: z
    .string()
    .optional()
    .describe("Optional title/topic for context in the generated copy."),
  audience: z
    .string()
    .optional()
    .describe(
      "Who the content is for; steers tone (default a general professional audience).",
    ),
  numQuotes: z
    .number()
    .default(2)
    .describe("How many quote graphics to make (clamped 1–4)."),
  deliverTo: z
    .array(z.string())
    .optional()
    .describe(
      "Recipient email address(es). Omit and the pack is returned inline instead of emailed — list more than one to fan the pack out to a distribution list.",
    ),
  schedule: z
    .string()
    .optional()
    .describe("Cron cadence this pipeline runs on (carried + reported)."),
  model: z
    .string()
    .optional()
    .describe(
      'Optional video model — a Sapiom semantic alias (e.g. "veo3-fast"). Neutral params like aspectRatio are validated against the resolved model, so a cataloged alias is required.',
    ),
  renderClip: z
    .boolean()
    .optional()
    .describe(
      "Render the teaser clip (the priciest, slowest leg). Defaults to true when you pass your own `source`, false for the built-in sample.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Generate the copy only — skip graphics, clip, upload, and email.",
    ),
});

const repurpose = defineStep({
  name: "repurpose",
  inputSchema: entryInput,
  next: ["graphics"],
  terminal: true,
  async run(input: RepurposeInput, ctx: Ctx) {
    // An omitted source runs the sample post, so a zero-input run produces a real
    // content pack. An explicitly-empty one is a mistake worth reporting, not a
    // reason to substitute our prose for the caller's.
    if (input.source !== undefined && input.source.trim().length === 0) {
      return terminate({
        status: "rejected",
        reason:
          "`source` was empty — pass the post or transcript to repurpose.",
      });
    }
    const usedSampleSource = input.source === undefined;
    const source =
      input.source === undefined ? SAMPLE_SOURCE : input.source.trim();
    if (usedSampleSource) {
      ctx.shared.set(
        "note",
        "Repurposed the built-in sample post. Pass your own `source` to repurpose yours.",
      );
    }
    const title =
      input.title?.trim() || (usedSampleSource ? SAMPLE_TITLE : "Untitled");
    const audience =
      input.audience?.trim() || "a general professional audience";
    const numQuotes = clampQuotes(input.numQuotes);
    // De-duplicate and drop blanks so a caller who pastes the same address twice, or
    // an empty string from a form, doesn't fan out a redundant or dead send.
    const deliverTo = Array.from(
      new Set(
        (input.deliverTo ?? [])
          .map((addr) => addr.trim())
          .filter((addr) => addr.length > 0),
      ),
    );

    const system = buildRepurposeSystem(audience, numQuotes);
    const prompt = `TITLE: ${title}\n\nSOURCE:\n${source}`;

    ctx.logger.info("repurposing source", {
      title,
      chars: source.length,
      numQuotes,
    });
    const res = await ctx.sapiom.llm.run({
      request: {
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1500,
      },
      output: {
        name: REPURPOSE_TOOL,
        schema: buildRepurposeSchema(numQuotes),
      },
    });
    const pack = readPack(
      ctx.sapiom.llm.structuredOf(res, REPURPOSE_TOOL),
      numQuotes,
    );

    ctx.shared.set("title", title);
    ctx.shared.set("audience", audience);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("deliverTo", deliverTo);
    ctx.shared.set("aspectRatio", ASPECT_RATIO);
    if (input.model) ctx.shared.set("model", input.model);
    // The teaser clip (video generation) is the priciest, slowest leg. A run nobody
    // configured — the built-in sample — renders the quote graphics but stops short of
    // the clip, so a zero-setup run still fires a real visual artifact without becoming
    // the most expensive one in the gallery. Supply your own `source` and the full pack
    // (clip included) renders — unless the caller explicitly said otherwise: an explicit
    // `renderClip` input always wins (SAP-2858 — it used to be silently ignored, so a
    // `renderClip: false` run still billed a clip).
    ctx.shared.set(
      "renderClip",
      resolveRenderClip(input.renderClip, usedSampleSource),
    );
    ctx.shared.set("pack", pack);
    ctx.shared.set("graphics", []);
    ctx.shared.set("graphicIndex", 0);
    ctx.shared.set("clip", null);
    ctx.shared.set("packFileId", null);
    ctx.shared.set("packDownloadUrl", null);
    ctx.logger.info("repurposed source", {
      tweets: pack.tweetThread.length,
      quotes: pack.quoteGraphics.length,
    });

    // dryRun is an explicit author opt-in — never inferred from a defaulted source —
    // to trace the graph and read the generated copy without paying for any generated
    // media. A zero-setup run (no dryRun) falls through to `graphics` and renders
    // real artwork.
    if (input.dryRun) {
      ctx.logger.info("dryRun — returning copy only");
      return terminate({
        dryRun: true,
        title,
        pack,
        note: [
          ctx.shared.get("note"),
          "No quote graphics or teaser clip were rendered, and nothing was emailed — this is the copy only. Omit `dryRun` for the full pack.",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
    return goto("graphics", {});
  },
});

const graphics = defineStep({
  name: "graphics",
  next: [],
  // Async pause/resume, one quote at a time: `images.launch` submits and returns a
  // handle immediately, and the image-generation webhook fires IMAGE_RESULT_SIGNAL on
  // completion, resuming `collectGraphic` with that quote's result. Launching every
  // quote's job up front and then draining would risk one finishing before we've
  // paused on it (its resume signal would have nowhere to land) — see the module doc.
  pause: { signal: IMAGE_RESULT_SIGNAL, resumeStep: "collectGraphic" },
  async run(_input: unknown, ctx: Ctx) {
    const pack = must(ctx.shared.get("pack"), "pack");
    const index = must(ctx.shared.get("graphicIndex"), "graphicIndex");
    const quote = pack.quoteGraphics[index];

    ctx.logger.info("generating quote graphic", {
      index: index + 1,
      of: pack.quoteGraphics.length,
    });
    const handle = await ctx.sapiom.contentGeneration.images.launch({
      // Composed in code so the quote text is ALWAYS rendered into the graphic —
      // the LLM's imagePrompt is art direction only (see buildGraphicPrompt).
      prompt: buildGraphicPrompt(quote),
      // Typography-capable cataloged alias — the default fast model can't render
      // legible quote text.
      model: IMAGE_MODEL,
      // Neutral param (E4): validated against the resolved model and mapped to its
      // wire key server-side; keeps the graphics consistent with the 16:9 clip.
      aspectRatio: must(ctx.shared.get("aspectRatio"), "aspectRatio"),
      count: 1,
      // Public: quote graphics are embedded in the emailed pack below, so they
      // need a durable permalink rather than a presigned URL that expires in ~15min.
      storage: { visibility: "public" },
    });
    return await pauseUntilSignal(handle, { resumeStep: "collectGraphic" });
  },
});

const collectGraphic = defineStep({
  name: "collectGraphic",
  next: ["graphics", "clip", "package"],
  async run(result: ImageResultPayload, ctx: Ctx) {
    const pack = must(ctx.shared.get("pack"), "pack");
    const graphicsSoFar = must(ctx.shared.get("graphics"), "graphics");
    const index = must(ctx.shared.get("graphicIndex"), "graphicIndex");
    const quote = pack.quoteGraphics[index];

    const img = result.outputs?.[0];
    if (!img?.fileId && !img?.downloadUrl) {
      const storageError = img?.storageError ? `: ${img.storageError}` : "";
      throw new Error(
        `quote graphic generation completed without a usable output for quote ${index + 1}${storageError}`,
      );
    }
    const graphic: Graphic = {
      quote: quote.quote,
      ...(img.fileId !== undefined && { fileId: img.fileId }),
      ...(img.fileId !== undefined
        ? { downloadUrl: fileStorage.getPublicUrl(img.fileId) }
        : img.downloadUrl !== undefined
          ? { downloadUrl: img.downloadUrl }
          : {}),
    };
    const nextGraphics = [...graphicsSoFar, graphic];
    const nextIndex = index + 1;
    ctx.shared.set("graphics", nextGraphics);
    ctx.shared.set("graphicIndex", nextIndex);
    ctx.logger.info("collected quote graphic", {
      collected: nextGraphics.length,
      of: pack.quoteGraphics.length,
    });

    // More quotes need a graphic? Loop back. Otherwise every graphic is in — the
    // built-in sample run stops here (a real visual artifact) and skips the pricey
    // teaser clip; a caller-supplied source renders the full pack.
    if (nextIndex < pack.quoteGraphics.length) {
      return goto("graphics", {});
    }
    const renderClip = ctx.shared.get("renderClip") ?? true;
    return renderClip ? goto("clip", {}) : goto("package", {});
  },
});

const clip = defineStep({
  name: "clip",
  next: [],
  // Async pause/resume: the launched video job fires VIDEO_RESULT_SIGNAL on
  // completion (the video-generation webhook), resuming `collectClip` with the clip's result.
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "collectClip" },
  async run(_input: unknown, ctx: Ctx) {
    const pack = must(ctx.shared.get("pack"), "pack");
    const model = ctx.shared.get("model") ?? DEFAULT_VIDEO_MODEL;
    const prompt = buildClipPrompt(pack);

    ctx.logger.info("rendering teaser clip", { model });
    // A short decorative text-to-video teaser. The prompt is a purpose-written
    // single-shot visual with no on-screen text (buildClipPrompt) — never the
    // narration script — and the model a CATALOGED semantic alias, so the neutral
    // params below are validated against its capabilities and mapped to its wire
    // keys server-side (E4). The previous raw `fal-ai/kling-video/v2.1/pro/…` pin
    // got no normalization and will be rejected outright once the allowlist
    // (SAP-2582/E8) closes.
    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model,
      prompt,
      aspectRatio: must(ctx.shared.get("aspectRatio"), "aspectRatio"),
      // Pin the teaser length only on the default alias (5s is in its catalog
      // vocabulary). Duration vocabularies differ per model and an unsupported
      // value is rejected `400 unsupported_param` (never silently dropped), so a
      // caller-supplied alias keeps its own catalog default instead.
      ...(model === DEFAULT_VIDEO_MODEL && { duration: CLIP_SECONDS }),
      // Public: the teaser clip is linked from the emailed pack below, so it
      // needs a durable permalink rather than a presigned URL that expires in ~15min.
      storage: { visibility: "public" },
    });
    return await pauseUntilSignal(handle, { resumeStep: "collectClip" });
  },
});

const collectClip = defineStep({
  name: "collectClip",
  next: ["package"],
  async run(result: VideoResultPayload, ctx: Ctx) {
    const out = result.outputs?.[0];
    const value: Clip = {
      ...(out?.fileId !== undefined && { fileId: out.fileId }),
      ...(out?.fileId !== undefined
        ? { downloadUrl: fileStorage.getPublicUrl(out.fileId) }
        : out?.downloadUrl !== undefined
          ? { downloadUrl: out.downloadUrl }
          : {}),
    };
    ctx.shared.set("clip", value);
    ctx.logger.info("collected teaser clip", {
      hasVideo: Boolean(out?.fileId),
    });
    return goto("package", {});
  },
});

const packageStep = defineStep({
  name: "package",
  next: ["deliver"],
  async run(_input: unknown, ctx: Ctx) {
    const title = must(ctx.shared.get("title"), "title");
    const pack = must(ctx.shared.get("pack"), "pack");
    const graphicsList = must(ctx.shared.get("graphics"), "graphics");
    const value = must(ctx.shared.get("clip"), "clip");

    // `contentGeneration.images` returns only a `fileId` (with a
    // `downloadUrlUnavailable` signal), so a graphic's usable URL must be minted
    // from its fileId here — the same resolution the `clip` step already does.
    // Without this, a run that skips the clip (renderClip=false) packages and
    // delivers null graphic links yet still reports success. `getPublicUrl` is
    // pure/synchronous (no network call, so nothing to catch here), and durable —
    // the graphics are stored public and this link is emailed below.
    for (const g of graphicsList) {
      if (!g.downloadUrl && g.fileId) {
        g.downloadUrl = fileStorage.getPublicUrl(g.fileId);
      }
    }
    ctx.shared.set("graphics", graphicsList);

    const markdown = renderPackMarkdown(title, pack, graphicsList, value);
    const bytes = Buffer.from(markdown, "utf8");
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "untitled";

    // Upload the assembled pack to file storage for a durable copy: `upload` hands
    // back a presigned PUT URL, we transfer the bytes ourselves, then mint a
    // download URL to link from the email. Best-effort — the full pack also ships
    // inline in the email body, so a storage hiccup degrades to "no durable link"
    // rather than failing the run.
    try {
      const { fileId, uploadUrl, requiredHeaders } =
        await ctx.sapiom.fileStorage.upload({
          contentType: "text/markdown",
          fileName: `content-pack-${slug}.md`,
          fileSize: bytes.byteLength,
          // Public: the pack's link is emailed below, so it needs a durable
          // permalink rather than a presigned URL that expires in ~15min.
          visibility: "public",
        });
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: requiredHeaders,
        body: bytes,
      });
      if (!putRes.ok) {
        throw new Error(`PUT ${putRes.status} ${putRes.statusText}`);
      }
      const downloadUrl = fileStorage.getPublicUrl(fileId);
      ctx.shared.set("packFileId", fileId);
      ctx.shared.set("packDownloadUrl", downloadUrl);
      ctx.logger.info("packaged content pack", {
        fileId,
        bytes: bytes.byteLength,
      });
    } catch (err) {
      ctx.logger.warn("pack upload failed; delivering inline only", {
        err: String(err),
      });
    }
    return goto("deliver", { markdown });
  },
});

/**
 * Reuse an existing inbox to send from, else provision one.
 *
 * We deliberately omit `username`. AgentMail addresses are globally unique, so a
 * fixed local part can only ever be owned by ONE account across the whole
 * platform — every other tenant's `create` 409s with "Email address is already
 * taken", which fails the step. Omitting it lets AgentMail auto-generate a
 * globally-unique address, so a fresh tenant's first run succeeds and two
 * tenants never collide. `create` still isn't atomic against the `list`, so a
 * 409 is treated as "someone already provisioned one" — re-list and reuse.
 */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  try {
    const inbox = await ctx.sapiom.email.inboxes.create({
      displayName: "Content Pack",
    });
    return inbox.inboxId;
  } catch (err) {
    if (err instanceof EmailHttpError && err.status === 409) {
      const retry = await ctx.sapiom.email.inboxes.list({ limit: 1 });
      if (retry.inboxes.length > 0) return retry.inboxes[0].inboxId;
    }
    throw err;
  }
}

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(input: { markdown: string }, ctx: Ctx) {
    const title = must(ctx.shared.get("title"), "title");
    const schedule = must(ctx.shared.get("schedule"), "schedule");
    const pack = must(ctx.shared.get("pack"), "pack");
    const graphicsList = must(ctx.shared.get("graphics"), "graphics");
    const value = must(ctx.shared.get("clip"), "clip");
    const packFileId = ctx.shared.get("packFileId") ?? null;
    const packDownloadUrl = ctx.shared.get("packDownloadUrl") ?? null;
    const markdown = input.markdown ?? "";
    const subject = `Content pack: ${title}`;
    const note = ctx.shared.get("note");

    const summary = {
      title,
      schedule,
      channels: {
        tweets: pack.tweetThread.length,
        linkedIn: Boolean(pack.linkedInPost),
        newsletter: Boolean(pack.newsletter),
        graphics: graphicsList.length,
        clip: Boolean(value?.fileId),
      },
      // The rendered quote graphics, surfaced so the run's terminal carries a real,
      // inspectable visual artifact (real links) even when nothing is emailed.
      graphics: graphicsList.map((g) => ({
        quote: g.quote,
        downloadUrl: g.downloadUrl ?? null,
      })),
      packFileId,
      packDownloadUrl,
      clipFileId: value?.fileId ?? null,
    };

    // Recipients are ordinary configuration, so they arrive as run input (declared
    // as a `deliverTo` setting in template.json) rather than from a write-only
    // secret store nothing in the product can populate.
    const recipients = must(ctx.shared.get("deliverTo"), "deliverTo");

    // The safe path: no recipients configured yet returns the pack without sending.
    if (recipients.length === 0) {
      ctx.logger.info("skipping delivery — no recipients", {});
      return terminate({
        ...summary,
        rendered: graphicsList.length,
        delivered: 0,
        recipients: [],
        unmet: ["deliverTo"],
        note: [
          "Nothing was emailed: no `deliverTo` recipient is set — the rendered quote graphics and the full pack are returned inline below.",
          note,
        ]
          .filter(Boolean)
          .join(" "),
        subject,
        markdown,
      });
    }

    // FAN-OUT: the map-reduce delivery loop absorbed from
    // `personalized-media-at-scale` — map over every recipient, send each
    // independently, then reduce into one delivered/skipped summary. A bad or
    // reserved address degrades that one recipient rather than sinking the batch.
    const inboxId = await resolveSenderInbox(ctx);
    // HTML body so the graphics render in the inbox (a plain-text markdown link
    // never does); the markdown stays as the text/plain fallback.
    const html = renderPackHtml(
      title,
      pack,
      graphicsList,
      value,
      packDownloadUrl,
    );
    const results: { to: string; messageId?: string; skipped?: string }[] = [];
    for (const to of recipients) {
      if (isReservedAddress(to)) {
        results.push({ to, skipped: "reserved-address" });
        continue;
      }
      try {
        const sent = await ctx.sapiom.email.messages.send(inboxId, {
          to,
          subject,
          text: markdown,
          html,
        });
        results.push({ to, messageId: sent.messageId });
      } catch (err) {
        ctx.logger.warn("email failed for recipient", {
          to,
          err: String(err),
        });
        results.push({ to });
      }
    }
    const delivered = results.filter((r) => r.messageId).length;
    const skipped = results.length - delivered;
    ctx.logger.info("content pack delivered", {
      recipients: recipients.length,
      delivered,
    });
    return terminate({
      ...summary,
      rendered: graphicsList.length,
      delivered,
      recipients: results,
      note:
        [
          skipped > 0
            ? `${delivered} of ${results.length} recipient(s) were delivered; the rest were skipped (a reserved placeholder address or a failed send).`
            : null,
          note,
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    });
  },
});

export const agent = defineAgent<RepurposeInput, Shared>({
  name: "content-repurposing-pipeline",
  entry: "repurpose",
  steps: {
    repurpose,
    graphics,
    collectGraphic,
    clip,
    collectClip,
    package: packageStep,
    deliver,
  },
});
