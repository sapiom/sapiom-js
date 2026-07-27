import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalyticsEvent } from "../../shared/types.js";
import { createEventStore } from "./store.js";

const sampleEvent: AnalyticsEvent = {
  eventId: "evt-1",
  seq: 1,
  ts: "2026-07-08T00:00:00.000Z",
  userId: null,
  tenantId: null,
  machineId: "machine-1",
  harnessSessionId: "session-1",
  agentSessionId: null,
  harness: "claude-code",
  type: "session.start",
  payload: { source: "startup" },
};

describe("createEventStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the parent directory and appends one ndjson line per event", async () => {
    const filePath = path.join(tmpDir, "nested", "events.ndjson");
    const store = createEventStore(filePath);

    await store.append(sampleEvent);
    await store.append({ ...sampleEvent, eventId: "evt-2" });

    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).eventId).toBe("evt-1");
    expect(JSON.parse(lines[1]).eventId).toBe("evt-2");
  });

  it("expands a leading ~ in the default path shape", async () => {
    // Use an explicit tmp path but confirm the store doesn't choke on a
    // relative-looking filePath (mirrors HARNESS_PATHS.events shape).
    const filePath = path.join(tmpDir, "events.ndjson");
    const store = createEventStore(filePath);
    await store.append(sampleEvent);
    const content = await fs.readFile(filePath, "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("appends concurrently without losing lines", async () => {
    const filePath = path.join(tmpDir, "events.ndjson");
    const store = createEventStore(filePath);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.append({ ...sampleEvent, eventId: `evt-${i}` })),
    );

    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(20);
  });

  describe("read", () => {
    /** Collect an async iterable into an array. */
    async function collect(events: AsyncIterable<AnalyticsEvent>): Promise<AnalyticsEvent[]> {
      const out: AnalyticsEvent[] = [];
      for await (const event of events) out.push(event);
      return out;
    }

    function at(session: string, eventId: string, extra: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
      return { ...sampleEvent, harnessSessionId: session, eventId, ...extra };
    }

    it("yields nothing for a file that doesn't exist yet", async () => {
      const store = createEventStore(path.join(tmpDir, "absent.ndjson"));
      expect(await collect(store.read())).toEqual([]);
      expect(await collect(store.read({ harnessSessionId: "session-1" }))).toEqual([]);
      expect((await store.index()).bySession.size).toBe(0);
    });

    it("streams every event when unfiltered, in file order", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append(at("session-1", "evt-1"));
      await store.append(at("session-2", "evt-2"));
      await store.append(at("session-1", "evt-3"));

      expect((await collect(store.read())).map((e) => e.eventId)).toEqual(["evt-1", "evt-2", "evt-3"]);
    });

    it("filters by harnessSessionId across an interleaved log", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append(at("session-1", "evt-1"));
      await store.append(at("session-2", "evt-2"));
      await store.append(at("session-1", "evt-3"));
      await store.append(at("session-3", "evt-4"));

      expect((await collect(store.read({ harnessSessionId: "session-1" }))).map((e) => e.eventId)).toEqual([
        "evt-1",
        "evt-3",
      ]);
      // Several sessions at once (a conversation spanning a resume) still comes
      // back in file order, not grouped by session.
      expect(
        (await collect(store.read({ harnessSessionId: ["session-3", "session-2"] }))).map((e) => e.eventId),
      ).toEqual(["evt-2", "evt-4"]);
    });

    it("filters by event type", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append(at("session-1", "evt-1", { type: "session.start" }));
      await store.append(at("session-1", "evt-2", { type: "prompt.submitted" }));
      await store.append(at("session-1", "evt-3", { type: "tool.call" }));

      expect(
        (await collect(store.read({ harnessSessionId: "session-1", types: ["prompt.submitted"] }))).map(
          (e) => e.eventId,
        ),
      ).toEqual(["evt-2"]);
      expect((await collect(store.read({ types: ["tool.call"] }))).map((e) => e.eventId)).toEqual(["evt-3"]);
    });

    it("skips a torn final line, a blank line, and a non-event line", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      await fs.writeFile(
        filePath,
        [
          JSON.stringify(at("session-1", "evt-1")),
          "",
          // Valid JSON, but not an event (no harnessSessionId) — a foreign
          // writer, or a schema from the future.
          JSON.stringify({ hello: "world" }),
          JSON.stringify(at("session-1", "evt-2")),
          // Torn: no trailing newline, cut mid-object.
          JSON.stringify(at("session-1", "evt-3")).slice(0, 40),
        ].join("\n"),
        "utf8",
      );
      const store = createEventStore(filePath);

      expect((await collect(store.read())).map((e) => e.eventId)).toEqual(["evt-1", "evt-2"]);
      expect((await collect(store.read({ harnessSessionId: "session-1" }))).map((e) => e.eventId)).toEqual([
        "evt-1",
        "evt-2",
      ]);
    });

    it("reads correct spans when a payload contains multi-byte characters", async () => {
      // Byte offsets, not character counts: a single emoji would shift every
      // subsequent span if the index counted characters.
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append(at("session-1", "evt-1", { payload: { prompt: "héllo 🌍 —" } }));
      await store.append(at("session-2", "evt-2", { payload: { prompt: "ünïcödé" } }));
      await store.append(at("session-1", "evt-3", { payload: { prompt: "🚀🚀🚀" } }));

      expect((await collect(store.read({ harnessSessionId: "session-1" }))).map((e) => e.eventId)).toEqual([
        "evt-1",
        "evt-3",
      ]);
      expect(
        (await collect(store.read({ harnessSessionId: "session-1" }))).map((e) => e.payload.prompt),
      ).toEqual(["héllo 🌍 —", "🚀🚀🚀"]);
    });

    it("does not block behind an in-flight exclusive run", async () => {
      // Reads deliberately live outside the append queue. If they didn't, this
      // read would hang until the exclusive block released.
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append(at("session-1", "evt-1"));

      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const exclusive = store.runExclusive(() => held);

      const events = await collect(store.read({ harnessSessionId: "session-1" }));
      expect(events.map((e) => e.eventId)).toEqual(["evt-1"]);

      release();
      await exclusive;
    });
  });

  describe("index", () => {
    it("counts prompts as turns and tracks agent session ids", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, eventId: "evt-1", type: "session.start", agentSessionId: "agent-1" });
      await store.append({ ...sampleEvent, eventId: "evt-2", type: "prompt.submitted", agentSessionId: "agent-1" });
      await store.append({ ...sampleEvent, eventId: "evt-3", type: "tool.call", agentSessionId: "agent-1" });
      await store.append({ ...sampleEvent, eventId: "evt-4", type: "prompt.submitted", agentSessionId: "agent-1" });

      const index = await store.index();
      const entry = index.bySession.get("session-1");
      expect(entry).toMatchObject({
        harnessSessionId: "session-1",
        eventCount: 4,
        turnCount: 2,
        agentSessionIds: ["agent-1"],
        harness: "claude-code",
      });
      expect(index.byAgentSession.get("agent-1")).toEqual(["session-1"]);
      // Contiguous lines collapse into one span rather than one per line.
      expect(entry?.spans).toHaveLength(1);
    });

    it("maps one agent session to every harness session that reported it", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, harnessSessionId: "session-1", eventId: "evt-1", agentSessionId: "agent-1" });
      await store.append({ ...sampleEvent, harnessSessionId: "session-2", eventId: "evt-2", agentSessionId: "agent-1" });

      const index = await store.index();
      expect(index.byAgentSession.get("agent-1")).toEqual(["session-1", "session-2"]);
    });

    it("absorbs our own appends on the next read", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, eventId: "evt-1", type: "prompt.submitted" });
      expect((await store.index()).bySession.get("session-1")?.turnCount).toBe(1);

      await store.append({ ...sampleEvent, eventId: "evt-2", type: "prompt.submitted" });
      expect((await store.index()).bySession.get("session-1")?.turnCount).toBe(2);
      expect((await store.index()).bySession.get("session-1")?.eventCount).toBe(2);
    });

    it("picks up a foreign process's appends via the size check", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, eventId: "evt-1", type: "prompt.submitted" });
      await store.index(); // build

      // A second harness boot writing to the same ~/.sapiom/harness/events.ndjson.
      await fs.appendFile(
        filePath,
        `${JSON.stringify({ ...sampleEvent, eventId: "evt-foreign", type: "prompt.submitted" })}\n`,
        "utf8",
      );

      const index = await store.index();
      expect(index.bySession.get("session-1")?.turnCount).toBe(2);
      const events: string[] = [];
      for await (const event of store.read({ harnessSessionId: "session-1" })) events.push(event.eventId);
      expect(events).toEqual(["evt-1", "evt-foreign"]);
    });

    it("rebuilds after a retention sweep rewrites the file", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, eventId: "evt-old", type: "prompt.submitted" });
      await store.append({ ...sampleEvent, eventId: "evt-new", type: "prompt.submitted" });
      expect((await store.index()).bySession.get("session-1")?.turnCount).toBe(2);

      // What sweepNdjson does: write a trimmed temp file, then rename over the
      // original — a new inode, and every offset we held is meaningless.
      await store.runExclusive(async () => {
        const tmpPath = path.join(tmpDir, "sweep.tmp");
        await fs.writeFile(
          tmpPath,
          `${JSON.stringify({ ...sampleEvent, eventId: "evt-new", type: "prompt.submitted" })}\n`,
          "utf8",
        );
        await fs.rename(tmpPath, filePath);
      });

      const index = await store.index();
      expect(index.bySession.get("session-1")?.turnCount).toBe(1);
      const events: string[] = [];
      for await (const event of store.read({ harnessSessionId: "session-1" })) events.push(event.eventId);
      expect(events).toEqual(["evt-new"]);
    });

    it("counts each event exactly once when reads and appends interleave", async () => {
      // The invariant that catches the nasty one: a reader's reconcile can stat
      // a size that already includes an append still in flight, so both paths
      // can see the same line. Recording it twice would inflate the counts and
      // put every later offset one line out.
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, eventId: "evt-0", type: "prompt.submitted" });
      await store.index(); // build, so appends take the maintain-in-place path

      await Promise.all([
        ...Array.from({ length: 30 }, (_, i) =>
          store.append({ ...sampleEvent, eventId: `evt-${i + 1}`, type: "prompt.submitted" }),
        ),
        ...Array.from({ length: 30 }, () => store.index()),
      ]);

      const entry = (await store.index()).bySession.get("session-1");
      expect(entry?.eventCount).toBe(31);
      expect(entry?.turnCount).toBe(31);
      // One session, so its spans must cover the whole file exactly once —
      // any double-record shows up here as a wrong end offset.
      expect(entry?.spans).toEqual([{ start: 0, end: (await fs.stat(filePath)).size }]);

      const ids: string[] = [];
      for await (const event of store.read({ harnessSessionId: "session-1" })) ids.push(event.eventId);
      expect(ids).toHaveLength(31);
      expect(new Set(ids).size).toBe(31);
    });

    it("indexes a final event that has no trailing newline, without re-counting it", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ ...sampleEvent, eventId: "evt-1", type: "prompt.submitted" })}\n` +
          // A complete event, but the file ends without a newline.
          JSON.stringify({ ...sampleEvent, eventId: "evt-2", type: "prompt.submitted" }),
        "utf8",
      );
      const store = createEventStore(filePath);

      expect((await store.index()).bySession.get("session-1")?.turnCount).toBe(2);
      // A second reconcile must not fold that last line in again.
      expect((await store.index()).bySession.get("session-1")?.turnCount).toBe(2);
      const ids: string[] = [];
      for await (const event of store.read({ harnessSessionId: "session-1" })) ids.push(event.eventId);
      expect(ids).toEqual(["evt-1", "evt-2"]);
    });

    it("re-reads a torn tail once it is followed by a whole line", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const whole = JSON.stringify({ ...sampleEvent, eventId: "evt-1", type: "prompt.submitted" });
      // Simulates catching an append in flight: the line is on disk but its
      // newline (and part of its body) isn't yet.
      await fs.writeFile(filePath, whole.slice(0, 30), "utf8");
      const store = createEventStore(filePath);
      expect((await store.index()).bySession.size).toBe(0);

      // The rest of the line lands. Because the index rewound rather than
      // claiming the partial bytes, the completed line is picked up.
      await fs.writeFile(filePath, `${whole}\n`, "utf8");
      expect((await store.index()).bySession.get("session-1")?.turnCount).toBe(1);
    });

    it("shares one scan between concurrent readers", async () => {
      const filePath = path.join(tmpDir, "events.ndjson");
      const store = createEventStore(filePath);
      await store.append({ ...sampleEvent, eventId: "evt-1", type: "prompt.submitted" });

      const [a, b, c] = await Promise.all([store.index(), store.index(), store.index()]);
      // Same maps, and each session counted exactly once (a double scan would
      // have doubled turnCount).
      expect(a.bySession).toBe(b.bySession);
      expect(c.bySession.get("session-1")?.turnCount).toBe(1);
    });
  });
});
