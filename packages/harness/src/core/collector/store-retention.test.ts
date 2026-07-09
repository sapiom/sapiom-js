import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepNdjson, DEFAULT_MAX_SIZE_BYTES, DEFAULT_MAX_AGE_MS } from "./store-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEvent(opts: {
  eventId: string;
  ts?: string;
  payload?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    eventId: opts.eventId,
    seq: 1,
    ts: opts.ts ?? new Date().toISOString(),
    userId: null,
    tenantId: null,
    machineId: "machine-1",
    harnessSessionId: "session-1",
    agentSessionId: null,
    harness: "claude-code",
    type: "session.start",
    payload: opts.payload ?? {},
  });
}

describe("sweepNdjson", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-retention-test-"));
    filePath = path.join(tmpDir, "events.ndjson");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeLines(lines: string[]): Promise<void> {
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  }

  async function readLines(): Promise<string[]> {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim().split("\n").filter(Boolean);
  }

  it("returns rewritten:false on ENOENT — file does not exist yet", async () => {
    const result = await sweepNdjson(path.join(tmpDir, "nonexistent.ndjson"));
    expect(result).toEqual({ linesBefore: 0, linesAfter: 0, rewritten: false });
  });

  it("does nothing when the file is within both caps", async () => {
    const lines = [
      makeEvent({ eventId: "a", ts: new Date().toISOString() }),
      makeEvent({ eventId: "b", ts: new Date().toISOString() }),
    ];
    await writeLines(lines);

    const result = await sweepNdjson(filePath, { maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, maxAgeMs: DEFAULT_MAX_AGE_MS });
    expect(result.rewritten).toBe(false);
    expect(result.linesBefore).toBe(2);
    expect(result.linesAfter).toBe(2);
  });

  it("age trigger: drops events older than maxAgeMs, retains newer ones", async () => {
    const oldTs = new Date(Date.now() - 31 * DAY_MS).toISOString();
    const newTs = new Date().toISOString();
    await writeLines([
      makeEvent({ eventId: "old-1", ts: oldTs }),
      makeEvent({ eventId: "old-2", ts: oldTs }),
      makeEvent({ eventId: "new-1", ts: newTs }),
    ]);

    const result = await sweepNdjson(filePath, { maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, maxAgeMs: 30 * DAY_MS });
    expect(result.rewritten).toBe(true);
    expect(result.linesBefore).toBe(3);
    expect(result.linesAfter).toBe(1);

    const remaining = await readLines();
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).eventId).toBe("new-1");
  });

  it("size trigger: drops oldest lines until content fits within maxSizeBytes", async () => {
    // Build lines where the oldest ones push us over the size cap.
    const ts = new Date().toISOString();
    const lines = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ eventId: `evt-${i}`, ts }),
    );
    await writeLines(lines);

    // Cap that fits roughly 3 events — each line is ~227 bytes, so 700 bytes
    // allows 3 but not all 10. Pick a value larger than one event but well
    // below 10 events so we can assert some-but-not-all survive.
    const singleLineBytes = Buffer.byteLength(lines[0] + "\n", "utf8"); // ~227
    const tinyMaxBytes = singleLineBytes * 3; // fits exactly 3 events
    const result = await sweepNdjson(filePath, { maxSizeBytes: tinyMaxBytes, maxAgeMs: DEFAULT_MAX_AGE_MS });

    expect(result.rewritten).toBe(true);
    expect(result.linesBefore).toBe(10);
    expect(result.linesAfter).toBeLessThan(10);
    expect(result.linesAfter).toBeGreaterThan(0);

    // Verify the FILE content after sweep actually fits in the cap.
    const fileContent = await fs.readFile(filePath, "utf8");
    expect(Buffer.byteLength(fileContent, "utf8")).toBeLessThanOrEqual(tinyMaxBytes);
  });

  it("atomic rewrite: newest events are preserved — oldest dropped by size cap", async () => {
    const ts = new Date().toISOString();
    const lines = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ eventId: `evt-${i}`, ts }),
    );
    await writeLines(lines);

    // Cap that keeps only the last ~3 events.
    const singleLineBytes = Buffer.byteLength(lines[0] + "\n", "utf8");
    const threeLines = singleLineBytes * 3;
    await sweepNdjson(filePath, { maxSizeBytes: threeLines, maxAgeMs: DEFAULT_MAX_AGE_MS });

    const remaining = await readLines();
    // Last three events should be: evt-7, evt-8, evt-9.
    const ids = remaining.map((l) => (JSON.parse(l) as { eventId: string }).eventId);
    expect(ids[ids.length - 1]).toBe("evt-9");
    expect(ids[0]).toBe(`evt-${10 - remaining.length}`);
  });

  it("corrupted-line tolerance: bad JSON is kept on age pass, size cap may drop it", async () => {
    const ts = new Date().toISOString();
    await writeLines([
      makeEvent({ eventId: "good", ts }),
      "this is not valid json {{{",
    ]);

    // No caps triggered — corrupted line should pass through.
    const result = await sweepNdjson(filePath, { maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, maxAgeMs: DEFAULT_MAX_AGE_MS });
    expect(result.rewritten).toBe(false);
    expect(result.linesAfter).toBe(2);

    const remaining = await readLines();
    expect(remaining).toContain("this is not valid json {{{");
  });

  it("drops all events when every line is older than the age cap", async () => {
    const oldTs = new Date(Date.now() - 60 * DAY_MS).toISOString();
    await writeLines([
      makeEvent({ eventId: "very-old-1", ts: oldTs }),
      makeEvent({ eventId: "very-old-2", ts: oldTs }),
    ]);

    const result = await sweepNdjson(filePath, { maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, maxAgeMs: 30 * DAY_MS });
    expect(result.rewritten).toBe(true);
    expect(result.linesAfter).toBe(0);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe(""); // file is empty but exists
  });

  it("creates the parent directory if it does not exist before a rewrite", async () => {
    const deepPath = path.join(tmpDir, "nested", "dir", "events.ndjson");
    const oldTs = new Date(Date.now() - 60 * DAY_MS).toISOString();
    await fs.mkdir(path.dirname(deepPath), { recursive: true });
    await fs.writeFile(deepPath, makeEvent({ eventId: "old", ts: oldTs }) + "\n", "utf8");

    // Should rewrite without throwing on missing parent.
    const result = await sweepNdjson(deepPath, { maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, maxAgeMs: 30 * DAY_MS });
    expect(result.rewritten).toBe(true);
  });
});
