import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionRecord, SessionRecordTurn } from "../shared/types.js";
import {
  backfillSessionRecords,
  compactSessionRecord,
  createRecordArchive,
  type RecordArchive,
} from "./record-archive.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function turn(index: number, overrides: Partial<SessionRecordTurn> = {}): SessionRecordTurn {
  return {
    index,
    prompt: `prompt ${index}`,
    promptAt: `2026-07-0${Math.min(index, 9)}T10:00:00.000Z`,
    toolCalls: [],
    assistantText: `reply ${index}`,
    model: "claude-opus-4-6",
    usage: { inputTokens: 100, outputTokens: 20 },
    completedAt: `2026-07-0${Math.min(index, 9)}T10:00:05.000Z`,
    incomplete: false,
    ...overrides,
  };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const turns = overrides.turns ?? [turn(1)];
  return {
    harnessSessionId: "sess-a",
    mergedSessionIds: ["sess-a"],
    agentSessionId: "agent-1",
    harness: "claude-code",
    cwd: "/repo",
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:30:00.000Z",
    turnCount: turns.filter((t) => t.prompt !== null).length,
    eventCount: turns.length * 3,
    reconstructed: true,
    archivedAt: null,
    limitations: [],
    ...overrides,
    turns,
  };
}

describe("compactSessionRecord", () => {
  it("clips tool inputs and results, keeps the conversation, and says both", () => {
    const compacted = compactSessionRecord(
      record({
        turns: [
          turn(1, {
            prompt: "keep me",
            assistantText: "and me",
            toolCalls: [
              {
                name: "Edit",
                input: JSON.stringify({ old_string: "x".repeat(4000) }),
                responseSummary: "y".repeat(4000),
                responseTruncated: false,
                at: "2026-07-01T10:00:01.000Z",
              },
            ],
          }),
        ],
      }),
      { maxToolInputChars: 100, maxToolResponseChars: 100 },
    );

    const call = compacted.turns[0].toolCalls[0];
    expect(call.input).toMatch(/…\[truncated \d+ chars\]$/);
    expect(call.input?.length).toBeLessThan(200);
    // Bounded to maxToolResponseChars total (content + marker), not content
    // alone -- 100 chars minus the marker's own length leaves 77 y's here.
    expect(call.responseSummary).toBe(`${"y".repeat(77)}…[truncated 3923 chars]`);
    expect(call.responseSummary?.length).toBe(100);
    // A result this pass shortened is truncated, whoever shortened it.
    expect(call.responseTruncated).toBe(true);
    // The conversation itself is untouched — that's the part worth archiving.
    expect(compacted.turns[0].prompt).toBe("keep me");
    expect(compacted.turns[0].assistantText).toBe("and me");
    expect(compacted.limitations).toContain("compacted-archive");
    expect(compacted.limitations).toContain("truncated-tool-output");
    expect(compacted.archivedAt).not.toBeNull();
  });

  it("folds an already-truncated result's count into the new marker instead of nesting them", () => {
    const compacted = compactSessionRecord(
      record({
        turns: [
          turn(1, {
            toolCalls: [
              {
                name: "Bash",
                input: "{}",
                // What the collector's own 16 KB cap leaves behind.
                responseSummary: `${"z".repeat(300)}…[truncated 1000 chars]`,
                responseTruncated: true,
                at: "2026-07-01T10:00:01.000Z",
              },
            ],
          }),
        ],
      }),
      { maxToolResponseChars: 100 },
    );

    // 300 z's clipped to 77 (100-char budget minus the marker's own length),
    // plus the 1000 the collector had already dropped: 223 newly dropped
    // here + 1000 folded in = 1223.
    expect(compacted.turns[0].toolCalls[0].responseSummary).toBe(
      `${"z".repeat(77)}…[truncated 1223 chars]`,
    );
    expect(compacted.turns[0].toolCalls[0].responseSummary?.length).toBe(100);
  });

  it("claims no compaction when nothing was actually clipped", () => {
    const compacted = compactSessionRecord(record({ limitations: ["assistant-narration-gap"] }));
    expect(compacted.limitations).toEqual(["assistant-narration-gap"]);
    expect(compacted.turns).toHaveLength(1);
  });

  it("is idempotent apart from the stamp — re-archiving never shaves a record further", () => {
    const once = compactSessionRecord(
      record({
        turns: [
          turn(1, {
            toolCalls: [
              {
                name: "Read",
                input: "i".repeat(5000),
                responseSummary: "r".repeat(5000),
                responseTruncated: false,
                at: "2026-07-01T10:00:01.000Z",
              },
            ],
          }),
        ],
      }),
      { archivedAt: "2026-07-02T00:00:00.000Z" },
    );
    const twice = compactSessionRecord(once, { archivedAt: "2026-07-03T00:00:00.000Z" });

    expect({ ...twice, archivedAt: null }).toEqual({ ...once, archivedAt: null });
    expect(twice.archivedAt).toBe("2026-07-03T00:00:00.000Z");
  });

  it("drops the oldest turns to fit the byte cap, and keeps the count of what happened", () => {
    const turns = Array.from({ length: 12 }, (_, i) =>
      turn(i + 1, { assistantText: `reply ${i + 1} ${"w".repeat(400)}` }),
    );
    const full = record({ turns });
    const compacted = compactSessionRecord(full, { maxBytes: 3000 });

    expect(compacted.turns.length).toBeGreaterThan(0);
    expect(compacted.turns.length).toBeLessThan(12);
    // Kept turns are the newest ones and keep their original ordinals — turn 9
    // stays turn 9, so nothing implies a shorter session than there was.
    expect(compacted.turns[compacted.turns.length - 1].index).toBe(12);
    expect(compacted.turns[0].index).toBeGreaterThan(1);
    // The record still reports the conversation's 12 turns; the limitation is
    // what says only some of them are here.
    expect(compacted.turnCount).toBe(12);
    expect(compacted.eventCount).toBe(full.eventCount);
    expect(compacted.limitations).toContain("dropped-early-turns");
    // The cap bounds what comes OUT — including the stamp and the limitation
    // codes this pass added, which is why the budget is measured against them.
    expect(Buffer.byteLength(JSON.stringify(compacted), "utf8")).toBeLessThanOrEqual(3000);
  });

  it("counts the archive's own additions against the cap, not just the input's header", () => {
    // A record whose turns alone sit just under a tight cap: the stamp and the
    // two limitation codes have to fit inside it too.
    const turns = Array.from({ length: 6 }, (_, i) =>
      turn(i + 1, { assistantText: `reply ${i + 1} ${"w".repeat(200)}` }),
    );
    for (const maxBytes of [900, 1200, 1500]) {
      const compacted = compactSessionRecord(record({ turns }), { maxBytes });
      expect(Buffer.byteLength(JSON.stringify(compacted), "utf8")).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("keeps the last turn even when it alone exceeds the cap", () => {
    const compacted = compactSessionRecord(
      record({ turns: [turn(1), turn(2, { prompt: "p".repeat(3000) })] }),
      { maxBytes: 500, maxTextChars: 4000 },
    );
    expect(compacted.turns).toHaveLength(1);
    expect(compacted.turns[0].index).toBe(2);
    expect(compacted.limitations).toContain("dropped-early-turns");
  });
});

describe("createRecordArchive", () => {
  let root: string;
  let archive: RecordArchive;
  let errors: unknown[];

  beforeEach(async () => {
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "harness-archive-test-")), "records");
    errors = [];
    archive = createRecordArchive({ root, onError: (err) => errors.push(err) });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("writes a record and reads it back by every id it answers to", async () => {
    const written = await archive.write(
      record({ harnessSessionId: "sess-a", mergedSessionIds: ["sess-a", "sess-b"], agentSessionId: "agent-1" }),
    );
    expect(written?.archivedAt).not.toBeNull();

    // Filed under the primary id; a merged segment and the agent's own session
    // id resolve to the same record, which is what a history row keyed by
    // either of those needs.
    expect((await archive.read("sess-a"))?.harnessSessionId).toBe("sess-a");
    expect((await archive.read("sess-b"))?.harnessSessionId).toBe("sess-a");
    expect((await archive.read("agent-1"))?.harnessSessionId).toBe("sess-a");
    expect(await archive.has("sess-b")).toBe(true);
    expect(await archive.has("nope")).toBe(false);
    expect(await archive.read("nope")).toBeNull();

    // One file, no temp litter: the write is a temp + rename in this directory.
    expect(await fs.readdir(root)).toEqual(["sess-a.json"]);
  });

  it("replaces an earlier archive of the same conversation rather than accumulating", async () => {
    await archive.write(record({ turns: [turn(1)] }));
    await archive.write(record({ turns: [turn(1), turn(2)] }));

    expect(await fs.readdir(root)).toEqual(["sess-a.json"]);
    expect((await archive.read("sess-a"))?.turns).toHaveLength(2);
    expect(await archive.list()).toHaveLength(1);
  });

  it("serializes concurrent writes — both archive triggers can fire for one session at once", async () => {
    // server/index.ts archives on the `session.end` event AND on the session's
    // exit; for a normal exit those land within a millisecond of each other.
    const [first, second] = await Promise.all([
      archive.write(record({ turns: [turn(1)] })),
      archive.write(record({ turns: [turn(1), turn(2)] })),
      archive.sweep(),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(errors).toEqual([]);
    // One record, no temp file left behind by the loser of the race.
    expect(await fs.readdir(root)).toEqual(["sess-a.json"]);
    // And what's on disk is one of the two writes, not a splice of both.
    const stored = await archive.read("sess-a");
    expect([1, 2]).toContain(stored?.turns.length);
  });

  it("archives nothing for a record with no turns", async () => {
    expect(await archive.write(record({ turns: [] }))).toBeNull();
    expect(await fs.readdir(root).catch(() => [])).toEqual([]);
  });

  it("refuses a session id that isn't a plain filename", async () => {
    expect(await archive.write(record({ harnessSessionId: "../escape" }))).toBeNull();
    expect(errors).toHaveLength(1);
    expect(await archive.read("../escape")).toBeNull();
  });

  it("treats a corrupt or foreign file as absent instead of throwing", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "sess-broken.json"), "{not json", "utf8");
    await fs.writeFile(path.join(root, "sess-partial.json"), JSON.stringify({ turns: [] }), "utf8");
    await fs.writeFile(path.join(root, "notes.txt"), "ignore me", "utf8");

    expect(await archive.read("sess-broken")).toBeNull();
    expect(await archive.read("sess-partial")).toBeNull();
    expect(await archive.list()).toEqual([]);
  });

  it("picks up a record written by another process after its index was built", async () => {
    await archive.write(record({ harnessSessionId: "sess-a", agentSessionId: "agent-1" }));
    // Build the index (the alias lookup path is the only one that uses it).
    expect((await archive.read("agent-1"))?.harnessSessionId).toBe("sess-a");

    const foreign = compactSessionRecord(
      record({ harnessSessionId: "sess-z", mergedSessionIds: ["sess-z"], agentSessionId: "agent-9" }),
      { archivedAt: "2026-07-05T00:00:00.000Z" },
    );
    await fs.writeFile(path.join(root, "sess-z.json"), JSON.stringify(foreign), "utf8");

    // Found by its alias, which means the cached index was rebuilt — the
    // directory's mtime moved when the file appeared.
    expect((await archive.read("agent-9"))?.harnessSessionId).toBe("sess-z");
  });

  it("sweeps records past the age cap and keeps the rest", async () => {
    let clock = Date.parse("2026-07-01T00:00:00.000Z");
    const aging = createRecordArchive({ root, maxAgeMs: 30 * DAY_MS, now: () => clock });

    await aging.write(record({ harnessSessionId: "sess-old", mergedSessionIds: ["sess-old"] }));
    clock += 40 * DAY_MS;
    await aging.write(record({ harnessSessionId: "sess-new", mergedSessionIds: ["sess-new"] }));

    // Both were inside the cap when written; it's the sweep at the later clock
    // that expires the first one.
    expect(await aging.sweep()).toEqual(["sess-old"]);
    expect(await aging.read("sess-old")).toBeNull();
    expect(await aging.read("sess-new")).not.toBeNull();
  });

  it("sweeps oldest-first down to the total byte cap", async () => {
    let clock = Date.parse("2026-07-01T00:00:00.000Z");
    const capped = createRecordArchive({ root, maxTotalBytes: 2500, now: () => clock });

    for (const id of ["sess-1", "sess-2", "sess-3", "sess-4"]) {
      await capped.write(
        record({
          harnessSessionId: id,
          mergedSessionIds: [id],
          agentSessionId: `agent-${id}`,
          turns: [turn(1, { assistantText: "a".repeat(700) })],
        }),
      );
      clock += 60_000;
    }

    expect(await capped.sweep()).toContain("sess-1");
    const kept = await capped.list();
    const total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(total).toBeLessThanOrEqual(2500);
    // Newest survive; the oldest paid for them.
    expect(kept.map((entry) => entry.harnessSessionId)).toContain("sess-4");
    expect(await capped.read("sess-1")).toBeNull();
  });
});

describe("backfillSessionRecords", () => {
  let root: string;
  let archive: RecordArchive;

  beforeEach(async () => {
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "harness-backfill-test-")), "records");
    archive = createRecordArchive({ root });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("archives what the log holds and the archive doesn't, skipping live and already-archived sessions", async () => {
    await archive.write(record({ harnessSessionId: "sess-done", mergedSessionIds: ["sess-done"], agentSessionId: null }));
    const read = new Set<string>();

    const archived = await backfillSessionRecords({
      conversationIds: async () => ["sess-live", "sess-done", "sess-missing"],
      readFromEvents: async (id) => {
        read.add(id);
        return record({ harnessSessionId: id, mergedSessionIds: [id], agentSessionId: null });
      },
      archive,
      isLiveSession: (id) => id === "sess-live",
    });

    expect(archived).toEqual(["sess-missing"]);
    // A live session is never even folded — the point is not to store a
    // half-finished record over the one its exit will write.
    expect([...read]).toEqual(["sess-missing"]);
    expect(await archive.has("sess-live")).toBe(false);
  });

  it("stops at its cap and reports what it left behind", async () => {
    const capped: number[] = [];
    const archived = await backfillSessionRecords({
      conversationIds: async () => ["a", "b", "c", "d"],
      readFromEvents: async (id) => record({ harnessSessionId: id, mergedSessionIds: [id], agentSessionId: null }),
      archive,
      maxRecords: 2,
      onCapped: (remaining) => capped.push(remaining),
    });

    expect(archived).toEqual(["a", "b"]);
    expect(capped).toEqual([2]);
  });

  it("skips a conversation the fold has nothing for, without failing the pass", async () => {
    const archived = await backfillSessionRecords({
      conversationIds: async () => ["gone", "here"],
      readFromEvents: async (id) =>
        id === "gone" ? null : record({ harnessSessionId: id, mergedSessionIds: [id], agentSessionId: null }),
      archive,
    });
    expect(archived).toEqual(["here"]);
  });
});
