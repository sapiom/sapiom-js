import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { EmailHttpError, fileStorage } from "@sapiom/tools";
import { z } from "zod/v4";

/**
 * Newsletter Autopilot — a standing, self-writing, self-editing newsletter.
 *
 * On each tick (built to run weekly) it searches a `niche`, reads the top
 * results for full text, dedupes and ranks them down to the strongest,
 * distinct set, asks an LLM (`ctx.sapiom.models.run` — the live x402-served
 * model, NOT a hardcoded formatter) to curate and WRITE the issue, grades its
 * own draft against a fixed quality bar with a second, chained model call and
 * revises — bounded — if it falls short, generates a header image, and
 * emails the finished issue to a subscriber list.
 *
 * Composition, in one legible graph:
 *   research   →  dedupe    →  write      ─▶ selfEdit ─┬─▶ illustrate  →  deliver
 *  (web.search)  (web.scrape)  (models.run)  (models.run)  (contentGeneration.images)  (email.send)
 *                                  ▲_______________loop, bounded_______┘
 *
 * This is the fusion of three siblings that used to ship separately —
 * `news-roundup` and `scheduled-research-brief` are retired in favor of this
 * template; fork this one instead:
 *   - `news-roundup` contributed the dedupe/rank-and-narrow discipline,
 *     folded here into `dedupe`, so `write` never drafts off a near-duplicate
 *     story twice.
 *   - `scheduled-research-brief` contributed the honest zero-setup delivery:
 *     with no subscriber list configured, `deliver` still emails a REAL issue
 *     to this agent's own self-provisioned Sapiom-hosted inbox
 *     (`resolveSenderInbox`) rather than reporting a send that never happened.
 *   - `eval-gate` contributed the bounded self-edit loop — `selfEdit` grades
 *     the draft against a fixed quality bar with a second, chained model call
 *     and sends it back to `write` with the critique, capped at
 *     `MAX_SELF_EDIT_ITERATIONS` attempts so the run always reaches a terminal.
 *
 * Side-effect discipline (copied from `scheduled-research-brief`):
 *   - `dryRun` gates the real send: it still researches, writes, self-edits,
 *     and generates the header image, then returns the finished issue as a
 *     preview WITHOUT emailing anyone. Pass it to `run_local` to trace the
 *     whole graph offline (capabilities stubbed) for free before a billed,
 *     delivering deploy + run.
 *   - The subscriber list is ordinary run input (a declared setting), not a
 *     secret. With none set, `deliver` still sends — for real, to the
 *     agent's own demo inbox — instead of reporting a send that never
 *     happened, so a zero-setup run proves the pattern rather than skipping it.
 *   - The header image is best-effort: if generation returns nothing (e.g. a
 *     stubbed `run_local`), the issue still goes out without it.
 *   - Each edge carries a slim, bounded payload. The scraped article bodies
 *     are the only large data: they're capped at `dedupe` and travel only
 *     across the `write ⇄ selfEdit` revision loop, never into `ctx.shared`
 *     (big shared state stalls transitions, per the `backlog-nudge` boundary
 *     lesson) — `ctx.shared` only ever holds the slim `{ title, url }`
 *     source list once the issue is written.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Default cadence when the caller doesn't pass one: 08:00 every Monday. */
const DEFAULT_SCHEDULE = "0 8 * * 1";
/** Default masthead when the caller doesn't name the newsletter. */
const DEFAULT_NEWSLETTER_NAME = "Weekly Autopilot";
/** How many search hits to consider as scrape candidates. */
const MAX_CANDIDATES = 8;
/** How many candidates to actually scrape (keeps latency + cost bounded). */
const MAX_SCRAPES = 5;
/** After dedupe/rank, how many distinct sources `write` gets to work from. */
const MAX_SOURCES = 5;
/** Truncate each scraped body — the only large data on the research→write path. */
const MAX_BODY_CHARS = 1200;
/** Cap the fan-out of per-subscriber sends (keeps a run's cost bounded). */
const MAX_RECIPIENTS = 50;
/** Two titles at or above this word-overlap ratio are treated as the same story. */
const DEDUPE_SIMILARITY = 0.6;
/** Pass bar for `selfEdit`, in [0,1]. */
const SELF_EDIT_THRESHOLD = 0.7;
/** Bound on write attempts (1 draft + revisions). `selfEdit` always publishes by this attempt. */
const MAX_SELF_EDIT_ITERATIONS = 2;
/**
 * The niche a zero-input run writes about. `web.search` needs no credential, so a
 * real search beats forwarding an empty candidate list and calling the empty
 * issue that follows a successful run.
 */
const DEFAULT_NICHE = "indie game development";

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** The niche / topic to research and write about on each tick. */
  niche: string;
  /** Masthead shown in the subject and header (defaults to a generic name). */
  newsletterName?: string;
  /** Cron cadence this newsletter is meant to run on (default weekly Monday 08:00). */
  schedule?: string;
  /**
   * Subscriber emails. Omit them and the issue is emailed to this agent's own
   * demo inbox instead, so the send is still real.
   */
  subscribers?: string[];
  /**
   * Write, self-edit, and render the issue but skip the real send entirely.
   * Nothing sets this for you — pass it explicitly.
   */
  dryRun?: boolean;
}

/** Slim search hit carried across the research → dedupe boundary. */
interface Candidate {
  title: string;
  url: string;
  snippet: string;
}

/** A candidate plus its (bounded) scraped body — the dedupe → write payload. */
interface ScrapedSource extends Candidate {
  /** Extracted article text (markdown, truncated); absent when scraping failed. */
  content?: string;
}

/** The slim source reference that lands in `ctx.shared` and the run's output. */
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

/** What `selfEdit` decided, carried through to the output either way. */
interface SelfEditResult {
  score: number;
  passed: boolean;
  iterations: number;
}

interface Shared extends Record<string, unknown> {
  niche: string;
  newsletterName: string;
  schedule: string;
  subscribers: string[];
  dryRun: boolean;
  /** Set when the run wrote about the default niche rather than the caller's. */
  note?: string;
  /** The write attempt `selfEdit` is currently grading (1-based). */
  iteration: number;
  subject: string;
  body: string;
  imagePrompt: string;
  sources: Source[];
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
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

/**
 * Reuse an existing inbox to send from, else provision one.
 *
 * We deliberately omit `username`. AgentMail addresses are globally unique, so
 * a fixed local part (e.g. "newsletter") can only ever be owned by ONE account
 * across the whole platform — every other tenant's `create` 409s with "Email
 * address is already taken", failing the step deterministically. Omitting it
 * lets AgentMail auto-generate a globally-unique address, so a fresh tenant's
 * zero-setup first run succeeds and two tenants never collide with each other.
 *
 * Reuse-then-create still isn't atomic (a concurrent run on the same account
 * could create between our `list` and `create`), so a 409 is treated as
 * "someone already provisioned one" — we re-list and reuse it rather than let
 * the step fail.
 */
async function resolveSenderInbox(ctx: Ctx): Promise<string> {
  const existing = await ctx.sapiom.email.inboxes.list({ limit: 1 });
  if (existing.inboxes.length > 0) return existing.inboxes[0].inboxId;
  try {
    const inbox = await ctx.sapiom.email.inboxes.create({
      displayName: "Newsletter Autopilot",
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

/** Normalize a title for duplicate detection: lowercase, punctuation stripped. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Word-overlap ratio relative to the shorter title — cheap, no model call. */
function titleSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const wb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap += 1;
  return overlap / Math.min(wa.size, wb.size);
}

/** Same page, modulo a trailing slash or query string. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Dedupe near-duplicate stories — same URL, or titles that overlap heavily
 * (wire services and aggregators often run the same story under different
 * headlines) — and rank the survivors by how much real content came back,
 * capped to `MAX_SOURCES`. Deterministic, in-process; no model call.
 */
function dedupeAndRank(sources: ScrapedSource[]): ScrapedSource[] {
  const ranked = [...sources].sort(
    (a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0),
  );
  const kept: ScrapedSource[] = [];
  for (const s of ranked) {
    const isDuplicate = kept.some(
      (k) =>
        normalizeUrl(k.url) === normalizeUrl(s.url) ||
        titleSimilarity(k.title, s.title) >= DEDUPE_SIMILARITY,
    );
    if (!isDuplicate) kept.push(s);
    if (kept.length >= MAX_SOURCES) break;
  }
  return kept;
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

/**
 * The fixed bar `selfEdit` grades every draft against — internal, not
 * user-configurable: this is the harness's own "ready to send" bar, not the
 * user's editorial opinion (contrast `eval-gate`, which takes the rubric as
 * input because grading opinion IS that template's whole point).
 */
const QUALITY_BAR =
  "It passes only if ALL of these hold: (1) the subject is a real headline " +
  "about the story, not a placeholder and not just the niche name restated; " +
  "(2) the body cites at least two of the listed SOURCES by name via their " +
  "[n] reference; (3) the body is roughly 200-2000 characters — not a stub, " +
  "not padded filler; (4) there is no meta-commentary about being an AI, a " +
  "model, or the writing process itself; (5) it contains no unfilled " +
  "placeholder text such as 'insert here', 'TBD', 'lorem ipsum', or a " +
  "bracketed instruction.";

function buildJudgePrompt(niche: string, sources: Source[], issue: Issue): string {
  const sourceList =
    sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url})`).join("\n") ||
    "(none)";
  return [
    "You are an impartial newsletter editor. Score the ISSUE below from 0.0 to",
    "1.0 against the QUALITY BAR — 1.0 fully clears it, 0.0 does not clear it",
    'at all. Respond with ONLY a JSON object: {"score": <0..1>, "critique": ' +
      '"<one or two sentences>"}.',
    "",
    "QUALITY BAR:",
    QUALITY_BAR,
    "",
    `NICHE: ${niche}`,
    "",
    "SOURCES:",
    sourceList,
    "",
    "ISSUE (subject then body):",
    issue.subject,
    "",
    issue.body,
  ].join("\n");
}

interface JudgeResult {
  score: number;
  critique: string;
}

/**
 * Parse a [0,1] score (and a best-effort critique) out of the judge's text
 * reply. A malformed reply scores 0 rather than throwing — `selfEdit` is
 * bounded by `MAX_SELF_EDIT_ITERATIONS`, so failing closed still reaches
 * `illustrate` within that cap instead of retrying the step indefinitely.
 */
function parseJudgeReply(output: string | null): JudgeResult {
  const fallback: JudgeResult = {
    score: 0,
    critique: "The judge model returned no reply to grade.",
  };
  if (!output) return fallback;
  try {
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    const raw = JSON.parse(json) as { score?: unknown; critique?: unknown };
    const n = Number(raw.score);
    if (!Number.isFinite(n)) return fallback;
    const score = Math.max(0, Math.min(1, n > 1 && n <= 100 ? n / 100 : n));
    return {
      score,
      critique:
        typeof raw.critique === "string" && raw.critique.trim()
          ? raw.critique.trim()
          : "",
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
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `niche` carries the sample as
 * its `.default(...)` so a zero-input tick writes a real issue instead of being
 * rejected for a missing field.
 */
const entryInput = z.object({
  niche: z
    .string()
    .default(DEFAULT_NICHE)
    .describe("The niche / topic to research and write about on each tick."),
  newsletterName: z
    .string()
    .default(DEFAULT_NEWSLETTER_NAME)
    .describe("Masthead shown in the subject and header."),
  schedule: z
    .string()
    .optional()
    .describe(
      "Cron cadence this newsletter runs on (default weekly Monday 08:00).",
    ),
  subscribers: z
    .array(z.string())
    .optional()
    .describe(
      "Subscriber emails. Omit them and the issue is emailed to this agent's own demo inbox instead.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Write, self-edit, and render the issue but skip the real send."),
});

const research = defineStep({
  name: "research",
  inputSchema: entryInput,
  next: ["dedupe"],
  async run(input: EntryInput, ctx: Ctx) {
    // The schema fills `niche` with DEFAULT_NICHE on a zero-input tick, so the
    // value — not its absence — is what tells us the default niche was used.
    const niche = input.niche?.trim() || DEFAULT_NICHE;
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
    ctx.shared.set("iteration", 1);
    if (niche === DEFAULT_NICHE) {
      ctx.shared.set(
        "note",
        `Wrote about the default niche ("${DEFAULT_NICHE}"). Pass a \`niche\` to write about yours.`,
      );
    }

    ctx.logger.info("researching the web", { niche });
    const hits = await ctx.sapiom.search.webSearch({
      query: niche,
      intent: "links",
    });
    const candidates: Candidate[] = hits.results
      .slice(0, MAX_CANDIDATES)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    ctx.logger.info("search returned candidates", { count: candidates.length });
    return goto("dedupe", { candidates });
  },
});

const dedupe = defineStep({
  name: "dedupe",
  next: ["write"],
  async run(input: { candidates: Candidate[] }, ctx: Ctx) {
    const candidates = input.candidates ?? [];
    const scrapedAll: ScrapedSource[] = [];
    let scraped = 0;
    for (const c of candidates) {
      // Beyond the scrape budget we still forward the candidate — the snippet
      // alone is useful writing context, and `dedupeAndRank` still considers it.
      if (scraped >= MAX_SCRAPES) {
        scrapedAll.push(c);
        continue;
      }
      try {
        const page = await ctx.sapiom.search.scrape({
          url: c.url,
          formats: ["markdown"],
          onlyMainContent: true,
        });
        scraped += 1;
        scrapedAll.push({
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
        scrapedAll.push(c);
      }
    }
    const sources = dedupeAndRank(scrapedAll);
    ctx.logger.info("deduped and ranked candidates", {
      scraped,
      candidates: candidates.length,
      kept: sources.length,
    });
    return goto("write", { sources });
  },
});

interface WriteInput {
  /** Deduped, ranked sources — present on the first attempt AND every revision. */
  sources: ScrapedSource[];
  /** The rejected draft `selfEdit` sent back, on a revision only. */
  previousDraft?: Issue;
  /** The judge's critique of `previousDraft`, addressed by the revision. */
  critique?: string;
}

const write = defineStep({
  name: "write",
  next: ["selfEdit"],
  async run(input: WriteInput, ctx: Ctx) {
    const niche = ctx.shared.get("niche") || "your niche";
    const newsletterName =
      ctx.shared.get("newsletterName") || DEFAULT_NEWSLETTER_NAME;
    const sources = input.sources ?? [];
    // Slim references only — the scraped bodies stop crossing into `ctx.shared`
    // here; they keep flowing to `selfEdit` (and back, on a revision) as edge
    // payload only.
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
      // On a revision (looped back from `selfEdit`), hand the model its own
      // rejected draft and the judge's critique so it addresses each point in
      // place rather than starting over blind — mirrors `eval-gate`'s
      // `buildDraftPrompt`.
      const revision =
        input.previousDraft && input.critique
          ? "\n\nYour previous attempt did not clear the newsletter's quality " +
            "bar. Revise it — address every point in the CRITIQUE precisely, " +
            "keep what already worked, and do not reintroduce the same issue." +
            `\n\nPREVIOUS DRAFT (JSON): ${JSON.stringify(input.previousDraft)}` +
            `\n\nCRITIQUE (why it fell short): ${input.critique}`
          : "";
      // The live, x402-served model curates AND writes the issue — ranking the
      // sources, dropping the weak ones, and producing a subject, a markdown
      // body, and a header-image prompt in one structured reply.
      const res = await ctx.sapiom.models.run({
        system:
          `You are the editor of a newsletter called "${newsletterName}". Given a ` +
          "NICHE and a set of web SOURCES (each: [n] title, url, extracted text), " +
          "curate the strongest, distinct items and write this week's issue. The " +
          "body is markdown: an engaging '# ' subject headline, a 2-3 sentence " +
          "intro, then 3-5 short sections that each summarize a story and link it " +
          "as a [n] reference, then a '## Sources' list mapping each [n] to its " +
          "title and url. Also write a vivid header-image prompt (no text in " +
          "the image). Reply with ONLY minified JSON: " +
          '{"subject":string,"body":string,"imagePrompt":string}.',
        prompt: `NICHE: ${niche}\n\nSOURCES:\n${research}${revision}`,
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
    return goto("selfEdit", { sources, issue });
  },
});

interface SelfEditInput {
  sources: ScrapedSource[];
  issue: Issue;
}

const selfEdit = defineStep({
  name: "selfEdit",
  next: ["write", "illustrate"],
  async run(input: SelfEditInput, ctx: Ctx) {
    const niche = ctx.shared.get("niche") || "your niche";
    const iteration = ctx.shared.get("iteration") ?? 1;
    const slimSources: Source[] = (input.sources ?? []).map((s) => ({
      title: s.title,
      url: s.url,
    }));
    // Chained judgment: this call's input is the `write` step's own output,
    // not caller-supplied data — a second model reading the first model's
    // reply, same shape as `eval-gate`'s `draft` → `judge`.
    const res = await ctx.sapiom.models.run({
      prompt: buildJudgePrompt(niche, slimSources, input.issue),
      maxTokens: 300,
    });
    const { score, critique } = parseJudgeReply(res.output);
    const passed = score >= SELF_EDIT_THRESHOLD;
    const exhausted = iteration >= MAX_SELF_EDIT_ITERATIONS;
    ctx.logger.info(
      `selfEdit: ${passed ? "cleared" : exhausted ? "hit the attempt cap" : "below bar, revising"}`,
      { score, iteration, threshold: SELF_EDIT_THRESHOLD },
    );

    if (passed || exhausted) {
      return goto("illustrate", {
        issue: input.issue,
        selfEdit: { score, passed, iterations: iteration },
      });
    }

    // Bounded revise-loop: hand `write` the rejected attempt and the judge's
    // critique, advance the attempt counter, and loop back.
    // `MAX_SELF_EDIT_ITERATIONS` guarantees this always reaches `illustrate` —
    // there is no unbounded path.
    ctx.shared.set("iteration", iteration + 1);
    return goto("write", {
      sources: input.sources,
      previousDraft: input.issue,
      critique,
    });
  },
});

interface IllustrateInput {
  issue: Issue;
  selfEdit: SelfEditResult;
}

const illustrate = defineStep({
  name: "illustrate",
  next: ["deliver"],
  async run(input: IllustrateInput, ctx: Ctx) {
    const imagePrompt = input.issue.imagePrompt || ctx.shared.get("imagePrompt") || "";
    let headerImageUrl: string | null = null;
    let headerImageFileId: string | null = null;

    // Best-effort: a header image is a nice-to-have, not a gate. If generation
    // returns nothing (e.g. a stubbed `run_local`) or errors, the issue still
    // goes out without it.
    try {
      const result = await ctx.sapiom.contentGeneration.images.create({
        prompt: imagePrompt,
        count: 1,
        // Neutral param (E4): a header banner should be landscape by intent, not
        // by the model's default (the SAP-2781 lesson — an unpinned ratio ships
        // whatever the provider felt like).
        aspectRatio: "16:9",
        storage: { visibility: "public" },
      });
      const img = result.images?.[0];
      if (img) {
        // The header image is embedded as an `<img>` src in the emailed issue —
        // a durable permalink survives in the inbox where a presigned URL
        // (`downloadUrl`/`url`, ~15min TTL) would 404.
        headerImageUrl = img.fileId
          ? fileStorage.getPublicUrl(img.fileId)
          : (img.downloadUrl ?? img.url);
        headerImageFileId = img.fileId ?? null;
      } else {
        ctx.logger.warn("header image returned no output; sending without it");
      }
    } catch (err) {
      ctx.logger.warn("header image generation failed; sending without it", {
        err: String(err),
      });
    }

    ctx.logger.info("illustration ready", { hasImage: Boolean(headerImageUrl) });
    return goto("deliver", {
      issue: input.issue,
      selfEdit: input.selfEdit,
      headerImageUrl,
      headerImageFileId,
    });
  },
});

interface DeliverInput {
  issue: Issue;
  selfEdit: SelfEditResult;
  headerImageUrl: string | null;
  headerImageFileId: string | null;
}

const deliver = defineStep({
  name: "deliver",
  next: [],
  terminal: true,
  async run(input: DeliverInput, ctx: Ctx) {
    const niche = ctx.shared.get("niche") || "your niche";
    const schedule = ctx.shared.get("schedule") || DEFAULT_SCHEDULE;
    const dryRun = ctx.shared.get("dryRun") ?? false;
    const subject = input.issue.subject || ctx.shared.get("subject") || `Newsletter: ${niche}`;
    const body = input.issue.body || ctx.shared.get("body") || "";
    const sources = ctx.shared.get("sources") ?? [];
    const headerImageUrl = input.headerImageUrl ?? null;
    const html = renderHtml(
      { subject, body, imagePrompt: input.issue.imagePrompt || "" },
      headerImageUrl,
    );
    const note = ctx.shared.get("note");
    const selfEditNote = !input.selfEdit.passed
      ? `Sent the best draft after ${input.selfEdit.iterations} self-edit ` +
        `attempt(s) without clearing the quality bar (score ` +
        `${input.selfEdit.score.toFixed(2)} < ${SELF_EDIT_THRESHOLD}).`
      : undefined;

    // The safe path: an explicit opt-in preview — compute everything, send
    // nothing at all.
    if (dryRun) {
      ctx.logger.info("dry run — skipping delivery", {});
      return terminate({
        niche,
        schedule,
        delivered: false,
        dryRun: true,
        reason: "dry-run",
        note: ["`dryRun` was set, so nothing was emailed.", note, selfEditNote]
          .filter(Boolean)
          .join(" "),
        to: null,
        recipients: 0,
        subject,
        headerImageUrl,
        body,
        sources,
        selfEdit: input.selfEdit,
      });
    }

    // A subscriber list is ordinary configuration, so it arrives as run input
    // (declared as a `subscribers` setting in template.json) rather than from a
    // write-only secret store nothing in the product can populate. Capped to
    // bound the fan-out.
    const subscribers = (ctx.shared.get("subscribers") ?? []).slice(
      0,
      MAX_RECIPIENTS,
    );
    const inboxId = await resolveSenderInbox(ctx);

    // The "email" headline must fire on a zero-setup run, so with no
    // `subscribers` we deliver to this agent's own Sapiom-hosted demo inbox —
    // a real, inspectable mailbox the platform provisions for us via
    // `resolveSenderInbox` (an `inboxId` IS its email address), never a
    // plausible-looking name. Setting `subscribers` is the upgrade that sends
    // to a real list instead.
    if (subscribers.length === 0) {
      const sent = await ctx.sapiom.email.messages.send(inboxId, {
        to: inboxId,
        subject,
        text: body,
        html,
      });
      ctx.logger.info("delivered to the demo inbox (no subscribers configured)", {
        to: inboxId,
        messageId: sent.messageId,
      });
      return terminate({
        niche,
        schedule,
        delivered: true,
        dryRun: false,
        demo: true,
        recipients: 1,
        to: inboxId,
        subject,
        headerImageUrl,
        messageId: sent.messageId,
        body,
        sources,
        selfEdit: input.selfEdit,
        note: [
          `No \`subscribers\` were set, so this issue was emailed to the ` +
            `agent's own Sapiom-hosted demo inbox (${inboxId}) — the message ` +
            `above is real and inspectable. Set \`subscribers\` to send it to ` +
            `your list instead.`,
          note,
          selfEditNote,
        ]
          .filter(Boolean)
          .join(" "),
      });
    }

    // Send each subscriber their own copy so the list is never exposed across
    // recipients. Degrade per-item — one bad address shouldn't sink the issue.
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
      demo: false,
      recipients: messageIds.length,
      failed,
      subject,
      headerImageUrl,
      messageIds,
      sources,
      selfEdit: input.selfEdit,
      ...(note || selfEditNote
        ? { note: [note, selfEditNote].filter(Boolean).join(" ") }
        : {}),
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "newsletter-autopilot",
  entry: "research",
  steps: { research, dedupe, write, selfEdit, illustrate, deliver },
});
