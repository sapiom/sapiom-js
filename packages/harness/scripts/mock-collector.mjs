#!/usr/bin/env node
/**
 * Standalone mock remote collector for the harness e2e scripts.
 *
 * Accepts the analytics-core collector contract:
 *   POST /v1/analytics/collector
 *   Body: { events: [...] }   (analytics-core envelope)
 *   Response: 202 { accepted: n, dropped: 0 }
 *
 * Logs a one-line summary of each received batch and appends every raw
 * request body to ./mock-collector-received.ndjson for inspection.
 * Run directly with `node scripts/mock-collector.mjs`.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.MOCK_COLLECTOR_PORT || 4199);
const OUT_FILE = path.resolve(process.cwd(), "mock-collector-received.ndjson");
// Accept the analytics-core path or any path — the harness passes the bare
// host:port as collectorUrl and analytics-core may or may not append a suffix.
const EVENTS_PATH = "/v1/analytics/collector";

function summarize(body) {
  const events = Array.isArray(body?.events) ? body.events : [];
  const counts = {};
  for (const event of events) {
    const type = event?.event_type ?? event?.type ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  const source = events[0]?.source ?? "unknown";
  return `${events.length} event(s) from source=${source}${breakdown ? ` (${breakdown})` : ""}`;
}

const server = http.createServer((req, res) => {
  // Accept any POST: the harness passes a bare host:port as collectorUrl and
  // analytics-core posts to whatever endpoint URL it resolved. A GET/HEAD/etc.
  // to any path is a health-probe no-op (204).
  if (req.method !== "POST") {
    res.writeHead(204);
    res.end();
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");

    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `invalid JSON: ${err.message}` }));
      return;
    }

    fs.appendFile(OUT_FILE, `${raw}\n`, () => {});

    const accepted = Array.isArray(body?.events) ? body.events.length : 0;
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted, dropped: 0 }));

    console.log(`[mock-collector] received ${summarize(body)}`);
  });
});

server.listen(PORT, () => {
  console.log(`[mock-collector] listening on http://localhost:${PORT} (accepts POST ${EVENTS_PATH} or any POST)`);
  console.log(`[mock-collector] appending received batches to ${OUT_FILE}`);
});
