// =============================================================================
// Scene video dashboard: the page this template ships beside its agent.
//
// One dependency-free Node server (`node server.mjs`, no build step) that serves
// `index.html`, one JSON route, `/api/run`, carrying the latest completed run's
// terminal output (the finished video's link and file id, the shot list the
// model planned, and the run's own note), and the captured run's media under
// `/sample/`. The page renders that and nothing else: every frame and every
// prompt on screen came out of a run of the agent.
//
// Two data sources, chosen by environment:
//
//   live      SAPIOM_API_KEY + SAPIOM_DEFINITION_ID are set. The latest completed
//             run of that deployed agent is read over the Sapiom API and cached
//             for a short while. The publish step that puts this dashboard on an
//             App Link is expected to inject both (SAPIOM_API_URL optional,
//             defaults to production). The video plays straight from the run's
//             `downloadUrl`, the durable public permalink `finalize` returns.
//   captured  Either is missing, or the live read fails. `sample-run.json` is
//             served instead: the verbatim output of a real zero-setup run of
//             this template, with that run's own render bundled as
//             `sample/clip.mp4`, so the page is never empty and never invented.
//
// The response always says which (`source.kind`) and where the video comes
// from (`media`); the page prints the source, so a reader can tell a live run
// from the captured one at a glance.
// =============================================================================

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4174;
const API_URL = (process.env.SAPIOM_API_URL || "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY || "";
const DEFINITION_ID = process.env.SAPIOM_DEFINITION_ID || "";
const LIVE_CACHE_MS = 30_000;

/**
 * The only files served from `sample/`: the captured run's render and its
 * first frame. A fixed table rather than a directory walk, so a request path
 * can never reach anything else on disk.
 */
const SAMPLE_MEDIA = {
  "/sample/clip.mp4": { file: "clip.mp4", type: "video/mp4" },
  "/sample/poster.jpg": { file: "poster.jpg", type: "image/jpeg" },
};

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

/**
 * Only an https link is handed to the page as a video source. The run's
 * `downloadUrl` is one (a public permalink on the file-storage service), and
 * anything else would be a mixed-content block or an injection sink rather
 * than a video.
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
 * Latest completed run of the bound agent, as `{ source, media, output }`.
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
  // A dry run completes with a plan and no video: `videoUrl` is then null and
  // the page shows the shot list with the player replaced by a note.
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
    media: {
      videoUrl: httpsOrNull(run.output.downloadUrl),
      posterUrl: null,
    },
    output: run.output,
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

/**
 * Serve one of the captured run's media files, honouring a single byte range:
 * the browser asks for ranges to seek, and the filmstrip on the page seeks six
 * times before the clip has necessarily finished downloading.
 */
async function sendMedia(req, res, { file, type }) {
  const filePath = path.join(HERE, "sample", file);
  const { size } = await stat(filePath);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
  }
  const headers = {
    "content-type": type,
    "content-length": end - start + 1,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

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
    const media = Object.hasOwn(SAMPLE_MEDIA, url.pathname)
      ? SAMPLE_MEDIA[url.pathname]
      : null;
    if (media) {
      await sendMedia(req, res, media);
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
  console.log(`scene video dashboard on http://localhost:${PORT} (${mode})`);
});
