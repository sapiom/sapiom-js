#!/usr/bin/env node
/**
 * Standalone mock remote collector — tonight's "SAPIOM_COLLECTOR_URL".
 *
 * Serves POST /v1/harness/events, logs a one-line summary of each received
 * batch, and appends every raw request body to
 * ./mock-collector-received.ndjson for inspection. No dependency on the rest
 * of the package: run directly with `node scripts/mock-collector.mjs`.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.MOCK_COLLECTOR_PORT || 4199);
const OUT_FILE = path.resolve(process.cwd(), "mock-collector-received.ndjson");
const EVENTS_PATH = "/v1/harness/events";

function summarize(batch) {
  const events = Array.isArray(batch?.events) ? batch.events : [];
  const counts = {};
  for (const event of events) {
    const type = event?.type ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  return `${events.length} event(s) from ${batch?.machineId ?? "unknown"}${breakdown ? ` (${breakdown})` : ""}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method !== "POST" || url.pathname !== EVENTS_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");

    let batch;
    try {
      batch = JSON.parse(raw);
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `invalid JSON: ${err.message}` }));
      return;
    }

    fs.appendFile(OUT_FILE, `${raw}\n`, () => {});

    const accepted = Array.isArray(batch?.events) ? batch.events.length : 0;
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted }));

    console.log(`[mock-collector] received ${summarize(batch)}`);
  });
});

server.listen(PORT, () => {
  console.log(`[mock-collector] listening on http://localhost:${PORT}${EVENTS_PATH}`);
  console.log(`[mock-collector] appending received batches to ${OUT_FILE}`);
});
