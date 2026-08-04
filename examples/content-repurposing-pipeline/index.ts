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
 *   (models.run) (images.launch)  (drain)     (video.launch) (drain) (fileStorage) (email.send × N)
 *
 *   1. repurpose — an LLM (`ctx.sapiom.models.run`) rewrites the source into every
 *      channel at once: the tweet thread, the LinkedIn post, the newsletter, the
 *      pull-quotes to render as graphics, and a short video script.
 *   2. graphics — launch an async quote-graphic image job (`images.launch`) for the
 *      next pull-quote and `pauseUntilSignal` on it; the image-generation webhook
 *      resumes `collectGraphic` when it's ready.
 *   3. collectGraphic — record the finished graphic, then loop back to `graphics`
 *      for the next quote, or advance once every quote graphic is in.
 *   4. clip — animate the first quote graphic into a short teaser clip: launch an
 *      async image-to-video job (`video.launch`) and `pauseUntilSignal` on it; the
 *      video-generation webhook resumes `collectClip` when the clip is ready.
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

/** One pull-quote plus the prompt used to render it as a graphic. */
interface QuoteGraphicSpec {
  /** The short, punchy line pulled from the source. */
  quote: string;
  /** Full image prompt for the graphic that frames {@link quote}. */
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
  /** Motion/narration prompt for a short teaser clip. */
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
  /** Optional image-to-video model id (advanced), passed through verbatim to `video.launch`. */
  model?: string;
  /** When true, generate the copy only — skip graphics, clip, upload, and email. */
  dryRun?: boolean;
}

interface Shared extends Record<string, unknown> {
  title: string;
  audience: string;
  schedule: string;
  deliverTo: string[];
  aspectRatio: string;
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
 * Default image-to-video model, chosen for quality; swap for a budget model via the
 * `model` input. Model ids are an advanced, evolving surface passed through verbatim.
 */
const DEFAULT_VIDEO_MODEL = "fal-ai/kling-video/v2.1/pro/image-to-video";
/** Aspect ratio for the graphics + teaser clip. */
const ASPECT_RATIO = "16:9";
/** Teaser clip length in seconds — image-to-video models animate short clips best. */
const CLIP_SECONDS = 5;
/** Default cadence when the caller doesn't pass one: 09:00 every Monday. */
const DEFAULT_SCHEDULE = "0 9 * * 1";
/** Fan-out bounds on the pull-quote list. */
const DEFAULT_NUM_QUOTES = 2;
const MAX_QUOTES = 4;
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "content-repurposing";

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

/** Resolve a single graphic's usable URL, re-minting from `fileId` when needed. */
async function resolveGraphicUrl(
  graphic: Graphic,
  getDownloadUrl: (fileId: string) => Promise<{ downloadUrl: string }>,
): Promise<string> {
  if (graphic.downloadUrl) return graphic.downloadUrl;
  if (graphic.fileId) return (await getDownloadUrl(graphic.fileId)).downloadUrl;
  throw new Error("quote graphic has no usable download URL");
}

/**
 * Parse the LLM's minified-JSON pack defensively. A model may wrap the JSON in prose
 * or fences, so we slice to the outermost object before parsing and fall back to a
 * usable pack built from the source when anything is off — the pipeline still runs
 * end to end rather than failing on a malformed reply. Mirrors `scene-to-video`'s
 * `parsePlan`.
 */
function parsePack(
  output: string | null,
  source: string,
  title: string,
  numQuotes: number,
): Pack {
  const lead = source.trim().slice(0, 240);
  const fallbackQuote = lead.slice(0, 120);
  const fallback: Pack = {
    tweetThread: [
      `${title}: a quick thread. 🧵`,
      lead,
      "More in the full post.",
    ],
    linkedInPost: `${title}\n\n${lead}`,
    newsletter: `## ${title}\n\n${lead}`,
    quoteGraphics: Array.from({ length: numQuotes }, (_, i) => ({
      quote: fallbackQuote || title,
      imagePrompt: `A clean, modern quote graphic on a solid background, 16:9, no watermark. Quote ${i + 1}: "${fallbackQuote || title}". Large legible sans-serif type, generous margins.`,
    })),
    videoScript: `A short, upbeat teaser for "${title}"; slow push-in on the key quote; ${CLIP_SECONDS}s; bright, clean, social-ready.`,
  };
  if (!output) return fallback;
  try {
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    const raw = JSON.parse(json) as Partial<Pack>;

    const tweetThread =
      Array.isArray(raw.tweetThread) &&
      raw.tweetThread.every((t) => typeof t === "string")
        ? raw.tweetThread.filter((t) => t.trim()).slice(0, 10)
        : fallback.tweetThread;

    const rawQuotes = Array.isArray(raw.quoteGraphics) ? raw.quoteGraphics : [];
    const quoteGraphics: QuoteGraphicSpec[] = rawQuotes
      .slice(0, numQuotes)
      .map((q, i): QuoteGraphicSpec => {
        const spec = (q ?? {}) as Partial<QuoteGraphicSpec>;
        const dflt =
          fallback.quoteGraphics[
            Math.min(i, fallback.quoteGraphics.length - 1)
          ];
        return {
          quote:
            typeof spec.quote === "string" && spec.quote.trim()
              ? spec.quote
              : dflt.quote,
          imagePrompt:
            typeof spec.imagePrompt === "string" && spec.imagePrompt.trim()
              ? spec.imagePrompt
              : dflt.imagePrompt,
        };
      });

    return {
      tweetThread: tweetThread.length > 0 ? tweetThread : fallback.tweetThread,
      linkedInPost:
        typeof raw.linkedInPost === "string" && raw.linkedInPost.trim()
          ? raw.linkedInPost
          : fallback.linkedInPost,
      newsletter:
        typeof raw.newsletter === "string" && raw.newsletter.trim()
          ? raw.newsletter
          : fallback.newsletter,
      quoteGraphics:
        quoteGraphics.length > 0 ? quoteGraphics : fallback.quoteGraphics,
      videoScript:
        typeof raw.videoScript === "string" && raw.videoScript.trim()
          ? raw.videoScript
          : fallback.videoScript,
    };
  } catch {
    return fallback;
  }
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
      "Optional image-to-video model id, passed through to video.launch.",
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

    const system =
      "You are a content strategist repurposing one long-form SOURCE (a blog post " +
      "or transcript) into a multi-channel content pack for " +
      `${audience}. Keep the author's meaning; do not invent facts. ` +
      `Write ${numQuotes} short, punchy pull-quote(s), each with an image prompt ` +
      "for a clean quote graphic. Tweets must each be <= 280 characters. " +
      "Reply with ONLY minified JSON: " +
      '{"tweetThread":string[],"linkedInPost":string,"newsletter":string,' +
      '"quoteGraphics":[{"quote":string,"imagePrompt":string}],"videoScript":string}.';
    const prompt = `TITLE: ${title}\n\nSOURCE:\n${source}`;

    ctx.logger.info("repurposing source", {
      title,
      chars: source.length,
      numQuotes,
    });
    const res = await ctx.sapiom.models.run({
      prompt,
      system,
      maxTokens: 1500,
    });
    const pack = parsePack(res.output, source, title, numQuotes);

    ctx.shared.set("title", title);
    ctx.shared.set("audience", audience);
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set("deliverTo", deliverTo);
    ctx.shared.set("aspectRatio", ASPECT_RATIO);
    if (input.model) ctx.shared.set("model", input.model);
    // The teaser clip (image-to-video) is the priciest, slowest leg. A run nobody
    // configured — the built-in sample — renders the quote graphics but stops short of
    // the clip, so a zero-setup run still fires a real visual artifact without becoming
    // the most expensive one in the gallery. Supply your own `source` and the full pack
    // (clip included) renders.
    ctx.shared.set("renderClip", !usedSampleSource);
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
      prompt: quote.imagePrompt,
      numImages: 1,
      storage: { visibility: "private" },
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
      ...(img.downloadUrl !== undefined && { downloadUrl: img.downloadUrl }),
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
    const graphicsList = must(ctx.shared.get("graphics"), "graphics");
    const frame = graphicsList[0];
    const imageUrl = await resolveGraphicUrl(frame, async (fileId) => {
      return await ctx.sapiom.fileStorage.getDownloadUrl(fileId);
    });
    const model = ctx.shared.get("model") ?? DEFAULT_VIDEO_MODEL;

    ctx.logger.info("animating teaser clip", { from: frame.quote });
    // Animate the first quote graphic into a short teaser. A fixed seed + the
    // shared aspect ratio keep it consistent with the graphics.
    const handle = await ctx.sapiom.contentGeneration.video.launch({
      model,
      prompt: pack.videoScript,
      params: {
        image_url: imageUrl,
        duration: CLIP_SECONDS,
        aspect_ratio: must(ctx.shared.get("aspectRatio"), "aspectRatio"),
        seed: 42,
      },
      storage: { visibility: "private" },
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
      ...(out?.downloadUrl !== undefined && { downloadUrl: out.downloadUrl }),
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
    // delivers null graphic links yet still reports success. Best-effort: a mint
    // hiccup drops that one link rather than failing the run (the pack ships inline).
    for (const g of graphicsList) {
      if (!g.downloadUrl && g.fileId) {
        try {
          g.downloadUrl = (
            await ctx.sapiom.fileStorage.getDownloadUrl(g.fileId)
          ).downloadUrl;
        } catch (err) {
          ctx.logger.warn("quote graphic download URL mint failed", {
            fileId: g.fileId,
            err: String(err),
          });
        }
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
          visibility: "private",
        });
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: requiredHeaders,
        body: bytes,
      });
      if (!putRes.ok) {
        throw new Error(`PUT ${putRes.status} ${putRes.statusText}`);
      }
      const { downloadUrl } =
        await ctx.sapiom.fileStorage.getDownloadUrl(fileId);
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

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Content Pack",
  });
  return inbox.inboxId;
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
