// =============================================================================
// Content pack dashboard: the page this template ships beside its agent.
//
// One dependency-free Node server (`node server.mjs`, no build step) that serves
// `index.html`, one JSON route, `/api/run`, carrying the latest completed run's
// terminal output (the tweet thread, LinkedIn post and newsletter it wrote, the
// quote graphics it rendered, and what it delivered), and the captured run's
// graphics under `/sample/`. The page renders that and nothing else: every word
// and every image on screen came out of a run of the agent.
//
// Two data sources, chosen by environment:
//
//   live      SAPIOM_API_KEY + SAPIOM_DEFINITION_ID are set. The latest completed
//             run of that deployed agent is read over the Sapiom API and cached
//             for a short while. The publish step that puts this dashboard on an
//             App Link is expected to inject both (SAPIOM_API_URL optional,
//             defaults to production). The graphics load straight from the run's
//             `downloadUrl`s, the durable public permalinks `package` mints.
//   captured  Either is missing, or the live read fails. `sample-run.json` is
//             served instead: the verbatim output of a real zero-setup run of
//             this template, with that run's own graphics bundled under
//             `sample/`, so the page is never empty and never invented.
//
// The copy itself only reaches the terminal output as the assembled markdown
// pack. A run with no recipients returns it inline (`markdown`); a run that
// emailed the pack returns only its public permalink (`packDownloadUrl`), which
// is fetched here. Either way the server splits it back into channels
// (`pack`), so the page never parses markdown it did not write.
//
// The response always says which source it is (`source.kind`); the page prints
// it, so a reader can tell a live run from the captured one at a glance.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4176;
const API_URL = (process.env.SAPIOM_API_URL || "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY || "";
const DEFINITION_ID = process.env.SAPIOM_DEFINITION_ID || "";
const LIVE_CACHE_MS = 30_000;
/** A content pack is a few KB of markdown; anything far larger is not one. */
const PACK_MAX_BYTES = 512 * 1024;

/**
 * The only files served from `sample/`: the captured run's two quote graphics.
 * A fixed table rather than a directory walk, so a request path can never
 * reach anything else on disk.
 */
const SAMPLE_MEDIA = {
  "/sample/quote-1.jpg": { file: "quote-1.jpg", type: "image/jpeg" },
  "/sample/quote-2.jpg": { file: "quote-2.jpg", type: "image/jpeg" },
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
 * Only an https link is handed to the page as an image source or fetched for
 * the pack. The run's links are public permalinks on the file-storage service,
 * and anything else would be a mixed-content block or an injection sink.
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
 * Fetch the emailed pack's markdown from its public permalink. No key is sent
 * (the permalink is public), so following its redirect to the signed storage
 * URL is safe. Bounded in time and size.
 */
async function fetchPackMarkdown(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`pack download → HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length"));
  if (length > PACK_MAX_BYTES) throw new Error("pack is larger than expected");
  const text = await res.text();
  if (text.length > PACK_MAX_BYTES) {
    throw new Error("pack is larger than expected");
  }
  return text;
}

/**
 * Split the pack markdown `renderPackMarkdown` writes back into its channels.
 * The headings come in a fixed order; the newsletter may carry `##` headings
 * of its own, so the section after it is found from the end rather than the
 * next `##`. A tweet may span lines, so a new tweet starts only at the next
 * expected number. Returns null for markdown of any other shape, and the page
 * then says the copy could not be read rather than showing half of it.
 */
function parsePack(markdown) {
  const text = `\n${String(markdown ?? "").replace(/\r\n/g, "\n")}`;
  const heading = (name) => `\n## ${name}\n`;
  const thread = text.indexOf(heading("Tweet thread"));
  const linkedIn = text.indexOf(heading("LinkedIn post"), thread + 1);
  const newsletter = text.indexOf(heading("Newsletter"), linkedIn + 1);
  const graphics = text.lastIndexOf(heading("Quote graphics"));
  if (thread < 0 || linkedIn < 0 || newsletter < 0 || graphics < newsletter) {
    return null;
  }
  const body = (start, name, end) =>
    text.slice(start + heading(name).length, end).trim();

  const tweetThread = [];
  for (const line of body(thread, "Tweet thread", linkedIn).split("\n")) {
    const next = `${tweetThread.length + 1}. `;
    if (line.startsWith(next)) tweetThread.push(line.slice(next.length));
    else if (tweetThread.length > 0) {
      tweetThread[tweetThread.length - 1] += `\n${line}`;
    }
  }
  return {
    tweetThread: tweetThread.map((t) => t.trim()),
    linkedInPost: body(linkedIn, "LinkedIn post", newsletter),
    newsletter: body(newsletter, "Newsletter", graphics),
  };
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
  const output = run.output;
  // A dry run completes with the copy under `pack` and nothing rendered; a run
  // with no recipients returns the pack markdown inline; a delivered run only
  // links it.
  let markdown = typeof output.markdown === "string" ? output.markdown : null;
  const packUrl = httpsOrNull(output.packDownloadUrl);
  if (markdown == null && packUrl) markdown = await fetchPackMarkdown(packUrl);
  const graphics = Array.isArray(output.graphics) ? output.graphics : [];
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
      graphics: graphics.map((g) => httpsOrNull(g?.downloadUrl)),
      packUrl,
    },
    pack:
      output.dryRun && output.pack
        ? output.pack
        : markdown != null
          ? parsePack(markdown)
          : null,
    output,
  };
  liveCache = { at: now, value };
  return value;
}

/**
 * The captured run, read once; it never changes while the server is up. The
 * rejection is observed here so a missing or corrupt file cannot surface as an
 * unhandled rejection before the first request; the request handler turns it
 * into a 500 instead.
 */
const sample = readFile(path.join(HERE, "sample-run.json"), "utf8").then(
  (text) => {
    const captured = JSON.parse(text);
    return { ...captured, pack: parsePack(captured.output?.markdown) };
  },
);
sample.catch(() => {});

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

/**
 * Only what the page renders leaves this server. The run's input carries the
 * caller's source text and recipient list, and its output lists every address
 * the pack was sent to; the page needs neither, only whether the source was
 * the caller's own, whether the clip was asked for, and how many recipients
 * there were. The pack markdown is dropped too, as `pack` already carries it.
 */
function forPage(run) {
  const input = run.source?.input ?? {};
  const { recipients, markdown: _markdown, ...output } = run.output ?? {};
  const { input: _input, ...source } = run.source ?? {};
  return {
    ...run,
    source: {
      ...source,
      ownSource: typeof input.source === "string" && input.source.trim() !== "",
      renderClip:
        typeof input.renderClip === "boolean" ? input.renderClip : null,
    },
    output: {
      ...output,
      recipientCount: Array.isArray(recipients) ? recipients.length : 0,
    },
  };
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
      const body = JSON.stringify(forPage(await latestRun()));
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
      const bytes = await readFile(path.join(HERE, "sample", media.file));
      res.writeHead(200, {
        "content-type": media.type,
        "content-length": bytes.byteLength,
        "cache-control": "public, max-age=3600",
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
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
  console.log(`content pack dashboard on http://localhost:${PORT} (${mode})`);
});
