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
 * Content Repurposing Pipeline — one long-form source into a multi-channel pack.
 *
 * Feed it a blog post or a transcript and it fans that single source out into a
 * tweet thread, a LinkedIn post, a newsletter, quote graphics, and a short video
 * clip — then packages the lot into one markdown brief and emails it to you. It
 * ships with a `schedule` input so it reads as a standing "repurpose the latest
 * post" agent you point at a cron cadence, not just a one-shot.
 *
 *   repurpose ─▶ graphics ─▶ clip ─▶ collectClip ─▶ package ─▶ deliver
 *   (models.run) (images.create) (video.launch) (drain)  (fileStorage) (email.send)
 *
 *   1. repurpose — an LLM (`ctx.sapiom.models.run`) rewrites the source into every
 *      channel at once: the tweet thread, the LinkedIn post, the newsletter, the
 *      pull-quotes to render as graphics, and a short video script.
 *   2. graphics — one quote-graphic image per pull-quote (`images.create`), fanned
 *      out in-process, each persisted for a durable `fileId`.
 *   3. clip — animate the first quote graphic into a short teaser clip: launch an
 *      async image-to-video job (`video.launch`) and `pauseUntilSignal` on it; the
 *      FAL webhook resumes `collectClip` when the clip is ready.
 *   4. collectClip — record the finished clip.
 *   5. package — assemble the whole pack as one markdown document and upload it to
 *      file storage (`fileStorage.upload`) for a durable `fileId` + download URL.
 *   6. deliver — email the pack to your recipient (`email.messages.send`); terminal.
 *
 * A `dryRun` guard short-circuits after `repurpose` so authors can trace the graph
 * and read the generated copy without paying for the (pricier) image + video steps.
 * A run with no recipient configured skips the send and returns the pack instead.
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

/** A generated quote graphic, carried forward to `clip` and into the pack. */
interface Graphic {
  quote: string;
  fileId?: string;
  url: string;
  downloadUrl?: string;
}

/** The finished teaser clip, as recorded by `collectClip`. */
interface Clip {
  fileId?: string;
  downloadUrl?: string;
}

/** Trigger input. Only `source` is required. */
interface RepurposeInput {
  /** The blog post or transcript to repurpose (raw text). */
  source: string;
  /** Optional title/topic for context in the generated copy. */
  title?: string;
  /** Who the content is for; steers tone (default a general professional audience). */
  audience?: string;
  /** How many quote graphics to make (default 2, clamped 1–4). */
  numQuotes?: number;
  /** Recipient email; falls back to the vault-configured default when omitted. */
  deliverTo?: string;
  /** Cron cadence this pipeline is meant to run on (carried + reported). */
  schedule?: string;
  /** Optional FAL image-to-video model id, passed through verbatim to `video.launch`. */
  model?: string;
  /** When true, generate the copy only — skip graphics, clip, upload, and email. */
  dryRun?: boolean;
}

interface Shared extends Record<string, unknown> {
  title: string;
  audience: string;
  schedule: string;
  deliverTo: string | null;
  aspectRatio: string;
  model?: string;
  pack: Pack;
  graphics: Graphic[];
  clip: Clip | null;
  packFileId: string | null;
  packDownloadUrl: string | null;
}

type Ctx = AgentExecutionContext<Shared>;

/**
 * Default FAL image-to-video model. Kling 2.1 Pro is chosen for quality; swap for a
 * budget model (Wan i2v, Seedance i2v) via the `model` input.
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
/** Vault ref holding delivery config (e.g. a default RECIPIENT). Read at runtime. */
const DELIVERY_VAULT_REF = "content-repurposing-pipeline";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "content-repurposing";

function clampQuotes(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_NUM_QUOTES;
  return Math.max(1, Math.min(MAX_QUOTES, Math.floor(n)));
}

function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
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

const repurpose = defineStep({
  name: "repurpose",
  next: ["graphics"],
  terminal: true,
  async run(input: RepurposeInput, ctx: Ctx) {
    const source = input.source?.trim();
    if (!source) throw new Error("`source` is required");
    const title = input.title?.trim() || "Untitled";
    const audience =
      input.audience?.trim() || "a general professional audience";
    const numQuotes = clampQuotes(input.numQuotes);

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
    ctx.shared.set("deliverTo", input.deliverTo?.trim() || null);
    ctx.shared.set("aspectRatio", ASPECT_RATIO);
    if (input.model) ctx.shared.set("model", input.model);
    ctx.shared.set("pack", pack);
    ctx.shared.set("graphics", []);
    ctx.shared.set("clip", null);
    ctx.shared.set("packFileId", null);
    ctx.shared.set("packDownloadUrl", null);
    ctx.logger.info("repurposed source", {
      tweets: pack.tweetThread.length,
      quotes: pack.quoteGraphics.length,
    });

    // dryRun: trace the graph and read the copy without paying for graphics/clip.
    if (input.dryRun) {
      ctx.logger.info("dryRun — returning copy only");
      return terminate({ dryRun: true, title, pack });
    }
    return goto("graphics", {});
  },
});

const graphics = defineStep({
  name: "graphics",
  next: ["clip"],
  async run(_input: unknown, ctx: Ctx) {
    const pack = must(ctx.shared.get("pack"), "pack");
    ctx.logger.info("generating quote graphics", {
      count: pack.quoteGraphics.length,
    });

    // Fan-out: one graphic per pull-quote, generated concurrently. `storage`
    // persists each output so we get a durable `fileId` + a ready-to-use URL to
    // hand the clip step as its start frame and to link from the pack.
    const generated = await Promise.all(
      pack.quoteGraphics.map((q) =>
        ctx.sapiom.contentGeneration.images.create({
          prompt: q.imagePrompt,
          numImages: 1,
          storage: { visibility: "private" },
        }),
      ),
    );
    const results: Graphic[] = generated.map((result, i) => {
      const img = result.images?.[0];
      if (!img) throw new Error(`no graphic returned for quote ${i + 1}`);
      return {
        quote: pack.quoteGraphics[i].quote,
        ...(img.fileId !== undefined && { fileId: img.fileId }),
        url: img.url,
        ...(img.downloadUrl !== undefined && { downloadUrl: img.downloadUrl }),
      };
    });
    ctx.shared.set("graphics", results);
    ctx.logger.info("graphics ready", { count: results.length });
    return goto("clip", {});
  },
});

const clip = defineStep({
  name: "clip",
  next: [],
  // Async pause/resume: the launched video job fires VIDEO_RESULT_SIGNAL on
  // completion (the FAL webhook), resuming `collectClip` with the clip's result.
  pause: { signal: VIDEO_RESULT_SIGNAL, resumeStep: "collectClip" },
  async run(_input: unknown, ctx: Ctx) {
    const pack = must(ctx.shared.get("pack"), "pack");
    const graphicsList = must(ctx.shared.get("graphics"), "graphics");
    const frame = graphicsList[0];
    const imageUrl = frame.downloadUrl ?? frame.url;
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

/**
 * Resolve the recipient from the vault at runtime. A missing ref/key is an expected
 * outcome (`vault.get` returns null), not an error — the caller falls back to
 * returning the pack without sending.
 */
async function recipientFromVault(ctx: Ctx): Promise<string | null> {
  try {
    return await ctx.sapiom.vault.get(DELIVERY_VAULT_REF, "RECIPIENT");
  } catch (err) {
    ctx.logger.warn("vault: no recipient configured", { err: String(err) });
    return null;
  }
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Content Repurposing",
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
      packFileId,
      packDownloadUrl,
      clipFileId: value?.fileId ?? null,
    };

    // Explicit input wins; otherwise resolve the default from the vault at runtime
    // (never carried through state).
    const deliverTo =
      ctx.shared.get("deliverTo") || (await recipientFromVault(ctx));

    // The safe path: no recipient configured yet returns the pack without sending.
    if (!deliverTo) {
      ctx.logger.info("skipping delivery — no recipient", {});
      return terminate({
        ...summary,
        delivered: false,
        reason: "no-recipient",
        to: null,
        subject,
        markdown,
      });
    }

    const inboxId = await resolveSenderInbox(ctx);
    const sent = await ctx.sapiom.email.messages.send(inboxId, {
      to: deliverTo,
      subject,
      text: markdown,
    });
    ctx.logger.info("content pack delivered", {
      to: deliverTo,
      messageId: sent.messageId,
    });
    return terminate({
      ...summary,
      delivered: true,
      to: deliverTo,
      subject,
      messageId: sent.messageId,
    });
  },
});

export const agent = defineAgent<RepurposeInput, Shared>({
  name: "content-repurposing-pipeline",
  entry: "repurpose",
  steps: {
    repurpose,
    graphics,
    clip,
    collectClip,
    package: packageStep,
    deliver,
  },
});
