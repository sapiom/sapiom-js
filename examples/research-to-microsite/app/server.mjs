// =============================================================================
// Report site dashboard: the page this template ships beside its agent.
//
// One dependency-free Node server (`node server.mjs`, no build step) that serves
// `index.html`, one JSON route, `/api/run`, and the captured run's built site at
// `/sample/site.html`. `/api/run` carries the latest completed run: its terminal
// output (the live URL, title, sources, and self-critique score), the two
// verdicts the self-critique loop wrote (the rationale that sent a draft back,
// and the one the published draft cleared the bar with), the report itself, and
// whether the live URL still answers. The page renders that and nothing else.
//
// The site the agent publishes is not this page. A coding agent generates it
// into its own git repo at run time, so there is no source for it here, and its
// preview host is recycled unless an uptime keeper was registered. This page is
// the view of the run around that site: did it pass review, what did it cite,
// is it still up.
//
// Two data sources, chosen by environment:
//
//   live      SAPIOM_API_KEY + SAPIOM_DEFINITION_ID are set. The latest completed
//             run of that deployed agent is read over the Sapiom API and cached
//             for a short while. The publish step that puts this dashboard on an
//             App Link is expected to inject both (SAPIOM_API_URL optional,
//             defaults to production). The page frames the run's live URL when
//             it answers `/health`.
//   captured  Either is missing, or the live read fails. `sample-run.json` is
//             served instead: a real zero-setup run of this template (its
//             terminal output verbatim, plus the self-critique fields and report outline from its
//             shared state), with the page that run built, copied verbatim from
//             its git repo (`sample/site.json`: repo, commit, and the HTML), so
//             the page is never empty and never invented. The HTML is kept in a
//             JSON record rather than an .html file because it is the model's
//             research prose, quoting third-party names, not this template's
//             own copy.
//
// The response always says which (`source.kind`) and what the frame shows
// (`site.kind`); the page prints both.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4179;
const API_URL = (process.env.SAPIOM_API_URL || "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY || "";
const DEFINITION_ID = process.env.SAPIOM_DEFINITION_ID || "";
const LIVE_CACHE_MS = 30_000;
const PROBE_CACHE_MS = 60_000;

/** Where the captured run's built site is served from. */
const SAMPLE_SITE_PATH = "/sample/site.html";

/**
 * The key travels in a header, so the API must be reached over TLS, except a
 * loopback address, which is where a local Sapiom backend lives. A plain-http
 * remote URL is refused rather than used: live mode is simply off, and the
 * page shows the captured run with the reason in its footer.
 */
function apiUrlIsSafe(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return true;
    return (
      protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)
    );
  } catch {
    return false;
  }
}
const LIVE_CONFIG_ERROR =
  API_KEY && DEFINITION_ID && !apiUrlIsSafe(API_URL)
    ? `SAPIOM_API_URL must be https (or a loopback address); refusing to send the API key to ${API_URL}`
    : null;
const LIVE = Boolean(API_KEY && DEFINITION_ID) && !LIVE_CONFIG_ERROR;

/**
 * The captured run, read once; it never changes while the server is up. The
 * rejection is observed here so a missing or corrupt file cannot surface as an
 * unhandled rejection before the first request; the request handler turns it
 * into a 500 instead.
 */
const sample = readFile(path.join(HERE, "sample-run.json"), "utf8").then(
  (text) => JSON.parse(text),
);
sample.catch(() => {});

let liveCache = { at: 0, value: null };
const probeCache = new Map();

async function api(route) {
  const res = await fetch(`${API_URL}${route}`, {
    headers: { "x-api-key": API_KEY, accept: "application/json" },
    // A redirect would carry the key to whatever origin the Location names.
    // The API does not redirect its JSON routes, so a 3xx is treated as a
    // failure (`ok` is false for it) rather than followed.
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Only an https link is handed to the page to frame or link: the run's
 * `liveUrl` is one, and anything else would be a mixed-content block or an
 * injection sink rather than a site.
 */
function httpsOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Does the published site still answer? The agent's generated server exposes
 * `/health`, and the host is recycled unless a keeper was registered, so this
 * is the difference between a working link and a dead one. No credentials go
 * with the request; the result is cached so a page refresh does not re-probe.
 */
async function probe(siteUrl) {
  const hit = probeCache.get(siteUrl);
  if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.value;
  let value;
  try {
    const res = await fetch(new URL("/health", siteUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    value = { reachable: res.ok, status: res.status };
  } catch (err) {
    value = {
      reachable: false,
      status: null,
      error: String(err?.message ?? err),
    };
  }
  probeCache.set(siteUrl, { at: Date.now(), value });
  return value;
}

/**
 * One execution record (the API's run detail, or the captured copy of one) in
 * the shape the page renders. Both sources go through here, so the captured
 * page and a live one cannot drift apart.
 */
function summarize(run) {
  const output = run.output ?? {};
  const shared = run.sharedState ?? {};
  const report = shared.report ?? output.report ?? null;
  const iterations = Number(output.reviewIterations ?? 0) || null;
  return {
    output,
    audience: shared.audience ?? null,
    review: {
      score: output.reviewScore ?? null,
      passed: output.reviewPassed ?? null,
      iterations,
      threshold: shared.reviewThreshold ?? null,
      maxDraftAttempts: shared.maxDraftAttempts ?? null,
      // `critique` is written only when a draft is sent back for revision, so
      // it belongs to the draft before the one that was published.
      rejected: iterations && iterations > 1 ? (shared.critique ?? null) : null,
      final: shared.reviewNote ?? null,
    },
    report: report
      ? {
          summary: report.summary ?? "",
          sections: Array.isArray(report.sections)
            ? report.sections.map((s) => ({ heading: s?.heading ?? "" }))
            : [],
        }
      : null,
    illustrated: Array.isArray(shared.illustrations)
      ? shared.illustrations.map((i) => i?.heading).filter(Boolean)
      : [],
  };
}

async function withSite(value, fallbackFrame) {
  const liveUrl = httpsOrNull(value.run.output.liveUrl);
  const health = liveUrl ? await probe(liveUrl) : null;
  const site = {
    liveUrl,
    customUrl: httpsOrNull(value.run.output.customUrl),
    health,
    // What the page's frame shows: the live site when it answers, otherwise
    // the captured run's own copy of it, otherwise nothing (the page then
    // shows the report's outline instead).
    kind: health?.reachable ? "live" : fallbackFrame ? "copy" : null,
    frameUrl: health?.reachable ? liveUrl : fallbackFrame,
  };
  return { ...value, site };
}

/**
 * Latest completed run of the bound agent, as `{ source, run, site }`. Throws
 * on any failure so the caller can fall back; the failure text (never the key)
 * travels to the page as `source.liveError`.
 */
async function readLive() {
  const now = Date.now();
  if (liveCache.value && now - liveCache.at < LIVE_CACHE_MS)
    return liveCache.value;

  const query = new URLSearchParams({
    definitionId: DEFINITION_ID,
    status: "completed",
    limit: "1",
  });
  const [latest] = await api(`/v1/workflows/executions?${query}`);
  if (!latest) throw new Error("no completed run yet");
  const run = await api(
    `/v1/workflows/executions/${encodeURIComponent(latest.id)}`,
  );
  if (!run || typeof run !== "object" || run.output == null) {
    throw new Error(`run ${latest.id} has no output`);
  }
  // A dry run completes with the report and no site: `liveUrl` is then absent
  // and the page shows the report's outline where the site would be.
  const value = await withSite(
    {
      source: {
        kind: "live",
        executionId: String(run.id),
        definitionId: String(run.definitionId ?? DEFINITION_ID),
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
      },
      run: summarize(run),
    },
    null,
  );
  liveCache = { at: now, value };
  return value;
}

async function readCaptured(liveError) {
  const run = await sample;
  return withSite(
    {
      source: {
        kind: "captured",
        executionId: String(run.id),
        definitionId: String(run.definitionId),
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        repoSlug: run.output?.repoSlug ?? null,
        ...(liveError && { liveError }),
      },
      run: summarize(run),
    },
    SAMPLE_SITE_PATH,
  );
}

async function latestRun() {
  if (!LIVE) return readCaptured(LIVE_CONFIG_ERROR);
  try {
    return await readLive();
  } catch (err) {
    return readCaptured(String(err?.message ?? err));
  }
}

// Same observed-rejection pattern as `sample`: a missing file is a 500 on its
// route, not a crash at startup.
const page = readFile(path.join(HERE, "index.html"));
page.catch(() => {});
const sampleSite = readFile(
  path.join(HERE, "sample", "site.json"),
  "utf8",
).then((text) => JSON.parse(text).html);
sampleSite.catch(() => {});

const server = createServer(async (req, res) => {
  try {
    // Only the pathname is read, so the base is fixed: parsing against the
    // request's own Host header would let a malformed one throw here, and this
    // listener is async, so an exception outside `try` is an unhandled
    // rejection, not a 500.
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/run") {
      const body = JSON.stringify(await latestRun());
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await page);
      return;
    }
    if (url.pathname === SAMPLE_SITE_PATH) {
      // Generated markup, framed by the page: no scripts may run in it, so the
      // policy says so even if the frame's sandbox attribute were dropped.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; img-src https:; style-src 'unsafe-inline'; frame-ancestors 'self'",
        "cache-control": "public, max-age=3600",
      });
      res.end(await sampleSite);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dashboard error: ${String(err?.message ?? err)}`);
  }
});

server.listen(PORT, () => {
  if (LIVE_CONFIG_ERROR) console.warn(LIVE_CONFIG_ERROR);
  const mode = LIVE ? "live" : "captured";
  console.log(`report site dashboard on http://localhost:${PORT} (${mode})`);
});
