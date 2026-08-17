import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import {
  CODING_RESULT_SIGNAL,
  EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX,
  IMAGE_RESULT_SIGNAL,
  fileStorage,
  schedules,
  type CodingResultPayload,
  type ImageResultPayload,
} from "@sapiom/tools";
import { z } from "zod/v4";

import { buildCritiquePrompt, parseJudgment } from "./critique.js";

/**
 * Research → Micro-Site Publisher — deep multi-source research that
 * self-critiques its own write-up, illustrates it, and ends in a shareable
 * LIVE site, not a document.
 *
 * It plans a few complementary search queries for a topic, gathers and
 * dedupes candidate sources across them, reads the survivors for full text,
 * has an LLM synthesize a structured, cited report, then — folded in from the
 * eval-gate idiom (see `examples/eval-gate`, the Self-Editing Writer) —
 * grades that report against a fixed editorial rubric and revises it, bounded,
 * before generating a section illustration or two and handing the whole
 * package to a coding agent that builds a self-contained static site. The
 * site is deployed to a public preview URL, and — if you point a
 * Sapiom-owned domain at it — mapped onto a custom subdomain. The output is a
 * URL you can send someone.
 *
 * The graph, one legible line per capability:
 *   plan (compute) ─▶ gather (web.search × N, dedupe, web.scrape)
 *     ─▶ synthesize (models.run) ⇄ critique (models.run, bounded revise loop)
 *     ─▶ illustrate ⇄ collectIllustration (contentGeneration.images, bounded fan-out)
 *     ─▶ build (models.coding → a git repo) ─▶ publish (durable sandbox + deployPreview from git)
 *     ─▶ mapDomain (domains.dns) ─▶ live
 *
 * This template absorbs and replaces `web-research-digest` (search → cited
 * digest): everything that one showed off — a real `web.search`, a numbered
 * `[n]` source list a reader can click through — is a strict subset of the
 * `gather` → `synthesize` path here, now backed by full-text scrapes and
 * multiple queries instead of a single search's synthesized answer.
 *
 * The self-critique loop: `synthesize` produces a report; `critique` — a
 * second, independent model call reading the FIRST call's output, i.e.
 * chained judgment — scores it against a fixed rubric (citation coverage, no
 * redundant sections, tone fits the audience). Below the bar, with attempts
 * remaining, it hands the rejected report and the critique back to
 * `synthesize` for a revision; at or above the bar, or once
 * `maxDraftAttempts` is spent, it moves on regardless — there is no
 * unbounded path, and the run is honest either way (`reviewPassed` says
 * which).
 *
 * Durability by decoupling hosting from coding. The coding agent's real output is a
 * GIT REPO (`build` launches it with a `gitRepository`, then pushes the result) —
 * its own sandbox is a throwaway. `publish` then creates a SEPARATE, long-lived
 * (`ttl: "7d"`) hosting sandbox and `deployPreview`s the site FROM the repo
 * (`source: { kind: "git" }`), and registers an uptime keeper. The repo is the
 * durable source of truth: the keeper re-deploys from it (and re-creates the host
 * if it's ever gone), so the URL stays up — the exact recipe that holds Sapiom's own
 * dashboards up 24/7. On the LOCAL stack a coding run is host-mode (`local_host`),
 * which can't be pushed/deployed, so `publish` degrades honestly via the
 * `builtNotPublished` terminal instead of failing. (Run with a compatible cloud
 * coding environment — or on the deployed stack — for a real live URL.)
 *
 * Async pause/resume, twice: `illustrate` launches an image job per section and
 * suspends on its result signal, fanning out one image at a time (the same
 * shape `scene-to-video`'s `keyframe` ⇄ `collectKeyframe` uses, for the same
 * reason — a paused step waits on one `(signal, correlationId)` pair, so the
 * next launch only fires after the previous one resumed). `build` then
 * LAUNCHES the coding agent and suspends on its own result signal (a coding
 * run takes minutes), so the run costs nothing while either kind of job works.
 *
 * Side-effect discipline:
 *   - `dryRun` gates every irreversible/billed step after the report clears (or
 *     exhausts) self-critique: it returns the report via the `drafted` off-ramp
 *     WITHOUT illustrating, building, deploying, or touching DNS. Pass it to
 *     `run_local` to trace plan → gather → synthesize → critique offline
 *     (capabilities stubbed) for free before a billed deploy.
 *   - Illustration is best-effort and boundable to zero: `illustrationCount: 0`
 *     skips `illustrate` entirely, and a failed image launch or a job that
 *     comes back with no usable output just means one fewer picture — never a
 *     failed run.
 *   - The custom domain is optional. With none set, the preview URL IS the
 *     deliverable; `mapDomain` is skipped. Mapping assumes you already OWN the
 *     domain in Sapiom (`ctx.sapiom.domains`); DNS record creation is free.
 *   - Scraped bodies are bounded and die at the `synthesize` boundary — only
 *     slim excerpts (bounded, fixed-size) persist in shared state to support a
 *     revision, and only slim report metadata rides shared state to the terminal.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** How many complementary search queries `plan` generates. */
const MAX_QUERIES = 2;
/** How many deduped search hits to consider as scrape candidates. */
const MAX_CANDIDATES = 6;
/** How many candidates to actually scrape (keeps latency + cost bounded). */
const MAX_SCRAPES = 5;
/** Truncate each scraped body — the ONLY large data on the gather→synthesize path. */
const MAX_BODY_CHARS = 1500;
/** Cap sections the report (and thus the built site) carries. */
const MAX_SECTIONS = 6;
/** Truncate each section body handed to the coding agent, to bound the task size. */
const MAX_SECTION_CHARS = 1200;
/** Default host on the custom domain when the caller doesn't pass one. */
const DEFAULT_SUBDOMAIN = "www";
/**
 * The topic a zero-input run builds a site about. `web.search` needs no
 * credential, so a real search gives the coding agent something real to build
 * from — and `synthesize` refuses to build at all from an empty report.
 */
const DEFAULT_TOPIC = "how durable agent runtimes handle retries";
/** Build/start config for the static site the coding agent produces. */
const SITE_PORT = 3000;
const SITE_START = "node server.js";
/** Health path the uptime keeper probes; the built server.js must answer 200 here. */
const SITE_HEALTH_PATH = "/health";
/**
 * TTL for the DURABLE hosting sandbox `publish` creates. The site lives here, not
 * in the coding agent's throwaway sandbox — decoupling hosting from coding.
 */
const SITE_SANDBOX_TTL = "7d";
/** Keeper cron: probe /health + redeploy-from-git every 5 min (Sapiom's dashboard cadence). */
const KEEPER_CRON = "*/5 * * * *";
/** Pass bar `critique` grades a report against, in [0,1]. */
const DEFAULT_REVIEW_THRESHOLD = 0.7;
/** Bound on synthesize attempts (1 initial + revisions) — the eval-gate idiom's `maxIterations`. */
const DEFAULT_MAX_DRAFT_ATTEMPTS = 2;
const MAX_DRAFT_ATTEMPTS_CAP = 3;
/** How many sections get an illustration by default. */
const DEFAULT_ILLUSTRATION_COUNT = 2;
const MAX_ILLUSTRATIONS = 3;

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** What to research and publish a site about. */
  topic: string;
  /** Who the site is for — tunes the report's tone (e.g. "investors", "developers"). */
  audience?: string;
  /**
   * A domain you already OWN in Sapiom (`ctx.sapiom.domains`) to map the site
   * onto. Omit to publish at the preview URL only.
   */
  customDomain?: string;
  /** Host on the custom domain (default "www"), e.g. "report" → report.your.dev. */
  subdomain?: string;
  /**
   * Compute the report — after it clears (or exhausts) self-critique — and
   * return it as a preview, skipping illustration, the build, deploy, and
   * DNS. Nothing sets this for you — pass it explicitly to trace the graph
   * for free. A report too empty to build a site from also stops before then.
   */
  dryRun?: boolean;
  /**
   * Slug of a deployed uptime-keeper agent (e.g. `preview-keep-alive`) to register a
   * heal schedule against, so the published site stays up 24/7. Omit to publish
   * without a keeper (the site is up while its 7-day host sandbox lives, but nothing
   * relaunches the process if it's recycled). Best-effort: a failure logs and the run
   * still returns the URL + the `keeperTarget` to register by hand.
   */
  keeperDefinition?: string;
  /** Pass bar [0,1] the self-critique step grades the report against (default 0.7). */
  reviewThreshold: number;
  /** Bound on synthesize attempts: 1 initial + up to this many revisions total (default 2). */
  maxDraftAttempts: number;
  /** How many section illustrations to generate (0-3, default 2). 0 skips illustration entirely. */
  illustrationCount: number;
}

/** Slim search hit carried across the gather → synthesize boundary. */
interface Candidate {
  title: string;
  url: string;
  snippet: string;
}

/** A candidate plus its (bounded) scraped body. */
interface ScrapedSource extends Candidate {
  /** Extracted article text (markdown, truncated); absent when scraping failed. */
  content?: string;
}

/** The slim source reference that lands in the report and the output. */
interface Source {
  title: string;
  url: string;
}

/** One thematic block of the report, rendered as its own section on the site. */
interface ReportSection {
  heading: string;
  /** Markdown body; cites sources as [n] references. */
  body: string;
}

/** The structured report the coding agent turns into a site. */
interface Report {
  title: string;
  tagline: string;
  summary: string;
  sections: ReportSection[];
  sources: Source[];
}

/** A generated illustration for one report section — best-effort, may be absent. */
interface Illustration {
  heading: string;
  fileId?: string;
  downloadUrl?: string;
}

interface Shared extends Record<string, unknown> {
  topic: string;
  audience: string;
  customDomain: string | null;
  subdomain: string;
  dryRun: boolean;
  keeperDefinition: string | null;
  reviewThreshold: number;
  maxDraftAttempts: number;
  illustrationCount: number;
  /** The attempt number `synthesize` is currently drafting (1-based). */
  iteration: number;
  /** The rejected report `critique` sends back for `synthesize` to revise. */
  previousReport?: Report;
  /** The judge's critique of `previousReport`, addressed by the revision. */
  critique?: string;
  /** Bounded, slim excerpts gathered — reused across a revision so a loop-back
   * to `synthesize` never re-scrapes. */
  researchSources?: ScrapedSource[];
  /** Slim report metadata for the terminal to report (bodies stay off shared state). */
  reportTitle: string;
  reportTagline: string;
  sources: Source[];
  /** The report `illustrate`/`build` work from, set once `critique` clears it. */
  report?: Report;
  reviewScore?: number | null;
  reviewPassed?: boolean | null;
  reviewIterations?: number | null;
  reviewNote?: string | null;
  /** Index of the next section to illustrate; advanced by `collectIllustration`. */
  illustrationIndex: number;
  illustrations: Illustration[];
  /** The DURABLE hosting sandbox the site is deployed to (set in publish). */
  sandboxName: string | null;
  /** The git repo the coding agent built the site into — the durable source of truth. */
  repoSlug: string | null;
  /** The live preview URL, once deployed. */
  liveUrl: string | null;
  /** Set when the run researched the default topic rather than the caller's. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
function must<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`missing shared state: ${name}`);
  return v;
}

/**
 * Build a small set of complementary search queries from the topic. Bounded
 * and deterministic (no model call) — planning is cheap; the judgment lives
 * downstream in `synthesize` and `critique`.
 */
function buildQueries(topic: string): string[] {
  return [topic, `${topic} recent developments`].slice(0, MAX_QUERIES);
}

/** Normalize a URL for dedupe: strip scheme, `www.`, trailing slash, query, and hash. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Dedupe candidates gathered across multiple queries by normalized URL,
 * keeping the first (highest-ranked) occurrence. Complementary queries
 * routinely resurface the same page — this is what keeps `gather` from
 * paying to scrape one page twice.
 */
function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const key = normalizeUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}

/**
 * Parse the model's JSON report defensively. The model is asked for raw JSON, but
 * models wrap output in fences or prose often enough that a strict parse would
 * fail a real run — so strip fences, extract the outermost object, and fall back
 * to a minimal report built from the sources rather than throwing.
 */
function parseReport(raw: string, topic: string, sources: Source[]): Report {
  const fallback: Report = {
    title: topic || "Research report",
    tagline: "",
    summary: "",
    sections: [],
    sources,
  };
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  // Strip a leading ```json / ``` fence and trailing ``` if present.
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const obj = parsed as Record<string, unknown>;
  const sections = Array.isArray(obj.sections)
    ? obj.sections
        .filter(
          (s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null,
        )
        .slice(0, MAX_SECTIONS)
        .map((s) => ({
          heading: typeof s.heading === "string" ? s.heading : "",
          body:
            typeof s.body === "string"
              ? s.body.slice(0, MAX_SECTION_CHARS)
              : "",
        }))
        .filter((s) => s.heading || s.body)
    : [];
  return {
    title:
      typeof obj.title === "string" && obj.title ? obj.title : fallback.title,
    tagline: typeof obj.tagline === "string" ? obj.tagline : "",
    summary: typeof obj.summary === "string" ? obj.summary : "",
    sections,
    // Sources are authoritative from the scrape set — never trust the model to
    // echo URLs back correctly.
    sources,
  };
}

/** The image-generation prompt for one report section. No text/logos — the
 * built site lays its own heading over (or beside) the picture. */
function buildIllustrationPrompt(
  report: Report,
  section: ReportSection,
): string {
  return [
    `Editorial illustration for a web article titled "${report.title}"${report.tagline ? ` — ${report.tagline}` : ""}.`,
    `This image illustrates the section "${section.heading}".`,
    "Clean, modern, flat-vector style. No text, letters, numbers, or logos in the image.",
  ].join(" ");
}

/**
 * The coding-agent instruction: build a self-contained static site from the
 * report (and any illustrations). It asks for exactly two files at the
 * workspace root — `index.html` (inline CSS, no external assets) and a
 * zero-dependency `server.js` — so the deploy needs no build step and
 * `node server.js` serves the site as-is.
 */
function buildSiteTask(report: Report, illustrations: Illustration[]): string {
  const usable = illustrations.filter((i) => i.downloadUrl);
  const imageBlock =
    usable.length > 0
      ? [
          "",
          "ILLUSTRATIONS (JSON — heading, downloadUrl): for each, place a full-width <img> using that downloadUrl above the body of the section whose heading matches. Skip any section with no matching entry — do not invent an image for it.",
          "```json",
          JSON.stringify(
            usable.map((i) => ({
              heading: i.heading,
              downloadUrl: i.downloadUrl,
            })),
          ),
          "```",
        ]
      : [];
  return [
    "Build a single-page static website that presents the research report below as a polished, shareable micro-site.",
    "",
    "Create exactly these two files in your current working directory (the git repository checkout you were started in — do NOT cd elsewhere or use an absolute path):",
    "- `index.html`: a self-contained page (all CSS inline in a <style> tag, NO external stylesheets, fonts, scripts, or CDNs). Render a hero with the report title and tagline, then the summary, then each section as its own block (with its illustration, if one is provided below), then a 'Sources' list whose entries are clickable links. Make it clean, readable, and responsive; use a system-font stack and generous spacing.",
    "- `server.js`: a zero-dependency Node HTTP server (only the built-in `http`/`fs`/`path` modules) that serves files from its own directory, defaults to `index.html`, sets a sensible Content-Type, and listens on `process.env.PORT || 3000` bound to host `0.0.0.0`. It MUST answer `GET /health` with HTTP 200 and body `ok` (a liveness probe an uptime keeper hits — do not serve a file for that path).",
    "",
    "Do NOT create a package.json, add dependencies, or introduce a build step — `node server.js` must start the finished site directly.",
    ...imageBlock,
    "",
    "REPORT (JSON — title, tagline, summary, sections[{heading, body}], sources[{title, url}]):",
    "```json",
    JSON.stringify(report),
    "```",
  ].join("\n");
}

/** Extract the hostname from a URL for a CNAME target; null when unparseable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `topic` carries the sample as
 * its `.default(...)` so a zero-input run builds a real site instead of being
 * rejected for a missing field.
 */
const entryInput = z.object({
  topic: z
    .string()
    .default(DEFAULT_TOPIC)
    .describe("What to research and publish a site about."),
  audience: z
    .string()
    .optional()
    .describe(
      'Who the site is for — tunes the report tone (e.g. "investors", "developers").',
    ),
  customDomain: z
    .string()
    .optional()
    .describe(
      "A domain you already own in Sapiom to map the site onto. Omit to publish at the preview URL only.",
    ),
  subdomain: z
    .string()
    .default(DEFAULT_SUBDOMAIN)
    .describe('Host on the custom domain, e.g. "report" → report.your.dev.'),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Compute the report — after self-critique — and return it as a preview, skipping illustration, the build, deploy, and DNS.",
    ),
  keeperDefinition: z
    .string()
    .optional()
    .describe(
      'Slug of a deployed uptime-keeper agent (e.g. "preview-keep-alive") to register a heal schedule against, so the published site stays up 24/7. Omit to publish without a keeper.',
    ),
  reviewThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_REVIEW_THRESHOLD)
    .describe(
      "Pass bar in [0,1] the self-critique step grades the report against; below it, with attempts remaining, the report is revised.",
    ),
  maxDraftAttempts: z
    .number()
    .int()
    .min(1)
    .max(MAX_DRAFT_ATTEMPTS_CAP)
    .default(DEFAULT_MAX_DRAFT_ATTEMPTS)
    .describe(
      "Bound on synthesize attempts (1 initial + revisions). The run always moves on by this attempt, pass or not.",
    ),
  illustrationCount: z
    .number()
    .int()
    .min(0)
    .max(MAX_ILLUSTRATIONS)
    .default(DEFAULT_ILLUSTRATION_COUNT)
    .describe(
      "How many section illustrations to generate. 0 skips illustration entirely.",
    ),
});

const plan = defineStep({
  name: "plan",
  inputSchema: entryInput,
  next: ["gather"],
  async run(input: EntryInput, ctx: Ctx) {
    // The schema fills `topic` with DEFAULT_TOPIC on a zero-input run, so the
    // value — not its absence — is what tells us the sample topic was used.
    const topic = input.topic?.trim() || DEFAULT_TOPIC;
    ctx.shared.set("topic", topic);
    ctx.shared.set("audience", input.audience?.trim() || "a general audience");
    ctx.shared.set("customDomain", input.customDomain?.trim() || null);
    ctx.shared.set("subdomain", input.subdomain?.trim() || DEFAULT_SUBDOMAIN);
    ctx.shared.set("dryRun", input.dryRun === true);
    ctx.shared.set("keeperDefinition", input.keeperDefinition?.trim() || null);
    ctx.shared.set("reviewThreshold", input.reviewThreshold);
    ctx.shared.set("maxDraftAttempts", input.maxDraftAttempts);
    ctx.shared.set("illustrationCount", input.illustrationCount);
    ctx.shared.set("iteration", 1);
    ctx.shared.set("illustrationIndex", 0);
    ctx.shared.set("illustrations", []);
    ctx.shared.set("sandboxName", null);
    ctx.shared.set("repoSlug", null);
    ctx.shared.set("liveUrl", null);
    if (topic === DEFAULT_TOPIC) {
      ctx.shared.set(
        "note",
        `Researched the default topic ("${DEFAULT_TOPIC}"). Pass a \`topic\` to build a site about yours.`,
      );
    }

    const queries = buildQueries(topic);
    ctx.logger.info("planned research queries", { topic, queries });
    return goto("gather", { queries });
  },
});

const gather = defineStep({
  name: "gather",
  next: ["synthesize"],
  async run(input: { queries: string[] }, ctx: Ctx) {
    const queries = (input.queries ?? []).slice(0, MAX_QUERIES);
    const candidates: Candidate[] = [];
    for (const query of queries) {
      ctx.logger.info("searching the web", { query });
      const hits = await ctx.sapiom.search.webSearch({
        query,
        intent: "links",
      });
      candidates.push(
        ...(hits?.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        })),
      );
    }
    // Complementary queries routinely surface the same page twice — dedupe by
    // normalized URL before scraping so we never pay to read one page twice.
    const deduped = dedupeCandidates(candidates).slice(0, MAX_CANDIDATES);
    ctx.logger.info("gathered candidates", {
      queries: queries.length,
      raw: candidates.length,
      deduped: deduped.length,
    });

    const sources: ScrapedSource[] = [];
    let scraped = 0;
    for (const c of deduped) {
      // Beyond the scrape budget we still forward the candidate — the snippet
      // alone is useful synthesis context.
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
        // throw — a report from the survivors beats an aborted run.
        ctx.logger.warn("scrape failed; keeping snippet only", {
          url: c.url,
          err: String(err),
        });
        sources.push(c);
      }
    }
    ctx.logger.info("scraped candidates", { scraped, total: sources.length });
    return goto("synthesize", { sources });
  },
});

const synthesize = defineStep({
  name: "synthesize",
  next: ["critique", "drafted"],
  async run(input: { sources?: ScrapedSource[] }, ctx: Ctx) {
    const topic = ctx.shared.get("topic") || "your topic";
    const audience = ctx.shared.get("audience") || "a general audience";

    // The first entry (from `gather`) carries the sources; a revise loop-back
    // from `critique` carries none, so re-read what was already gathered —
    // bounded, slim excerpts, never the full page bodies past this point.
    if (input.sources !== undefined) {
      ctx.shared.set("researchSources", input.sources);
    }
    const scraped = ctx.shared.get("researchSources") ?? [];
    const sources: Source[] = scraped.map((s) => ({
      title: s.title,
      url: s.url,
    }));

    if (scraped.length === 0) {
      // Nothing to write from and nothing to critique or illustrate — stop
      // now rather than spending a model call to grade an empty page.
      const report: Report = {
        title: `${topic}`,
        tagline: "",
        summary: `No sources were found for "${topic}".`,
        sections: [],
        sources,
      };
      ctx.logger.warn("empty research — not synthesizing a report", { topic });
      return goto("drafted", { report, reason: "empty-report" });
    }

    const research = scraped
      .map(
        (s, i) =>
          `[${i + 1}] ${s.title} (${s.url})\n${(s.content || s.snippet).slice(0, MAX_BODY_CHARS)}`,
      )
      .join("\n\n");
    const previousReport = ctx.shared.get("previousReport");
    const critique = ctx.shared.get("critique");
    const system =
      "You are a research analyst producing a structured report for a web " +
      "micro-site. Given a TOPIC, an AUDIENCE, and numbered web SOURCES " +
      "(each: [n] title, url, extracted text), write a report and output " +
      "ONLY a JSON object (no prose, no code fences) with this shape: " +
      '{ "title": string, "tagline": string (one line), "summary": string ' +
      '(2-4 sentences), "sections": [{ "heading": string, "body": string }] }. ' +
      `Use 3 to ${MAX_SECTIONS} sections. Each section body is markdown and ` +
      "cites the sources it draws on as [n] references. Rank by relevance and " +
      "credibility; drop thin or duplicate material. Tune the tone for the AUDIENCE.";
    let prompt = `TOPIC: ${topic}\nAUDIENCE: ${audience}\n\nSOURCES:\n${research}`;
    if (previousReport !== undefined && critique !== undefined) {
      // Revision attempt: mirror eval-gate's draft prompt — address the
      // critique precisely, keep what already worked, don't start over blind.
      prompt +=
        "\n\nYour previous report did not clear editorial review. Revise it — " +
        "address every point in the CRITIQUE precisely, keep the sections that " +
        "already worked, and do not reintroduce the same issue.\n\n" +
        `PREVIOUS REPORT (JSON):\n${JSON.stringify(previousReport)}\n\n` +
        `CRITIQUE (why it fell short):\n${critique}`;
    }

    // The live, x402-served model turns the raw sources into a structured,
    // cited report — the content the site renders.
    const res = await ctx.sapiom.models.run({
      system,
      prompt,
      maxTokens: 1500,
    });
    const report = parseReport(res?.output ?? "", topic, sources);

    // Slim report metadata rides shared state to the terminal; the full section
    // bodies travel to `critique`/`illustrate`/`build` via `ctx.shared.set("report", ...)`.
    ctx.shared.set("reportTitle", report.title);
    ctx.shared.set("reportTagline", report.tagline);
    ctx.shared.set("sources", report.sources);
    ctx.logger.info("synthesized report", {
      title: report.title,
      sections: report.sections.length,
      sources: report.sources.length,
      revision: previousReport !== undefined,
    });
    return goto("critique", { report });
  },
});

/**
 * The self-critique loop, folded in from the eval-gate idiom: one `models.run`
 * judge call, then the bounded decide-and-branch (no separate step for that,
 * unlike eval-gate's `judge`/`decide` split — this template's graph target is
 * ~7 named phases, so the branch lives in the same step as the judge call,
 * the same way `synthesize` already branches to `critique`/`drafted` in one).
 */
const critique = defineStep({
  name: "critique",
  next: ["synthesize", "illustrate", "drafted"],
  async run(input: { report: Report }, ctx: Ctx) {
    const report = input.report;
    const audience = ctx.shared.get("audience") || "a general audience";
    const iteration = must(ctx.shared.get("iteration"), "iteration");
    const maxDraftAttempts = must(
      ctx.shared.get("maxDraftAttempts"),
      "maxDraftAttempts",
    );
    const reviewThreshold = must(
      ctx.shared.get("reviewThreshold"),
      "reviewThreshold",
    );

    const prompt = buildCritiquePrompt({
      report: {
        title: report.title,
        tagline: report.tagline,
        summary: report.summary,
        sections: report.sections,
        sources: report.sources,
      },
      audience,
    });
    // Chained judgment: this call's input is `synthesize`'s model output, not
    // caller-supplied data — a malformed reply throws in `parseJudgment` and
    // the engine retries, same contract as `synthesize`'s own model call.
    const res = await ctx.sapiom.models.run({ prompt, maxTokens: 300 });
    const { score, rationale } = parseJudgment(res?.output ?? "");
    const passed = score >= reviewThreshold;
    const exhausted = iteration >= maxDraftAttempts;
    ctx.logger.info(
      `critique: scored the report — ${passed ? "cleared review" : exhausted ? "attempt cap hit" : "revising"}`,
      { score, threshold: reviewThreshold, iteration, maxDraftAttempts },
    );

    if (!passed && !exhausted) {
      // Bounded revise loop: hand `synthesize` the rejected report and the
      // critique, advance the attempt counter, and loop back.
      // `maxDraftAttempts` guarantees this always moves on — there is no
      // unbounded path.
      ctx.shared.set("previousReport", report);
      ctx.shared.set("critique", rationale);
      ctx.shared.set("iteration", iteration + 1);
      return goto("synthesize", {});
    }

    if (ctx.shared.get("dryRun") === true) {
      return goto("drafted", {
        report,
        reason: "dry-run",
        reviewScore: score,
        reviewPassed: passed,
        reviewIterations: iteration,
        reviewNote: rationale,
      });
    }
    return goto("illustrate", {
      report,
      reviewScore: score,
      reviewPassed: passed,
      reviewIterations: iteration,
      reviewNote: rationale,
    });
  },
});

interface IllustrateInput {
  /** Present on the first entry from `critique`; absent on a loop-back from
   * `collectIllustration`, which reads everything from shared state instead. */
  report?: Report;
  reviewScore?: number;
  reviewPassed?: boolean;
  reviewIterations?: number;
  reviewNote?: string;
}

const illustrate = defineStep({
  name: "illustrate",
  next: ["collectIllustration", "build"],
  // Async pause/resume: the launched image job fires IMAGE_RESULT_SIGNAL on
  // completion, resuming `collectIllustration` with the image's result — the
  // same shape `scene-to-video`'s `keyframe` ⇄ `collectKeyframe` fan-out uses.
  pause: { signal: IMAGE_RESULT_SIGNAL, resumeStep: "collectIllustration" },
  async run(input: IllustrateInput, ctx: Ctx) {
    if (input.report !== undefined) {
      ctx.shared.set("report", input.report);
      ctx.shared.set("reviewScore", input.reviewScore ?? null);
      ctx.shared.set("reviewPassed", input.reviewPassed ?? null);
      ctx.shared.set("reviewIterations", input.reviewIterations ?? null);
      ctx.shared.set("reviewNote", input.reviewNote ?? null);
    }
    const report = must(ctx.shared.get("report"), "report");
    const illustrationCount = must(
      ctx.shared.get("illustrationCount"),
      "illustrationCount",
    );
    const index = must(
      ctx.shared.get("illustrationIndex"),
      "illustrationIndex",
    );

    // No illustrations requested, or fewer sections than the budget: nothing
    // left to generate — move straight to the build.
    if (illustrationCount === 0 || index >= report.sections.length) {
      return goto("build", {});
    }

    const section = report.sections[index];
    ctx.logger.info("generating illustration", {
      heading: section.heading,
      index: index + 1,
      of: Math.min(illustrationCount, report.sections.length),
    });
    try {
      const handle = await ctx.sapiom.contentGeneration.images.launch({
        prompt: buildIllustrationPrompt(report, section),
        count: 1,
        storage: { visibility: "public" },
      });
      return await pauseUntilSignal(handle, {
        resumeStep: "collectIllustration",
      });
    } catch (err) {
      // Best-effort: a failed launch means no picture for this section, not a
      // failed run. Hand `collectIllustration` the same empty shape a real
      // no-output result would carry, so one degrade path covers both causes.
      ctx.logger.warn("illustration launch failed; continuing without it", {
        heading: section.heading,
        err: String(err),
      });
      return goto("collectIllustration", { outputs: [] });
    }
  },
});

const collectIllustration = defineStep({
  name: "collectIllustration",
  next: ["illustrate", "build"],
  async run(result: ImageResultPayload, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    const illustrations = must(
      ctx.shared.get("illustrations"),
      "illustrations",
    );
    const illustrationCount = must(
      ctx.shared.get("illustrationCount"),
      "illustrationCount",
    );
    const index = must(
      ctx.shared.get("illustrationIndex"),
      "illustrationIndex",
    );
    const section = report.sections[index];

    const img = result.outputs?.[0];
    if (img?.fileId || img?.downloadUrl) {
      const next = [
        ...illustrations,
        {
          heading: section.heading,
          ...(img.fileId !== undefined && { fileId: img.fileId }),
          ...(img.downloadUrl !== undefined && {
            downloadUrl: img.downloadUrl,
          }),
        },
      ];
      ctx.shared.set("illustrations", next);
      ctx.logger.info("collected illustration", {
        heading: section.heading,
        collected: next.length,
      });
    } else {
      // Best-effort, same as a failed launch: no usable image for this
      // section, never a failed run.
      const storageError = img?.storageError ? `: ${img.storageError}` : "";
      ctx.logger.warn(
        "illustration generation returned no usable output; continuing without it",
        { heading: section.heading, storageError },
      );
    }

    const nextIndex = index + 1;
    ctx.shared.set("illustrationIndex", nextIndex);
    // More sections need an illustration (within budget)? Loop back.
    // Otherwise the budget's spent or every section's covered — build.
    return nextIndex < illustrationCount && nextIndex < report.sections.length
      ? goto("illustrate", {})
      : goto("build", {});
  },
});

const build = defineStep({
  name: "build",
  next: [],
  // Async pause/resume: the launched coding run fires CODING_RESULT_SIGNAL when it
  // reaches a terminal state, resuming `publish` with the run's result. The run
  // costs nothing while the agent works.
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "publish" },
  async run(_input: unknown, ctx: Ctx) {
    const report = must(ctx.shared.get("report"), "report");
    const illustrations = ctx.shared.get("illustrations") ?? [];

    // Mint a durable permalink from each illustration's `fileId` right before
    // handing them to the coding agent. These become `<img>` srcs baked into a
    // PUBLISHED static site, so a presigned download URL (~15min TTL) would
    // 404 on the live site shortly after publish — `getPublicUrl` is pure and
    // synchronous (no network call, so nothing to refresh or catch here).
    const resolved = illustrations.map((ill) =>
      ill.fileId
        ? { ...ill, downloadUrl: fileStorage.getPublicUrl(ill.fileId) }
        : ill,
    );

    // The coding agent's durable output is a git REPO, not its throwaway sandbox.
    // Create the repo and clone it into the run (`gitRepository`); the agent builds
    // the site inside that checkout, and `publish` pushes it + deploys a durable host
    // FROM the repo. Decouples hosting from coding — the coding sandbox can vanish.
    const repoSlug = `microsite-${ctx.executionId}`;
    ctx.shared.set("repoSlug", repoSlug);
    const repo = await ctx.sapiom.repositories.create(repoSlug);
    ctx.logger.info("launching coding agent to build the site into a repo", {
      title: report.title,
      sections: report.sections.length,
      illustrations: resolved.filter((i) => i.downloadUrl).length,
      repo: repoSlug,
    });
    const handle = await ctx.sapiom.models.coding.launch({
      task: buildSiteTask(report, resolved),
      gitRepository: repo,
    });
    return await pauseUntilSignal(handle, { resumeStep: "publish" });
  },
});

/**
 * Uptime-keeper target for the published site. Shape a deployed keeper agent
 * (e.g. `preview-keep-alive`) accepts as its per-run schedule input: probe
 * `url + healthPath`; on failure re-attach `sandboxName` and re-`deployPreview`.
 * `source: git` lets a git-aware keeper resurrect the host from the repo even after
 * full deletion (an fs-only keeper ignores it and heals from the host's own files).
 */
interface KeeperTarget {
  sandboxName: string;
  url: string;
  healthPath: string;
  start: string;
  port: number;
  source: { kind: "git"; repo: string; ref: string };
}

function buildKeeperTarget(
  sandboxName: string,
  url: string,
  repo: string,
): KeeperTarget {
  return {
    sandboxName,
    url,
    healthPath: SITE_HEALTH_PATH,
    start: SITE_START,
    port: SITE_PORT,
    source: { kind: "git", repo, ref: "main" },
  };
}

/**
 * Best-effort: register a recurring heal schedule on a deployed keeper agent so the
 * site stays up past process recycling. Non-fatal — if no keeper is configured, or
 * the schedule API isn't reachable here, the site is still deployed and the caller
 * returns the `keeperTarget` for an operator to register by hand.
 */
async function registerKeeper(
  ctx: Ctx,
  target: KeeperTarget,
): Promise<boolean> {
  const keeperDefinition = ctx.shared.get("keeperDefinition") as string | null;
  if (!keeperDefinition) return false;
  try {
    await schedules.create({
      definition: keeperDefinition,
      kind: "schedule_cron",
      cron: KEEPER_CRON,
      input: target,
    });
    ctx.logger.info("registered uptime keeper", {
      keeper: keeperDefinition,
      sandbox: target.sandboxName,
      cron: KEEPER_CRON,
    });
    return true;
  } catch (err) {
    ctx.logger.warn(
      "could not register keeper — site up only while its host lives",
      {
        keeper: keeperDefinition,
        err: String(err),
      },
    );
    return false;
  }
}

const publish = defineStep({
  name: "publish",
  next: ["mapDomain", "live", "failed", "builtNotPublished"],
  async run(result: CodingResultPayload, ctx: Ctx) {
    // The coding run must have finished cleanly and left a sandbox to deploy from.
    if (result.status !== "completed" || !result.executionEnvironment) {
      ctx.logger.warn("coding run did not complete", {
        status: result.status,
        error: result.error?.message ?? null,
      });
      return goto("failed", {
        stage: "build",
        logs:
          result.error?.message ??
          `coding run ended in status "${result.status}"`,
      });
    }

    const env = result.executionEnvironment;
    const repoSlug = ctx.shared.get("repoSlug");

    // Local host-mode coding runs aren't a pushable/deployable cloud sandbox, so
    // there's nothing to publish from here. Degrade honestly (the site WAS built in
    // the checkout) rather than fail. In a compatible cloud environment this
    // branch is skipped.
    if (env.type !== EXECUTION_ENVIRONMENT_BLAXEL_SANDBOX || !repoSlug) {
      ctx.logger.warn(
        "coding run is not in a deployable cloud environment; skipping publish",
        {
          environmentType: env.type,
          repo: repoSlug,
        },
      );
      return goto("builtNotPublished", { environmentType: env.type });
    }

    // 1) Push the agent's build to the repo — the durable source of truth. After
    //    this the coding sandbox can be reaped; the repo is what we host from.
    try {
      const repo = await ctx.sapiom.repositories.get(repoSlug);
      const codingBox = ctx.sapiom.sandboxes.attach(env.id);
      await repo.pushFromSandbox(codingBox, {
        message: `build: ${ctx.shared.get("reportTitle") ?? "microsite"}`,
      });
      ctx.logger.info("pushed built site to repo", { repo: repoSlug });
    } catch (err) {
      ctx.logger.error("pushFromSandbox failed", {
        repo: repoSlug,
        err: String(err),
      });
      return goto("failed", { stage: "push", logs: String(err) });
    }

    // 2) Create a DURABLE (7d) hosting sandbox and deploy the site FROM the repo —
    //    decoupled from the coding sandbox entirely.
    const hostName = `microsite-${ctx.executionId}`;
    ctx.shared.set("sandboxName", hostName);
    let deploy: { url: string | null; status: string; logs: string };
    try {
      const host = await ctx.sapiom.sandboxes.create({
        name: hostName,
        port: SITE_PORT,
        ttl: SITE_SANDBOX_TTL,
      });
      deploy = await host.deployPreview({
        source: { kind: "git", repo: repoSlug, ref: "main" },
        start: SITE_START,
        port: SITE_PORT,
      });
    } catch (err) {
      ctx.logger.error("deployPreview (git) threw", {
        host: hostName,
        err: String(err),
      });
      return goto("failed", { stage: "deploy", logs: String(err) });
    }

    if (deploy.status === "failed" || !deploy.url) {
      return goto("failed", { stage: "deploy", logs: deploy.logs });
    }
    ctx.shared.set("liveUrl", deploy.url);
    ctx.logger.info("site is live", { url: deploy.url, status: deploy.status });

    // 3) Keep it alive: register a keeper that re-deploys from the repo (source git)
    //    on a schedule — resurrectable even if the host sandbox is ever deleted.
    const keeperTarget = buildKeeperTarget(hostName, deploy.url, repoSlug);
    const keptAlive = await registerKeeper(ctx, keeperTarget);
    ctx.shared.set("keeperTarget", keeperTarget);
    ctx.shared.set("keptAlive", keptAlive);

    // Map a custom domain onto it when one is configured; otherwise the preview
    // URL is the deliverable.
    const customDomain = ctx.shared.get("customDomain");
    if (customDomain) {
      return goto("mapDomain", { liveUrl: deploy.url });
    }
    return goto("live", { liveUrl: deploy.url, customUrl: null });
  },
});

const mapDomain = defineStep({
  name: "mapDomain",
  next: ["live"],
  async run(input: { liveUrl: string }, ctx: Ctx) {
    const domainName = ctx.shared.get("customDomain");
    const subdomain = ctx.shared.get("subdomain") || DEFAULT_SUBDOMAIN;
    const liveUrl = input.liveUrl;
    const target = hostOf(liveUrl);

    // No owned domain, or an unparseable preview host: nothing to map. Fall
    // through to live with just the preview URL.
    if (!domainName || !target) {
      return goto("live", { liveUrl, customUrl: null });
    }

    // Point <subdomain>.<domain> at the preview host with a CNAME. DNS record
    // creation is free; assumes you already own the domain in Sapiom. On any
    // error the preview URL still works, so we log and continue rather than fail.
    const customUrl = `https://${subdomain}.${domainName}`;
    try {
      await ctx.sapiom.domains.dns.create({
        domainName,
        type: "CNAME",
        host: subdomain,
        value: target,
      });
      ctx.logger.info("mapped custom domain", { customUrl, target });
      return goto("live", { liveUrl, customUrl });
    } catch (err) {
      ctx.logger.warn("could not create DNS record; serving preview URL only", {
        domainName,
        subdomain,
        err: String(err),
      });
      return goto("live", { liveUrl, customUrl: null });
    }
  },
});

const live = defineStep({
  name: "live",
  next: [],
  terminal: true,
  async run(input: { liveUrl: string; customUrl: string | null }, ctx: Ctx) {
    const topic = ctx.shared.get("topic") || "";
    const keptAlive = ctx.shared.get("keptAlive") === true;
    const illustrationCount = (ctx.shared.get("illustrations") ?? []).filter(
      (i) => i.downloadUrl || i.fileId,
    ).length;
    // The site is deployed to a durable (7d) host FROM a git repo. With a keeper
    // registered it stays up 24/7 (probe /health → redeploy-from-git on failure);
    // without one it's up while the host lives but the process isn't relaunched if
    // recycled — so we say which, and hand back `keeperTarget` to register one.
    const note = [
      keptAlive
        ? "Live and kept alive: an uptime keeper probes /health and redeploys from the repo, so the URL stays up (host sandbox TTL 7d, resurrectable from git)."
        : "Live on a 7-day host, but NO keeper was registered — if the sandbox process is recycled the URL 502s until redeployed. Pass `keeperDefinition` (a deployed keeper agent's slug), or register a keeper against `keeperTarget`, to keep it up 24/7.",
      ctx.shared.get("note"),
    ]
      .filter(Boolean)
      .join(" ");
    return terminate({
      published: true,
      keptAlive,
      topic,
      title: ctx.shared.get("reportTitle") ?? topic,
      tagline: ctx.shared.get("reportTagline") ?? "",
      liveUrl: input.liveUrl,
      customUrl: input.customUrl ?? null,
      sandboxName: ctx.shared.get("sandboxName") ?? null,
      repoSlug: ctx.shared.get("repoSlug") ?? null,
      keeperTarget: ctx.shared.get("keeperTarget") ?? null,
      sources: ctx.shared.get("sources") ?? [],
      reviewScore: ctx.shared.get("reviewScore") ?? null,
      reviewPassed: ctx.shared.get("reviewPassed") ?? null,
      reviewIterations: ctx.shared.get("reviewIterations") ?? null,
      illustrationCount,
      note,
    });
  },
});

const failed = defineStep({
  name: "failed",
  next: [],
  terminal: true,
  async run(input: { stage: string; logs: string | null }, ctx: Ctx) {
    return terminate({
      published: false,
      stage: input?.stage ?? null,
      logs: input?.logs ?? null,
      sandboxName: ctx.shared.get("sandboxName") ?? null,
      title: ctx.shared.get("reportTitle") ?? null,
    });
  },
});

const drafted = defineStep({
  name: "drafted",
  next: [],
  terminal: true,
  async run(
    input: {
      report: Report;
      reason?: string;
      reviewScore?: number;
      reviewPassed?: boolean;
      reviewIterations?: number;
      reviewNote?: string;
    },
    ctx: Ctx,
  ) {
    // The off-ramp: the report was computed but nothing was illustrated,
    // built, deployed, or mapped. Two ways in — an explicit dry run (after
    // self-critique settles), or a report too empty to critique at all.
    const empty = input.reason === "empty-report";
    return terminate({
      published: false,
      dryRun: !empty,
      reason: input.reason ?? "dry-run",
      topic: ctx.shared.get("topic") || "",
      report: input.report,
      reviewScore: input.reviewScore ?? null,
      reviewPassed: input.reviewPassed ?? null,
      reviewIterations: input.reviewIterations ?? null,
      note: [
        empty
          ? "The research came back empty, so no site was built or deployed — there was nothing to publish."
          : input.reviewNote
            ? `\`dryRun\` was set, so no site was built or deployed. Editorial self-critique: ${input.reviewNote}`
            : "`dryRun` was set, so no site was built or deployed.",
        ctx.shared.get("note"),
      ]
        .filter(Boolean)
        .join(" "),
    });
  },
});

const builtNotPublished = defineStep({
  name: "builtNotPublished",
  next: [],
  terminal: true,
  async run(input: { environmentType: string }, ctx: Ctx) {
    // Honest degrade: the coding agent built the site, but its run executed in an
    // environment `deployPreview` can't serve from (local host mode). This is the
    // expected local-stack outcome — the same flow publishes a live preview URL in
    // production, where the coding run lands in a compatible cloud sandbox. We
    // report the
    // built report metadata so the run isn't a dead end, and name the limitation
    // instead of surfacing a raw "Sandbox not found" 404.
    const environmentType = input?.environmentType ?? "unknown";
    return terminate({
      published: false,
      built: true,
      reason: "non-deployable-environment",
      environmentType,
      topic: ctx.shared.get("topic") || "",
      title: ctx.shared.get("reportTitle") ?? null,
      tagline: ctx.shared.get("reportTagline") ?? "",
      sources: ctx.shared.get("sources") ?? [],
      sandboxName: ctx.shared.get("sandboxName") ?? null,
      note: [
        `The coding agent built the site, but its run executed in a "${environmentType}" environment, which can't be preview-deployed. On the deployed Sapiom stack, coding runs use a compatible cloud environment and this step publishes a live *preview* URL (short-lived — the platform recycles the sandbox process; durable hosting is tracked in SAP-2211).`,
        ctx.shared.get("note"),
      ]
        .filter(Boolean)
        .join(" "),
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "research-to-microsite",
  entry: "plan",
  steps: {
    plan,
    gather,
    synthesize,
    critique,
    illustrate,
    collectIllustration,
    build,
    publish,
    mapDomain,
    live,
    failed,
    drafted,
    builtNotPublished,
  },
});
