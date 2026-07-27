/**
 * Perf floor for opening a session record against a FULL events.ndjson —
 * 50 MB, the retention cap (see collector/store-retention.ts).
 *
 * What it defends: the byte-offset index. Without it, every record open would
 * rescan the whole file, which is seconds, not milliseconds. So the shape of
 * the assertion is deliberate — one cold request pays for the index build, and
 * every request after that reads only the bytes belonging to the session.
 *
 * The target session's events are scattered across the file rather than
 * clustered at one end: that is the hard case for a span-based read (hundreds
 * of small spans instead of one big one) and the realistic one for a machine
 * that runs several sessions at once.
 *
 * Thresholds are wall-clock and therefore machine-dependent. The hot-read bar
 * is the ticket's (<300 ms p95) and holds with a wide margin on a laptop; the
 * cold bar is loose on purpose — it exists to catch an accidental
 * rescan-per-read regression, not to police a CI runner's disk.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnalyticsEvent, AnalyticsEventType } from "../shared/types.js";
import { createEventStore } from "./collector/store.js";
import { createSessionRecordReader } from "./session-record.js";

const TARGET_BYTES = 50 * 1024 * 1024;
const SESSION_COUNT = 40;
const TARGET_SESSION = "sess-0007";
/** Repeated record opens to sample; p95 of these is the assertion. */
const HOT_SAMPLES = 20;
const HOT_P95_BUDGET_MS = 300;
const COLD_BUDGET_MS = 15_000;

/** Padding that makes each event a realistic size (a real tool.call is ~1-16 KB). */
const FILLER = "x".repeat(400);

function line(index: number, session: string, type: AnalyticsEventType): string {
  const event: AnalyticsEvent = {
    eventId: `evt-${index}`,
    seq: (index % 50) + 1,
    // Ascending timestamps, one second apart — the fold sorts by (ts, seq).
    ts: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    userId: null,
    tenantId: null,
    machineId: "machine-perf",
    harnessSessionId: session,
    agentSessionId: `agent-${session}`,
    harness: "claude-code",
    type,
    payload:
      type === "tool.call"
        ? { toolName: "Read", toolInput: `{"file":"/repo/f${index}.ts"}`, toolResponseSummary: FILLER }
        : type === "prompt.submitted"
          ? { prompt: `do the thing #${index} ${FILLER}` }
          : { assistantText: `did the thing #${index} ${FILLER}`, model: "claude-opus-4-6", usage: { inputTokens: index, outputTokens: 10 } },
  };
  return `${JSON.stringify(event)}\n`;
}

/** prompt → tool → tool → completed, so each session folds into real turns. */
const CYCLE: AnalyticsEventType[] = ["prompt.submitted", "tool.call", "tool.call", "turn.completed"];

describe("session record perf (50 MB events.ndjson)", () => {
  let tmpDir: string;
  let filePath: string;
  let targetEventCount = 0;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-record-perf-"));
    filePath = path.join(tmpDir, "events.ndjson");

    // Round-robin the sessions so the target's lines are spread through the
    // whole file, then write in batches (one 50 MB string would be its own
    // memory problem).
    const handle = await fs.open(filePath, "w");
    try {
      let written = 0;
      let index = 0;
      let batch: string[] = [];
      let batchBytes = 0;
      while (written < TARGET_BYTES) {
        const session = `sess-${String(index % SESSION_COUNT).padStart(4, "0")}`;
        const text = line(index, session, CYCLE[Math.floor(index / SESSION_COUNT) % CYCLE.length]);
        if (session === TARGET_SESSION) targetEventCount += 1;
        batch.push(text);
        batchBytes += Buffer.byteLength(text, "utf8");
        index += 1;
        if (batchBytes >= 4 * 1024 * 1024) {
          await handle.write(batch.join(""));
          written += batchBytes;
          batch = [];
          batchBytes = 0;
        }
      }
      if (batch.length > 0) {
        await handle.write(batch.join(""));
        written += batchBytes;
      }
    } finally {
      await handle.close();
    }

    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThanOrEqual(TARGET_BYTES);
  }, 300_000);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("opens a record in well under 300ms p95 once the index exists", async () => {
    const reader = createSessionRecordReader(createEventStore(filePath));

    // Cold: the one request that pays for the index build.
    const coldStart = performance.now();
    const cold = await reader.read(TARGET_SESSION);
    const coldMs = performance.now() - coldStart;

    expect(cold).not.toBeNull();
    expect(cold?.eventCount).toBe(targetEventCount);
    expect(cold?.turns.length).toBeGreaterThan(0);
    // Every event folded must belong to the target session — proof the spans
    // are the target's and not a neighbour's.
    expect(cold?.mergedSessionIds).toEqual([TARGET_SESSION]);

    const samples: number[] = [];
    for (let i = 0; i < HOT_SAMPLES; i++) {
      const start = performance.now();
      const record = await reader.read(TARGET_SESSION);
      samples.push(performance.now() - start);
      expect(record?.eventCount).toBe(targetEventCount);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    // Logged rather than silently asserted — a regression here is a design
    // regression (a rescan crept back in), and the numbers say which.
    console.info(
      `[perf] 50MB ndjson · cold ${coldMs.toFixed(0)}ms · hot p95 ${p95.toFixed(1)}ms · median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms · ${targetEventCount} events`,
    );

    expect(p95).toBeLessThan(HOT_P95_BUDGET_MS);
    expect(coldMs).toBeLessThan(COLD_BUDGET_MS);
  });

  it("opens a record by reading only the session's own bytes, not the file", async () => {
    // The timing assertion above can't tell "index worked" from "the whole
    // 50 MB scan happened to be fast on this disk". This one can, without any
    // wall clock in it: the spans the index attributes to the session are what
    // a record open reads, so their total size IS the I/O the open costs.
    const store = createEventStore(filePath);
    const index = await store.index();
    const entry = index.bySession.get(TARGET_SESSION);
    expect(entry).toBeDefined();

    const spanBytes = entry!.spans.reduce((total, span) => total + (span.end - span.start), 0);
    const fileBytes = (await fs.stat(filePath)).size;
    // 40 sessions, round-robin: ~1/40th of the file. Assert an order of
    // magnitude so this stays a regression tripwire, not a fixture-count echo.
    expect(spanBytes).toBeLessThan(fileBytes / 10);
    expect(spanBytes).toBeGreaterThan(0);
  }, 300_000);

  it("counts turns for every session without reading the file again", async () => {
    const reader = createSessionRecordReader(createEventStore(filePath));
    await reader.turnCounts(); // builds the index

    const start = performance.now();
    const counts = await reader.turnCounts();
    const elapsed = performance.now() - start;

    expect(counts.size).toBeGreaterThanOrEqual(SESSION_COUNT);
    expect(counts.get(TARGET_SESSION)).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(HOT_P95_BUDGET_MS);
  }, 300_000);
});
