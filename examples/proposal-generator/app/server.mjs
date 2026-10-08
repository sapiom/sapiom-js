// =============================================================================
// Quote review dashboard: the page this template ships beside its agent.
//
// One dependency-free Node server (`node server.mjs`, no build step) that serves
// `index.html` and one JSON route, `/api/run`, carrying the latest completed
// run's terminal output (where the quote got to: waiting for sign-off, sent,
// rejected) together with the proposal that run drafted (title, summary, priced
// line items, totals, scope, terms) and the request it quoted. The page renders
// that and nothing else: every word and every number on screen came out of a
// run of the agent.
//
// The terminal output carries only the headline (title, total, quote number,
// PDF link), so the proposal itself is read from the run's shared state, where
// the `draft` step left it. Both arrive on the same execution read.
//
// Two data sources, chosen by environment:
//
//   live      SAPIOM_API_KEY + SAPIOM_DEFINITION_ID are set. The latest completed
//             run of that deployed agent is read over the Sapiom API and cached
//             for a short while. The publish step that puts this dashboard on an
//             App Link is expected to inject both (SAPIOM_API_URL optional,
//             defaults to production).
//   captured  Either is missing, or the live read fails. `sample-run.json` is
//             served instead: a real zero-setup run of this template, so the
//             page is never empty and never invented. Its PDF is served from
//             `sample/`.
//
// The response always says which (`source.kind`); the page prints it, so a
// reader can tell a live run from the captured one at a glance.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4182;
const API_URL = (process.env.SAPIOM_API_URL || "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY || "";
const DEFINITION_ID = process.env.SAPIOM_DEFINITION_ID || "";
const LIVE_CACHE_MS = 30_000;

/**
 * The captured run's PDF. Its own link was a short-lived presigned URL, so the
 * proposal is bundled here and served at a fixed path; nothing else under
 * `sample/` is reachable.
 */
const SAMPLE_PDF = "Q-158193.pdf";
const SAMPLE_PDF_ROUTE = `/sample/${SAMPLE_PDF}`;

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

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A link the page may put in an `href`: http(s) only, or the bundled sample. */
function safeLink(url) {
  if (typeof url !== "string" || !url) return null;
  if (url === SAMPLE_PDF_ROUTE) return url;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The proposal the run drafted and what happened to it, flattened out of the
 * run's shared state for the page. A run rejected before drafting (an empty
 * `request`) has no `draft`; `draft` is then null and the page says so.
 *
 * `sampleRequest` mirrors the agent: an omitted `request` drafts against the
 * built-in sample brief, which the shared state holds verbatim as `request`.
 */
function quoteOf(run) {
  const s = isObject(run.sharedState) ? run.sharedState : {};
  const o = isObject(run.output) ? run.output : {};
  const input = isObject(run.source?.input) ? run.source.input : {};
  const draft = isObject(s.draft) ? s.draft : null;
  const pdfUrl =
    run.source?.kind === "captured"
      ? SAMPLE_PDF_ROUTE
      : safeLink(o.downloadUrl ?? s.downloadUrl);
  return {
    request: typeof s.request === "string" ? s.request : null,
    sampleRequest: input.request === undefined,
    draft: draft && {
      title: typeof draft.title === "string" ? draft.title : null,
      summary: typeof draft.summary === "string" ? draft.summary : null,
      scope: Array.isArray(draft.scope) ? draft.scope.map(String) : [],
      terms: typeof draft.terms === "string" ? draft.terms : null,
      lineItems: Array.isArray(draft.lineItems)
        ? draft.lineItems.filter(isObject).map((li) => ({
            description: String(li.description ?? ""),
            quantity: Number(li.quantity) || 0,
            unitPrice: Number(li.unitPrice) || 0,
          }))
        : [],
    },
    totals: isObject(s.totals) ? s.totals : null,
    currency: s.currency ?? o.currency ?? "USD",
    taxRate: Number(s.taxRate) || 0,
    quoteNumber: o.quoteNumber ?? s.quoteNumber ?? null,
    client: isObject(s.client) ? s.client : {},
    from: isObject(s.from) ? s.from : {},
    approver: s.approver ?? null,
    recipientEmail: s.recipientEmail ?? null,
    pdfUrl,
  };
}

/**
 * Latest completed run of the bound agent, as `{ source, output, sharedState }`.
 * Throws on any failure so the caller can fall back; the failure text (never
 * the key) travels to the page as `source.liveError`.
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
  const value = {
    source: {
      kind: "live",
      executionId: String(run.id),
      definitionId: String(run.definitionId ?? DEFINITION_ID),
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      status: run.status ?? "completed",
      input: run.input ?? null,
    },
    output: run.output,
    sharedState: run.sharedState ?? null,
  };
  liveCache = { at: now, value };
  return value;
}

async function latestRun() {
  let run;
  if (!LIVE) {
    const captured = await sample;
    run = LIVE_CONFIG_ERROR
      ? {
          ...captured,
          source: { ...captured.source, liveError: LIVE_CONFIG_ERROR },
        }
      : captured;
  } else {
    try {
      run = await readLive();
    } catch (err) {
      const captured = await sample;
      run = {
        ...captured,
        source: { ...captured.source, liveError: String(err?.message ?? err) },
      };
    }
  }
  return { source: run.source, output: run.output, quote: quoteOf(run) };
}

// Same observed-rejection pattern as `sample`: a missing file is a 500 on its
// route, not a crash at startup.
const page = readFile(path.join(HERE, "index.html"));
page.catch(() => {});
const samplePdf = readFile(path.join(HERE, "sample", SAMPLE_PDF));
samplePdf.catch(() => {});

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
    if (url.pathname === SAMPLE_PDF_ROUTE) {
      // Read before the headers go out, so a failed read can still be a 500.
      const pdf = await samplePdf;
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${SAMPLE_PDF}"`,
      });
      res.end(pdf);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await page;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
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
  console.log(`quote review dashboard on http://localhost:${PORT} (${mode})`);
});
