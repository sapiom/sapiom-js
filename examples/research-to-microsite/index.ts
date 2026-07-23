import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";

/**
 * Research → Micro-Site Publisher — deep multi-source research that ends in a
 * shareable LIVE site, not a document.
 *
 * It searches the web for a topic, reads the top sources for full text, has an
 * LLM synthesize them into a structured, cited report, then hands that report to
 * a coding agent that builds a self-contained static site. The site is deployed
 * to a public preview URL, and — if you point a Sapiom-owned domain at it — mapped
 * onto a custom subdomain. The output is a URL you can send someone.
 *
 * The graph, one legible line per capability:
 *   search (web.search) ─▶ scrape (web.scrape) ─▶ synthesize (models.run)
 *     ─▶ build (models.coding) ─▶ publish (sandboxes.deployPreview)
 *     ─▶ mapDomain (domains.dns) ─▶ live
 *
 * Async pause/resume: `build` LAUNCHES the coding agent and suspends on its result
 * signal (a coding run takes minutes), so the run costs nothing while the agent
 * works and resumes at `publish` when it finishes — the same durable machinery
 * `scene-to-video` uses for video jobs.
 *
 * Side-effect discipline:
 *   - `dryRun` gates every irreversible/billed step after research: it computes
 *     the report and returns it via the `drafted` off-ramp WITHOUT building,
 *     deploying, or touching DNS. `run_local` uses this to trace
 *     search → scrape → synthesize offline (capabilities stubbed) for free before
 *     a billed deploy. The coding-agent build, the sandbox deploy, and their cost
 *     are only exercised on the deployed path.
 *   - The custom domain is optional. With none set, the preview URL IS the
 *     deliverable; `mapDomain` is skipped. Mapping assumes you already OWN the
 *     domain in Sapiom (`ctx.sapiom.domains`); DNS record creation is free.
 *   - Scraped bodies are bounded and die at the `synthesize` boundary — only slim
 *     report metadata (title, sources) rides shared state to the terminal.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** How many search hits to consider as scrape candidates. */
const MAX_CANDIDATES = 6;
/** How many candidates to actually scrape (keeps latency + cost bounded). */
const MAX_SCRAPES = 5;
/** Truncate each scraped body — the ONLY large data on the search→synthesize path. */
const MAX_BODY_CHARS = 1500;
/** Cap sections the report (and thus the built site) carries. */
const MAX_SECTIONS = 6;
/** Truncate each section body handed to the coding agent, to bound the task size. */
const MAX_SECTION_CHARS = 1200;
/** Default host on the custom domain when the caller doesn't pass one. */
const DEFAULT_SUBDOMAIN = "www";
/** Build/start config for the static site the coding agent produces. */
const SITE_PORT = 3000;
const SITE_START = "node server.js";

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
   * Compute the report and return it as a preview, skipping the build, deploy,
   * and DNS. `run_local` passes this to trace the graph offline for free.
   */
  dryRun?: boolean;
}

/** Slim search hit carried across the search → scrape boundary. */
interface Candidate {
  title: string;
  url: string;
  snippet: string;
}

/** A candidate plus its (bounded) scraped body — the scrape → synthesize payload. */
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

interface Shared extends Record<string, unknown> {
  topic: string;
  audience: string;
  customDomain: string | null;
  subdomain: string;
  dryRun: boolean;
  /** Slim report metadata for the terminal to report (bodies stay off shared state). */
  reportTitle: string;
  reportTagline: string;
  sources: Source[];
  /** The sandbox the coding agent built in, captured on resume for the terminal. */
  sandboxName: string | null;
  /** The live preview URL, once deployed. */
  liveUrl: string | null;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
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

/**
 * The coding-agent instruction: build a self-contained static site from the
 * report. It asks for exactly two files at the workspace root — `index.html`
 * (inline CSS, no external assets) and a zero-dependency `server.js` — so the
 * deploy needs no build step and `node server.js` serves the site as-is.
 */
function buildSiteTask(report: Report): string {
  return [
    "Build a single-page static website that presents the research report below as a polished, shareable micro-site.",
    "",
    "Create exactly these two files at the workspace root:",
    "- `index.html`: a self-contained page (all CSS inline in a <style> tag, NO external stylesheets, fonts, scripts, or CDNs). Render a hero with the report title and tagline, then the summary, then each section as its own block, then a 'Sources' list whose entries are clickable links. Make it clean, readable, and responsive; use a system-font stack and generous spacing.",
    "- `server.js`: a zero-dependency Node HTTP server (only the built-in `http`/`fs`/`path` modules) that serves files from its own directory, defaults to `index.html`, sets a sensible Content-Type, and listens on `process.env.PORT || 3000` bound to host `0.0.0.0`.",
    "",
    "Do NOT create a package.json, add dependencies, or introduce a build step — `node server.js` must start the finished site directly.",
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
const search = defineStep({
  name: "search",
  next: ["scrape"],
  async run(input: EntryInput, ctx: Ctx) {
    const topic = input.topic?.trim() ?? "";
    ctx.shared.set("topic", topic);
    ctx.shared.set("audience", input.audience?.trim() || "a general audience");
    ctx.shared.set("customDomain", input.customDomain?.trim() || null);
    ctx.shared.set("subdomain", input.subdomain?.trim() || DEFAULT_SUBDOMAIN);
    ctx.shared.set("dryRun", input.dryRun === true);
    ctx.shared.set("sandboxName", null);
    ctx.shared.set("liveUrl", null);

    if (!topic) {
      // Nothing to research — forward an empty candidate list so the graph still
      // traces end to end (and `synthesize` yields an empty report).
      return goto("scrape", { candidates: [] as Candidate[] });
    }

    ctx.logger.info("searching the web", { topic });
    const hits = await ctx.sapiom.search.webSearch({
      query: topic,
      intent: "links",
    });
    const candidates: Candidate[] = (hits?.results ?? [])
      .slice(0, MAX_CANDIDATES)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    ctx.logger.info("search returned candidates", { count: candidates.length });
    return goto("scrape", { candidates });
  },
});

const scrape = defineStep({
  name: "scrape",
  next: ["synthesize"],
  async run(input: { candidates: Candidate[] }, ctx: Ctx) {
    const candidates = input.candidates ?? [];
    const sources: ScrapedSource[] = [];
    let scraped = 0;
    for (const c of candidates) {
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
  next: ["build", "drafted"],
  async run(input: { sources: ScrapedSource[] }, ctx: Ctx) {
    const topic = ctx.shared.get("topic") || "your topic";
    const audience = ctx.shared.get("audience") || "a general audience";
    const scraped = input.sources ?? [];
    // Slim references only — the scraped bodies stop here and never reach shared
    // state or the coding agent's task beyond the synthesis prompt.
    const sources: Source[] = scraped.map((s) => ({
      title: s.title,
      url: s.url,
    }));

    let report: Report;
    if (scraped.length === 0) {
      report = {
        title: `${topic}`,
        tagline: "",
        summary: `No sources were found for "${topic}".`,
        sections: [],
        sources,
      };
    } else {
      const research = scraped
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title} (${s.url})\n${(s.content || s.snippet).slice(0, MAX_BODY_CHARS)}`,
        )
        .join("\n\n");
      // The live, x402-served model turns the raw sources into a structured,
      // cited report — the content the site renders.
      const res = await ctx.sapiom.models.run({
        system:
          "You are a research analyst producing a structured report for a web " +
          "micro-site. Given a TOPIC, an AUDIENCE, and numbered web SOURCES " +
          "(each: [n] title, url, extracted text), write a report and output " +
          "ONLY a JSON object (no prose, no code fences) with this shape: " +
          '{ "title": string, "tagline": string (one line), "summary": string ' +
          '(2-4 sentences), "sections": [{ "heading": string, "body": string }] }. ' +
          `Use 3 to ${MAX_SECTIONS} sections. Each section body is markdown and ` +
          "cites the sources it draws on as [n] references. Rank by relevance and " +
          "credibility; drop thin or duplicate material. Tune the tone for the AUDIENCE.",
        prompt: `TOPIC: ${topic}\nAUDIENCE: ${audience}\n\nSOURCES:\n${research}`,
        maxTokens: 1500,
      });
      report = parseReport(res?.output ?? "", topic, sources);
    }

    // Slim report metadata rides shared state to the terminal; the full section
    // bodies travel to the coding agent via the goto payload only.
    ctx.shared.set("reportTitle", report.title);
    ctx.shared.set("reportTagline", report.tagline);
    ctx.shared.set("sources", report.sources);
    ctx.logger.info("synthesized report", {
      title: report.title,
      sections: report.sections.length,
      sources: report.sources.length,
    });

    // Dry run (and `run_local`): return the report as a preview without building
    // or deploying anything.
    if (ctx.shared.get("dryRun") === true) {
      return goto("drafted", { report });
    }
    return goto("build", { report });
  },
});

const build = defineStep({
  name: "build",
  next: [],
  // Async pause/resume: the launched coding run fires CODING_RESULT_SIGNAL when it
  // reaches a terminal state, resuming `publish` with the run's result. The run
  // costs nothing while the agent works.
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "publish" },
  async run(input: { report: Report }, ctx: Ctx) {
    const report = input.report;
    ctx.logger.info("launching coding agent to build the site", {
      title: report.title,
      sections: report.sections.length,
    });
    // Launch without a repo or sandbox: the run provisions a fresh sandbox and
    // writes the site into it. `publish` re-attaches that sandbox on resume.
    const handle = await ctx.sapiom.models.coding.launch({
      task: buildSiteTask(report),
    });
    return await pauseUntilSignal(handle, { resumeStep: "publish" });
  },
});

const publish = defineStep({
  name: "publish",
  next: ["mapDomain", "live", "failed"],
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

    const sandboxName = result.executionEnvironment.id;
    ctx.shared.set("sandboxName", sandboxName);
    ctx.logger.info("deploying the built site", { sandbox: sandboxName });

    let deploy: { url: string | null; status: string; logs: string };
    try {
      const box = ctx.sapiom.sandboxes.attach(sandboxName);
      deploy = await box.deployPreview({
        // source defaults to { kind: "fs" } — the files the coding agent wrote.
        start: SITE_START,
        port: SITE_PORT,
      });
    } catch (err) {
      ctx.logger.error("deployPreview threw", {
        sandbox: sandboxName,
        err: String(err),
      });
      return goto("failed", { stage: "deploy", logs: String(err) });
    }

    if (deploy.status === "failed" || !deploy.url) {
      return goto("failed", { stage: "deploy", logs: deploy.logs });
    }
    ctx.shared.set("liveUrl", deploy.url);
    ctx.logger.info("site is live", { url: deploy.url, status: deploy.status });

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
    return terminate({
      published: true,
      topic,
      title: ctx.shared.get("reportTitle") ?? topic,
      tagline: ctx.shared.get("reportTagline") ?? "",
      liveUrl: input.liveUrl,
      customUrl: input.customUrl ?? null,
      sandboxName: ctx.shared.get("sandboxName") ?? null,
      sources: ctx.shared.get("sources") ?? [],
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
  async run(input: { report: Report }, ctx: Ctx) {
    // The dry-run / run_local off-ramp: the report was computed but nothing was
    // built, deployed, or mapped.
    return terminate({
      published: false,
      dryRun: true,
      topic: ctx.shared.get("topic") || "",
      report: input.report,
    });
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "research-to-microsite",
  entry: "search",
  steps: {
    search,
    scrape,
    synthesize,
    build,
    publish,
    mapDomain,
    live,
    failed,
    drafted,
  },
});
