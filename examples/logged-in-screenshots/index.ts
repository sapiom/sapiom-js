import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

/**
 * Website QA Crawler — point it at a site and it crawls a bounded set of
 * pages, checks that each one renders, audits the content and structure with
 * a model, and checks link integrity — including whether Terms and Privacy
 * links exist and resolve — then compiles a QA report with screenshots and a
 * plain list of what's broken.
 *
 * The graph, one legible line per capability:
 *   crawl (web.scrape) ─▶ render (browser.session) ─▶ audit (llm.run)
 *     ─▶ linkCheck (compute) ─▶ report (terminal)
 *   crawl ─────────────────────────────────────────▶ rejected (terminal),
 *     when `siteUrl` isn't a usable URL
 *
 * `crawl` reads the homepage's markdown and links
 * (`ctx.sapiom.search.scrape`), picks a bounded set of internal pages to
 * check — prioritizing whatever looks like a Terms or Privacy link, so link
 * integrity always gets a real answer when one exists rather than getting
 * crowded out by the cap — and reads each page's markdown. `render` opens ONE
 * browser session (`ctx.sapiom.browserAutomation.withSession`) and
 * screenshots every page in it, so a page that renders blank or errors shows
 * up as a row, not a silent gap. `audit` asks a model
 * (`ctx.sapiom.llm.run`) to read the crawled content across every page in
 * one call and flag concrete issues — broken-looking or placeholder text,
 * thin sections, missing or duplicate titles. `linkCheck` turns the
 * already-collected data into a link-integrity verdict: which pages didn't
 * resolve, and whether Terms and Privacy are present and resolve. `report`
 * compiles everything — screenshots, content findings, and link integrity —
 * into one QA report.
 *
 * Never-fail discipline:
 *   - Runs with nothing: crawls `https://sapiom.ai`, so a zero-input run is a
 *     genuine crawl of a real, stable target rather than a placeholder host.
 *   - Bounded, always: at most `MAX_PAGES` pages total (homepage plus a
 *     handful more), so cost and runtime are capped regardless of how large
 *     the target site is.
 *   - A page that fails to crawl, render, or resolve becomes a row or a
 *     finding, never a thrown error — the run always reaches the report.
 *   - The report never claims a page is fine because it wasn't checked: only
 *     pages the run actually crawled and rendered show up as passing.
 */

// ─────────────────────────────────────────────────────────────── config ──
/** Cap how many pages one run crawls (including the homepage). */
const MAX_PAGES = 5;
/** Truncate each crawled page's markdown before it reaches the model prompt. */
const MAX_MARKDOWN_CHARS = 1500;
/** The site a zero-input run QA-checks — our own, so the crawl is genuine. */
const DEFAULT_SITE = "https://sapiom.ai";

/** Matches a homepage link that looks like a Terms of Service page. */
const TERMS_RE = /\bterms\b|\btos\b/i;
/** Matches a homepage link that looks like a Privacy Policy page. */
const PRIVACY_RE = /\bprivacy\b/i;

// ─────────────────────────────────────────────────────────────── shapes ──
interface EntryInput {
  /** The site to crawl and QA-check. Defaults to our own site. */
  siteUrl?: string;
}

/** One crawled page — markdown content plus whether it resolved. */
interface CrawledPage {
  url: string;
  ok: boolean;
  statusCode: number | null;
  title: string | null;
  /** Truncated markdown; empty when the page couldn't be read. */
  markdown: string;
  error: string | null;
}

/** One page's render-check result. */
interface RenderShot {
  url: string;
  imageUrl: string | null;
  expiresAt: string | null;
  rendered: boolean;
  error: string | null;
}

/** One content/structure problem the model found on a page. */
interface ContentFinding {
  url: string;
  issue: string;
  severity: "low" | "medium" | "high";
}

/** Whether a legal page (Terms or Privacy) was found on the homepage, and resolves. */
interface LegalLinkStatus {
  present: boolean;
  url: string | null;
  resolved: boolean;
}

/** One row in the final report's flat issue list. */
interface Issue {
  type:
    | "broken-page"
    | "render-failed"
    | "content"
    | "legal-missing"
    | "legal-broken";
  url: string | null;
  detail: string;
  severity?: "low" | "medium" | "high";
}

interface Shared extends Record<string, unknown> {
  siteUrl: string;
  legalLinks: { terms: string | null; privacy: string | null };
  discoveredLinkCount: number;
  /** Set when the run crawled the default site rather than the caller's. */
  note?: string;
}

type Ctx = AgentExecutionContext<Shared>;

// ─────────────────────────────────────────────────────────────── helpers ──
/** Same-origin links from a homepage scrape, de-duped and hash-stripped. */
function sameOriginLinks(links: string[] | undefined, origin: URL): string[] {
  const out = new Set<string>();
  for (const raw of links ?? []) {
    try {
      const u = new URL(raw, origin);
      if (u.origin !== origin.origin) continue;
      u.hash = "";
      const normalized = u.toString();
      if (normalized === origin.toString()) continue;
      out.add(normalized);
    } catch {
      // Malformed href on the page — skip it rather than fail the crawl.
    }
  }
  return [...out];
}

/**
 * The bounded set of extra pages (beyond the homepage) a run crawls. Legal
 * candidates go first, so link integrity gets a real Terms/Privacy answer
 * whenever one exists instead of losing the slot to an unrelated page; the
 * rest of the cap fills in with whatever else was discovered.
 */
function selectExtraPages(
  candidates: string[],
  legal: { terms: string | null; privacy: string | null },
  max: number,
): string[] {
  const budget = max - 1; // the homepage always takes one slot
  if (budget <= 0) return [];
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const u of [legal.terms, legal.privacy]) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    chosen.push(u);
  }
  for (const u of candidates) {
    if (chosen.length >= budget) break;
    if (seen.has(u)) continue;
    seen.add(u);
    chosen.push(u);
  }
  return chosen.slice(0, budget);
}

/** A crawled page's row from a successful scrape — a non-2xx status is a failure, not a throw. */
function pageFromScrape(
  url: string,
  res: {
    markdown?: string;
    metadata?: { statusCode?: number; title?: string };
  },
): CrawledPage {
  const statusCode = res.metadata?.statusCode ?? null;
  const ok = statusCode === null || statusCode < 400;
  return {
    url,
    ok,
    statusCode,
    title: res.metadata?.title ?? null,
    markdown: ok ? (res.markdown ?? "").slice(0, MAX_MARKDOWN_CHARS) : "",
    error: ok ? null : `page returned HTTP ${statusCode}`,
  };
}

/** A crawled page's row when the scrape itself threw. */
function pageFromError(url: string, err: unknown): CrawledPage {
  return {
    url,
    ok: false,
    statusCode: null,
    title: null,
    markdown: "",
    error: String(err),
  };
}

/** Whether a discovered legal link resolved, given the pages we crawled. */
function legalStatus(
  url: string | null,
  pages: CrawledPage[],
): LegalLinkStatus {
  if (!url) return { present: false, url: null, resolved: false };
  const page = pages.find((p) => p.url === url);
  return { present: true, url, resolved: page?.ok === true };
}

// ───────────────────────────────────────────────────────── model reasoning ──
/**
 * Ask the model to read the crawled pages in one call and flag concrete
 * content/structure issues. Parsed defensively — a malformed or empty reply
 * degrades to no findings rather than throwing, so the report still compiles.
 */
async function runContentAudit(
  ctx: Ctx,
  pages: CrawledPage[],
): Promise<ContentFinding[]> {
  const withContent = pages.filter((p) => p.ok && p.markdown.trim().length > 0);
  if (withContent.length === 0) return [];

  const evidence = withContent
    .map((p, i) => `[${i + 1}] ${p.title ?? p.url} (${p.url})\n${p.markdown}`)
    .join("\n\n");
  const system =
    "You are a website QA reviewer. Given the crawled MARKDOWN content of " +
    "several pages on one site, find concrete content and structure " +
    "problems: missing or duplicate titles, broken-looking or placeholder " +
    "text (e.g. lorem ipsum), thin or empty sections, inconsistent heading " +
    "structure, or anything a visitor would consider unfinished. Cite the " +
    "page url for every issue. If a page has no real problem, don't invent " +
    "one for it — an empty list is a valid answer.";
  const res = await ctx.sapiom.llm.run({
    request: {
      system,
      messages: [{ role: "user", content: `PAGES:\n${evidence}` }],
      max_tokens: 8000,
    },
    output: { name: AUDIT_TOOL, schema: AUDIT_SCHEMA },
  });
  return readFindings(ctx.sapiom.llm.structuredOf(res, AUDIT_TOOL));
}

/**
 * The forced tool call `audit` reads its findings out of. `llm.run`'s `output`
 * appends this tool to the request and pins `tool_choice` to it, so the
 * findings arrive as a typed `tool_use` block — there is no prose to slice and
 * no JSON to hand-parse.
 */
const AUDIT_TOOL = "emit_content_findings";

const AUDIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The page url the issue is on.",
          },
          issue: {
            type: "string",
            description: "The concrete content or structure problem.",
          },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["url", "issue", "severity"],
        additionalProperties: false,
      },
      description:
        "Every real problem found, one entry each. An empty list is a valid answer.",
    },
  },
  required: ["issues"],
  additionalProperties: false,
};

/**
 * Read the forced tool call back into the audit's findings.
 *
 * An empty `issues` list is a real answer here — the prompt says so, and a
 * clean site should produce one. Which is exactly why a missing list has to
 * throw: `[]` from a failed read is indistinguishable from a clean bill of
 * health, and this template's whole output is "here is what's wrong with your
 * site".
 */
export function readFindings(structured: unknown): ContentFinding[] {
  if (structured === null || typeof structured !== "object") {
    throw new Error(
      "audit: the model returned no structured findings — refusing to report the site as clean.",
    );
  }
  const issues = (structured as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    throw new Error(
      "audit: the model returned no issue list — refusing to report the site as clean.",
    );
  }
  return issues
    .map(coerceFinding)
    .filter((f): f is ContentFinding => f !== null);
}

function coerceFinding(entry: unknown): ContentFinding | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const issue = typeof e.issue === "string" ? e.issue.trim() : "";
  if (!issue) return null;
  const url = typeof e.url === "string" ? e.url : "";
  const severity =
    e.severity === "high" || e.severity === "medium" ? e.severity : "low";
  return { url, issue, severity };
}

// ─────────────────────────────────────────────────────────────── steps ──
/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled field from. `siteUrl` carries the sample as
 * its `.default(...)`, so a zero-input run crawls a real target.
 */
const entryInput = z.object({
  siteUrl: z
    .string()
    .default(DEFAULT_SITE)
    .describe("The site to crawl and QA-check."),
});

const crawl = defineStep({
  name: "crawl",
  inputSchema: entryInput,
  next: ["render", "rejected"],
  async run(input: EntryInput, ctx: Ctx) {
    const raw = input.siteUrl?.trim() || DEFAULT_SITE;
    let origin: URL;
    try {
      origin = new URL(raw);
    } catch {
      return goto("rejected", {
        reason: `\`siteUrl\` is not a valid URL: "${raw}"`,
      });
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return goto("rejected", {
        reason: `\`siteUrl\` must be http or https: "${raw}"`,
      });
    }

    const siteUrl = origin.toString();
    ctx.shared.set("siteUrl", siteUrl);
    if (raw === DEFAULT_SITE) {
      ctx.shared.set(
        "note",
        `Crawled the default site ("${DEFAULT_SITE}"). Pass a \`siteUrl\` to QA-check yours.`,
      );
    }

    // The homepage read is the one call that can't degrade to a row — if the
    // target itself is unreachable there is nothing to crawl, render, or audit.
    let home;
    try {
      home = await ctx.sapiom.search.scrape({
        url: siteUrl,
        formats: ["markdown", "links"],
      });
    } catch (err) {
      return goto("rejected", {
        reason: `could not reach ${siteUrl}: ${String(err)}`,
      });
    }

    const links = sameOriginLinks(home.links, origin);
    const legal = {
      terms: links.find((u) => TERMS_RE.test(u)) ?? null,
      privacy: links.find((u) => PRIVACY_RE.test(u)) ?? null,
    };
    ctx.shared.set("legalLinks", legal);
    ctx.shared.set("discoveredLinkCount", links.length);

    const pages: CrawledPage[] = [pageFromScrape(siteUrl, home)];
    const extraUrls = selectExtraPages(links, legal, MAX_PAGES);
    for (const url of extraUrls) {
      try {
        const page = await ctx.sapiom.search.scrape({
          url,
          formats: ["markdown"],
        });
        pages.push(pageFromScrape(url, page));
      } catch (err) {
        ctx.logger.warn("page crawl failed", { url, err: String(err) });
        pages.push(pageFromError(url, err));
      }
    }

    ctx.logger.info("crawl complete", {
      pages: pages.length,
      discoveredLinks: links.length,
      termsFound: legal.terms !== null,
      privacyFound: legal.privacy !== null,
    });
    return goto("render", { pages });
  },
});

const render = defineStep({
  name: "render",
  next: ["audit"],
  async run(input: { pages: CrawledPage[] }, ctx: Ctx) {
    const pages = input.pages ?? [];

    let shots: RenderShot[];
    try {
      // One session, every page — in-session screenshots carry no per-shot
      // charge, and `withSession` always closes in a `finally`.
      shots = await ctx.sapiom.browserAutomation.withSession(
        async (session) => {
          const out: RenderShot[] = [];
          for (const p of pages) {
            try {
              const shot = await session.screenshot({ url: p.url });
              out.push({
                url: p.url,
                imageUrl: shot.url,
                expiresAt: shot.expiresAt ?? null,
                rendered: true,
                error: null,
              });
            } catch (err) {
              // A page that fails to render is a row, not a lost run — the
              // rest of the session keeps going.
              ctx.logger.warn("page render failed", {
                url: p.url,
                err: String(err),
              });
              out.push({
                url: p.url,
                imageUrl: null,
                expiresAt: null,
                rendered: false,
                error: String(err),
              });
            }
          }
          return out;
        },
      );
    } catch (err) {
      // The session itself could not open — every requested page is recorded
      // as a render failure so the run still reaches a complete report.
      ctx.logger.error("browser session failed to open", { err: String(err) });
      shots = pages.map((p) => ({
        url: p.url,
        imageUrl: null,
        expiresAt: null,
        rendered: false,
        error: String(err),
      }));
    }

    ctx.logger.info("render check complete", {
      pages: pages.length,
      rendered: shots.filter((s) => s.rendered).length,
    });
    return goto("audit", { pages, shots });
  },
});

const audit = defineStep({
  name: "audit",
  next: ["linkCheck"],
  async run(input: { pages: CrawledPage[]; shots: RenderShot[] }, ctx: Ctx) {
    const { pages, shots } = input;
    let findings: ContentFinding[];
    try {
      findings = await runContentAudit(ctx, pages);
    } catch (err) {
      // The audit is a judgment call, not a requirement to reach the report —
      // a model failure degrades to no findings rather than failing the run.
      ctx.logger.warn("content audit failed", { err: String(err) });
      findings = [];
    }
    ctx.logger.info("content audit complete", { findings: findings.length });
    return goto("linkCheck", { pages, shots, findings });
  },
});

const linkCheck = defineStep({
  name: "linkCheck",
  next: ["report"],
  async run(
    input: {
      pages: CrawledPage[];
      shots: RenderShot[];
      findings: ContentFinding[];
    },
    ctx: Ctx,
  ) {
    const { pages, shots, findings } = input;
    const legalLinks = ctx.shared.get("legalLinks") ?? {
      terms: null,
      privacy: null,
    };
    const brokenPages = pages
      .filter((p) => !p.ok)
      .map((p) => ({ url: p.url, error: p.error ?? "unreachable" }));
    const legal = {
      terms: legalStatus(legalLinks.terms, pages),
      privacy: legalStatus(legalLinks.privacy, pages),
    };

    ctx.logger.info("link integrity checked", {
      brokenPages: brokenPages.length,
      termsResolved: legal.terms.resolved,
      privacyResolved: legal.privacy.resolved,
    });
    return goto("report", { pages, shots, findings, brokenPages, legal });
  },
});

const report = defineStep({
  name: "report",
  next: [],
  terminal: true,
  async run(
    input: {
      pages: CrawledPage[];
      shots: RenderShot[];
      findings: ContentFinding[];
      brokenPages: Array<{ url: string; error: string }>;
      legal: { terms: LegalLinkStatus; privacy: LegalLinkStatus };
    },
    ctx: Ctx,
  ) {
    const siteUrl = ctx.shared.get("siteUrl") ?? DEFAULT_SITE;
    const { pages, shots, findings, brokenPages, legal } = input;

    const issues: Issue[] = [
      ...brokenPages.map(
        (b): Issue => ({ type: "broken-page", url: b.url, detail: b.error }),
      ),
      ...shots
        .filter((s) => !s.rendered)
        .map(
          (s): Issue => ({
            type: "render-failed",
            url: s.url,
            detail: s.error ?? "did not render",
          }),
        ),
      ...findings.map(
        (f): Issue => ({
          type: "content",
          url: f.url,
          detail: f.issue,
          severity: f.severity,
        }),
      ),
      ...legalIssues("Terms of Service", legal.terms),
      ...legalIssues("Privacy Policy", legal.privacy),
    ];

    const note = ctx.shared.get("note");
    ctx.logger.info("QA report ready", {
      pagesChecked: pages.length,
      issues: issues.length,
    });
    return terminate(
      {
        site: siteUrl,
        pagesChecked: pages.length,
        screenshots: shots,
        legal,
        issues,
        ...(note ? { note } : {}),
      },
      issues.length > 0 ? { reason: "issues found" } : undefined,
    );
  },
});

/** The report's issue rows for one legal link — missing, broken, or none. */
function legalIssues(label: string, status: LegalLinkStatus): Issue[] {
  if (!status.present) {
    return [
      {
        type: "legal-missing",
        url: null,
        detail: `No ${label} link found on the homepage`,
      },
    ];
  }
  if (!status.resolved) {
    return [
      {
        type: "legal-broken",
        url: status.url,
        detail: `${label} link does not resolve`,
      },
    ];
  }
  return [];
}

const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(input: { reason?: string }, ctx: Ctx) {
    ctx.logger.info("crawl rejected", { reason: input?.reason });
    return terminate(
      { crawled: false, reason: input?.reason ?? "invalid site" },
      { reason: "rejected" },
    );
  },
});

export const agent = defineAgent<EntryInput, Shared>({
  name: "logged-in-screenshots",
  entry: "crawl",
  steps: {
    crawl,
    render,
    audit,
    linkCheck,
    report,
    rejected,
  },
});
