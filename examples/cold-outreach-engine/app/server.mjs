// =============================================================================
// Outreach campaign dashboard: the page this template ships beside its agent.
//
// One dependency-free Node server (`node server.mjs`, no build step) that serves
// `index.html` and one JSON route, `/api/run`, carrying the latest completed
// run of the agent: its terminal output (the campaign counts and the run's own
// note), the contacts it worked with the opener the model wrote for each, the
// drip sequence it sent from, and the step trail. The page renders that and
// nothing else: every name, every opener, and every count on screen came out of
// a run of the agent.
//
// The openers are read from the run's shared state, not its output: `done`
// returns each contact's address and status but not the line the model wrote,
// and that line is the thing this template produces.
//
// Two data sources, chosen by environment:
//
//   live      SAPIOM_API_KEY + SAPIOM_DEFINITION_ID are set. The latest completed
//             run of that deployed agent is read over the Sapiom API and cached
//             for a short while. The publish step that puts this dashboard on an
//             App Link is expected to inject both (SAPIOM_API_URL optional,
//             defaults to production).
//   captured  Either is missing, or the live read fails. `sample-run.json` is
//             served instead: the same projection of a real zero-setup run of
//             this template, so the page is never empty and never invented.
//
// The response always says which (`source.kind`); the page prints it, so a
// reader can tell a live run from the captured one at a glance.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4175;
const API_URL = (process.env.SAPIOM_API_URL || "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY || "";
const DEFINITION_ID = process.env.SAPIOM_DEFINITION_ID || "";
const LIVE_CACHE_MS = 30_000;

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

const text = (v) => (typeof v === "string" && v.trim() ? v : null);

/**
 * The part of a run's shared state the page reads, and only that part. Shared
 * state carries whatever the agent keeps between steps; passing it through
 * whole would put the database handle and anything a later version of the
 * agent adds in front of every viewer.
 */
function projectCampaign(shared) {
  const s = shared && typeof shared === "object" ? shared : {};
  const contacts = Array.isArray(s.contacts) ? s.contacts : [];
  const sequence = Array.isArray(s.sequence) ? s.sequence : [];
  return {
    demo: s.demoRun === true,
    senderName: text(s.senderName),
    dripMs: Number.isFinite(s.dripMs) ? s.dripMs : null,
    touchIndex: Number.isInteger(s.touchIndex) ? s.touchIndex : null,
    contacts: contacts.map((c) => ({
      email: text(c?.email),
      fullName: text(c?.fullName),
      firstName: text(c?.firstName),
      lastName: text(c?.lastName),
      position: text(c?.position),
      company: text(c?.company),
      firstLine: text(c?.firstLine),
      deliverable: c?.deliverable === true,
      verifyStatus: text(c?.verifyStatus),
      status: text(c?.status),
    })),
    sequence: sequence.map((t) => ({
      subject: typeof t?.subject === "string" ? t.subject : "",
      body: typeof t?.body === "string" ? t.body : "",
    })),
  };
}

/** Each step the run took, in order, with its timing; no inputs or logs. */
function projectSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => ({
    stepName: String(s?.stepName ?? "?"),
    status: text(s?.status),
    attempt: Number.isInteger(s?.attempt) ? s.attempt : 0,
    startedAt: text(s?.startedAt),
    finishedAt: text(s?.finishedAt),
  }));
}

/**
 * Latest completed run of the bound agent, as `{ source, output, campaign,
 * steps }`. Throws on any failure so the caller can fall back; the failure
 * text (never the key) travels to the page as `source.liveError`.
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
    campaign: projectCampaign(run.sharedState),
    steps: projectSteps(run.steps),
  };
  liveCache = { at: now, value };
  return value;
}

async function latestRun() {
  if (!LIVE) {
    const captured = await sample;
    return LIVE_CONFIG_ERROR
      ? {
          ...captured,
          source: { ...captured.source, liveError: LIVE_CONFIG_ERROR },
        }
      : captured;
  }
  try {
    return await readLive();
  } catch (err) {
    const captured = await sample;
    return {
      ...captured,
      source: { ...captured.source, liveError: String(err?.message ?? err) },
    };
  }
}

// Same observed-rejection pattern as `sample`: a missing page is a 500 on `/`,
// not a crash at startup.
const page = readFile(path.join(HERE, "index.html"));
page.catch(() => {});

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
  console.log(
    `outreach campaign dashboard on http://localhost:${PORT} (${mode})`,
  );
});
