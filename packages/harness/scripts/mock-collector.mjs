#!/usr/bin/env node
/**
 * Standalone mock remote collector — tonight's "SAPIOM_COLLECTOR_URL".
 *
 * Listens on :4199, logs a one-line summary of each received batch, and
 * appends every raw request body to ./mock-collector-received.ndjson for
 * inspection. No dependency on the rest of the package: run directly with
 * `node scripts/mock-collector.mjs`.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.MOCK_COLLECTOR_PORT || 4199);
const OUT_FILE = path.resolve(process.cwd(), "mock-collector-received.ndjson");

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
  if (req.method !== "POST") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    fs.appendFile(OUT_FILE, `${raw}\n`, () => {});

    try {
      const batch = JSON.parse(raw);
      console.log(`[mock-collector] received ${summarize(batch)}`);
    } catch (err) {
      console.error(`[mock-collector] received unparsable body: ${err.message}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[mock-collector] listening on http://localhost:${PORT}`);
  console.log(`[mock-collector] appending received batches to ${OUT_FILE}`);
});
