import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

/**
 * Newsletter Autopilot — a standing, self-writing newsletter.
 *
 * On each tick (built to run weekly) it searches a `niche`, scrapes the top
 * results for full text, asks an LLM (`ctx.sapiom.models.run` — the live
 * x402-served model, NOT a hardcoded formatter) to curate and WRITE the issue,
 * generates a header image for it, and emails the finished issue to a subscriber
 * list.
 *
 * Composition, in one legible graph:
 *   search    →   scrape    →   write      →   header               →   deliver
 *  (web.search)  (web.scrape)  (models.run)  (contentGeneration.images)  (email)
 *
 * vs. `scheduled-research-brief`: fork THAT for a private, one-recipient brief
 * (search → scrape → curate → email). Fork THIS when the deliverable is a
 * published-feeling newsletter — an LLM writes the issue with a subject line and
 * an image prompt, a header image is generated, and it goes out to a whole list.
 *
 * Side-effect discipline (copied from `scheduled-research-brief`):
 *   - `dryRun` gates the real send: it still searches, writes, and generates the
 *     header image, then returns the finished issue as a preview WITHOUT emailing
 *     anyone. `run_local` uses this to trace the whole graph offline (capabilities
 *     stubbed) for free before a billed, delivering deploy + run.
 *   - The subscriber list falls back to the Sapiom vault at runtime and is never
 *     baked into the code — the same seam you'd read any delivery config from.
 *   - The header image is best-effort: if generation returns nothing (e.g. a
 *     stubbed `run_local`), the issue still goes out without it rather than
 *     aborting the run.
 *   - Each edge carries a slim payload; the large scraped bodies stay bounded and
 *     die at the `write` boundary — they never enter `ctx.shared` (big shared
 *     state stalls transitions, per the `backlog-nudge` boundary lesson).
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Default cadence when the caller doesn't pass one: 08:00 every Monday. */
const DEFAULT_SCHEDULE = "0 8 * * 1";
/** Default masthead when the caller doesn't name the newsletter. */
const DEFAULT_NEWSLETTER_NAME = "Weekly Autopilot";
/** How many search hits to consider as scrape candidates. */
const MAX_CANDIDATES = 6;
/** How many candidates to actually scrape (keeps latency + cost bounded). */
const MAX_SCRAPES = 4;
/** Truncate each scraped body — the ONLY large data on the search→write path. */
const MAX_BODY_CHARS = 1200;
/** Cap the fan-out of per-subscriber sends (keeps a run's cost bounded). */
const MAX_RECIPIENTS = 50;
/** Vault ref holding delivery config (a default SUBSCRIBERS list). Read at runtime. */
const DELIVERY_VAULT_REF = "newsletter-autopilot";
/** Username for the inbox we send from (created once, then reused). */
const SENDER_USERNAME = "newsletter";

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** The niche / topic to research and write about on each tick. */
  niche: string;
  /** Masthead shown in the subject and header (defaults to a generic name). */
  newsletterName?: string;
  /** Cron cadence this newsletter is meant to run on (default weekly Monday 08:00). */
  schedule?: string;
  /** Subscriber emails; falls back to the vault-configured list when omitted. */
  subscribers?: string[];
  /** Write + render the issue but skip the real send. `run_local` passes this. */
  dryRun?: boolean;
}

/** Slim search hit carried across the search → scrape boundary. */
interface Candidate {
  title: string;
  url: string;
  snippet: string;
}

/** A candidate plus its (bounded) scraped body — the scrape → write payload. */
interface ScrapedSource extends Candidate {
  /** Extracted article text (markdown, truncated); absent when scraping failed. */
  content?: string;
}

/** The slim source reference that crosses write → deliver and lands in output. */
interface Source {
  title: string;
  url: string;
}

/** The LLM's written issue: a subject, a markdown body, and a header image prompt. */
interface Issue {
  subject: string;
  body: string;
  imagePrompt: string;
}

interface Shared extends Record<string, unknown> {
  niche: string;
  newsletterName: string;
  schedule: string;
  subscribers: string[];
  dryRun: boolean;
  subject: string;
  body: string;
  imagePrompt: string;
  headerImageUrl: string | null;
  headerImageFileId: string | null;
  sources: Source[];
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
/**
 * Resolve the subscriber list from the vault at runtime. The stored value is a
 * comma- or newline-separated list of emails. A missing ref/key is an expected
 * outcome (`vault.get` returns null), not an error — the caller then falls back
 * to a dry-run preview. Never persisted in execution state.
 */
async function subscribersFromVault(ctx: Ctx): Promise<string[]> {
  try {
    const raw = await ctx.sapiom.vault.get(DELIVERY_VAULT_REF, "SUBSCRIBERS");
    return parseRecipients(raw);
  } catch (err) {
    ctx.logger.warn("vault: no subscriber list configured", {
      err: String(err),
    });
    return [];
  }
}

/** Split a raw address list (commas or newlines) into de-duped, trimmed emails. */
function parseRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const email = part.trim();
    if (email && email.includes("@")) seen.add(email);
  }
  return [...seen];
}

/** Reuse an existing inbox to send from, else provision one. */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  const inbox = await ctx.sapiom.email.inboxes.create({
    username: SENDER_USERNAME,
    displayName: "Newsletter Autopilot",
  });
  return inbox.inboxId;
}

/**
 * Parse the LLM's minified-JSON issue defensively. A model may wrap the JSON in
 * prose or fences, so we slice to the outermost object before parsing and fall
 * back to a plain issue built from the sources when anything is off — the
 * newsletter still goes out rather than failing on a malformed reply. Mirrors
 * `scene-to-video`'s `parsePlan`.
 */
function parseIssue(
  output: string | null,
  niche: string,
  newsletterName: string,
  sources: Source[],
): Issue {
  const fallbackSubject = `${newsletterName}: ${niche || "this week"}`;
  const fallbackBody =
    `# ${fallbackSubject}\n\n` +
    (sources.length > 0
      ? `This week in ${niche}:\n\n` +
        sources.map((s) => `- [${s.title}](${s.url})`).join("\n")
      : `_No sources were found for this topic this week._`);
  const fallback: Issue = {
    subject: fallbackSubject,
    body: fallbackBody,
    imagePrompt:
      `Editorial header illustration for a newsletter about ${niche || newsletterName}. ` +
      `Clean, modern, magazine cover style. No text.`,
  };
  if (!output) return fallback;
  try {
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    const raw = JSON.parse(json) as Partial<Issue>;
    return {
      subject:
        typeof raw.subject === "string" && raw.subject.trim()
          ? raw.subject.trim()
          : fallback.subject,
      body:
        typeof raw.body === "string" && raw.body.trim()
          ? raw.body
          : fallback.body,
      imagePrompt:
        typeof raw.imagePrompt === "string" && raw.imagePrompt.trim()
          ? raw.imagePrompt
          : fallback.imagePrompt,
    };
  } catch {
    return fallback;
  }
}

/** Escape the small set of characters that would break out of HTML text. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the issue as a minimal HTML email: the header image (when present) on
 * top, then the markdown body as pre-wrapped text. Kept deliberately small — a
 * real newsletter would use a templating layer, but this shows the shape.
 */
function renderHtml(issue: Issue, headerImageUrl: string | null): string {
  const header = headerImageUrl
    ? `<img src="${escapeHtml(headerImageUrl)}" alt="${escapeHtml(issue.subject)}" style="max-width:100%;border-radius:8px;" />`
    : "";
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;">` +
    header +
    `<div style="white-space:pre-wrap;line-height:1.5;">${escapeHtml(issue.body)}</div>` +
    `</div>`
  );
}

// ─────────────────────────────────────────────────────────────── steps ──
const search = defineStep({
  name: "search",
  next: ["scrape"],
  async run(input: EntryInput, ctx: Ctx) {
    const niche = input.niche?.trim() ?? "";
    ctx.shared.set("niche", niche);
    ctx.shared.set(
      "newsletterName",
      input.newsletterName?.trim() || DEFAULT_NEWSLETTER_NAME,
    );
    ctx.shared.set("schedule", input.schedule?.trim() || DEFAULT_SCHEDULE);
    ctx.shared.set(
      "subscribers",
      Array.isArray(input.subscribers)
        ? parseRecipients(input.subscribers.join(","))
        : [],
    );
    ctx.shared.set("dryRun", input.dryRun === true);

    if (!niche) {
      // Nothing to research — hand an empty candidate list forward so the graph
      // still traces end to end.
      return goto("scrape", { candidates: [] as Candidate[] });
    }

    ctx.logger.info("searching the web", { niche });
    const hits = await ctx.sapiom.search.webSearch({
      query: niche,
      intent: "links",
    });
    const candidates: Candidate[] = hits.results
      .slice(0, MAX_CANDIDATES)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    ctx.logger.info("search returned candidates", { count: candidates.length });
    return goto("scrape", { candidates });
  },
});

const scrape = defineStep({
  name: "scrape",
  next: ["write"],
  async run(input: { candidates: Candidate[] }, ctx: Ctx) {
    const candidates = input.candidates ?? [];
    const sources: ScrapedSource[] = [];
    let scraped = 0;
    for (const c of candidates) {
      // Beyond the scrape budget we still forward the candidate — the snippet
      // alone is useful writing context.
      if (scraped >= MAX_SCRAPES) {
        sources.push(c);
        continue;
      }
      try {
        const page = await ctx.sapiom.search.scrape({
          url: c.url,
          formats: ["markdown"],
          onlyMainContent: true,
        });
        scraped += 1;
        sources.push({
          title: page.metadata?.title || c.title,
          url: c.url,
          snippet: c.snippet,
          content: (page.markdown ?? "").slice(0, MAX_BODY_CHARS),
        });
      } catch (err) {
        // Scrapes fail routinely (paywalls, timeouts); degrade per-item, never
        // throw — an issue written from the survivors beats an aborted run.
        ctx.logger.warn("scrape failed; keeping snippet only", {
          url: c.url,
          err: String(err),
        });
        sources.push(c);
      }
    }
    ctx.logger.info("scraped candidates", { scraped, total: sources.length });
    return goto("write", { sources });
  },
});

const write = defineStep({
  name: "write",
  next: ["header"],
  async run(input: { sources: ScrapedSource[] }, ctx: Ctx) {
    const niche = ctx.shared.get("niche") || "your niche";
    const newsletterName =
      ctx.shared.get("newsletterName") || DEFAULT_NEWSLETTER_NAME;
    const sources = input.sources ?? [];
    // Slim references only — the scraped bodies stop here and never reach shared
    // state or the deliver boundary.
    const slimSources: Source[] = sources.map((s) => ({
      title: s.title,
      url: s.url,
    }));

    let issue: Issue;
    if (sources.length === 0) {
      issue = parseIssue(null, niche, newsletterName, slimSources);
    } else {
      const research = sources
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title} (${s.url})\n${(s.content || s.snippet).slice(0, MAX_BODY_CHARS)}`,
        )
        .join("\n\n");
      // The live, x402-served model curates AND writes the issue — ranking the
      // sources, dropping the weak ones, and producing a subject, a markdown
      // body, and a header-image prompt in one structured reply.
      const res = await ctx.sapiom.models.run({
        system:
          `You are the editor of a newsletter called "${newsletterName}". Given a ` +
          "NICHE and a set of web SOURCES (each: [n] title, url, extracted text), " +
          "curate the strongest items, drop thin or duplicate ones, and write this " +
          "week's issue. The body is markdown: an engaging '# ' subject headline, a " +
          "2-3 sentence intro, then 3-5 short sections that each summarize a story " +
          "and link it as a [n] reference, then a '## Sources' list mapping each [n] " +
          "to its title and url. Also write a vivid header-image prompt (no text in " +
          "the image). Reply with ONLY minified JSON: " +
          '{"subject":string,"body":string,"imagePrompt":string}.',
        prompt: `NICHE: ${niche}\n\nSOURCES:\n${research}`,
        maxTokens: 1200,
      });
      issue = parseIssue(res.output, niche, newsletterName, slimSources);
    }

    ctx.shared.set("subject", issue.subject);
    ctx.shared.set("body", issue.body);
    ctx.shared.set("imagePrompt", issue.imagePrompt);
    ctx.shared.set("sources", slimSources);
    ctx.logger.info("wrote issue", {
      subject: issue.subject,
      chars: issue.body.length,
      sources: slimSources.length,
    });
    return goto("header", { imagePrompt: issue.imagePrompt });
  },
});

const header = defineStep({
  name: "header",
  next: ["deliver"],
  async run(input: { imagePrompt: string }, ctx: Ctx) {
    const imagePrompt =
      input.imagePrompt || ctx.shared.get("imagePrompt") || "";
    let headerImageUrl: string | null = null;
    let headerImageFileId: string | null = null;

    // Best-effort: a header image is a nice-to-have, not a gate. If generation
    // returns nothing (e.g. a stubbed `run_local`) or errors, the issue still
    // goes out without it.
    try {
      const result = await ctx.sapiom.contentGeneration.images.create({
        prompt: imagePrompt,
        numImages: 1,
        storage: { visibility: "public" },
      });
      const img = result.images?.[0];
      if (img) {
        headerImageUrl = img.downloadUrl ?? img.url;
        headerImageFileId = img.fileId ?? null;
      } else {
        ctx.logger.warn("header image returned no output; sending without it");
      }
    } catch (err) {
      ctx.logger.warn("header image generation failed; sending without it", {
        err: String(err),
      });
    }

    ctx.shared.set("headerImageUrl", headerImageUrl);
    ctx.shared.set("headerImageFileId", headerImageFileId);
    ctx.logger.info("header ready", { hasImage: Boolean(headerImageUrl) });
    return goto("deliver", {});
  },
});

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const niche = ctx.shared.get("niche") || "your niche";
    const schedule = ctx.shared.get("schedule") || DEFAULT_SCHEDULE;
    const dryRun = ctx.shared.get("dryRun") ?? true;
    const subject = ctx.shared.get("subject") || `Newsletter: ${niche}`;
    const body = ctx.shared.get("body") || "";
    const sources = ctx.shared.get("sources") ?? [];
    const headerImageUrl = ctx.shared.get("headerImageUrl") ?? null;
    const issue: Issue = {
      subject,
      body,
      imagePrompt: ctx.shared.get("imagePrompt") || "",
    };
    const html = renderHtml(issue, headerImageUrl);

    // Explicit input list wins; otherwise resolve the default from the vault at
    // runtime (never carried through state), capped to bound the fan-out.
    const configured = ctx.shared.get("subscribers") ?? [];
    const subscribers = (
      configured.length > 0 ? configured : await subscribersFromVault(ctx)
    ).slice(0, MAX_RECIPIENTS);

    // The safe path: a dry run — or a live run with no subscribers configured yet —
    // returns the finished issue without sending anything.
    if (dryRun || subscribers.length === 0) {
      ctx.logger.info("skipping delivery", {
        dryRun,
        subscribers: subscribers.length,
      });
      return terminate({
        niche,
        schedule,
        delivered: false,
        dryRun,
        reason: dryRun ? "dry-run" : "no-subscribers",
        recipients: 0,
        subject,
        headerImageUrl,
        body,
        sources,
      });
    }

    // Send each subscriber their own copy so the list is never exposed across
    // recipients. Degrade per-item — one bad address shouldn't sink the issue.
    const inboxId = await resolveSenderInbox(ctx);
    const messageIds: string[] = [];
    let failed = 0;
    for (const to of subscribers) {
      try {
        const sent = await ctx.sapiom.email.messages.send(inboxId, {
          to,
          subject,
          text: body,
          html,
        });
        messageIds.push(sent.messageId);
      } catch (err) {
        failed += 1;
        ctx.logger.warn("send failed for one subscriber", {
          to,
          err: String(err),
        });
      }
    }
    ctx.logger.info("issue delivered", {
      recipients: messageIds.length,
      failed,
    });
    return terminate({
      niche,
      schedule,
      delivered: messageIds.length > 0,
      dryRun: false,
      recipients: messageIds.length,
      failed,
      subject,
      headerImageUrl,
      messageIds,
      sources,
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "newsletter-autopilot",
  entry: "search",
  steps: { search, scrape, write, header, deliver },
});
