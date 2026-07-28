import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalyticsEvent, AnalyticsEventType } from "../shared/types.js";
import { createEventStore } from "./collector/store.js";
import { createRecordArchive, type RecordArchive } from "./record-archive.js";
import {
  createClaudeTranscriptEnricher,
  createSessionRecordReader,
  foldSessionRecord,
  sortEventsForFold,
} from "./session-record.js";

// ---------------------------------------------------------------------------
// Fixture builders — a compact way to spell out an event stream, so each test
// reads as the *shape* it covers rather than as a wall of JSON.
// ---------------------------------------------------------------------------

interface EventSpec {
  type: AnalyticsEventType;
  ts: string;
  seq?: number;
  session?: string;
  agentSessionId?: string | null;
  payload?: Record<string, unknown>;
}

let eventCounter = 0;

function event(spec: EventSpec): AnalyticsEvent {
  eventCounter += 1;
  return {
    eventId: `evt-${eventCounter}`,
    seq: spec.seq ?? 1,
    ts: spec.ts,
    userId: null,
    tenantId: null,
    machineId: "machine-1",
    harnessSessionId: spec.session ?? "sess-a",
    agentSessionId: spec.agentSessionId ?? null,
    harness: "claude-code",
    type: spec.type,
    payload: spec.payload ?? {},
  };
}

const prompt = (ts: string, text: string, rest: Partial<EventSpec> = {}): AnalyticsEvent =>
  event({ type: "prompt.submitted", ts, payload: { prompt: text }, ...rest });

const tool = (ts: string, name: string, rest: Partial<EventSpec> = {}): AnalyticsEvent =>
  event({
    type: "tool.call",
    ts,
    payload: { toolName: name, toolInput: "{}", toolResponseSummary: "ok" },
    ...rest,
  });

const completed = (ts: string, text: string | null, rest: Partial<EventSpec> = {}): AnalyticsEvent =>
  event({
    type: "turn.completed",
    ts,
    payload: {
      assistantText: text,
      model: "claude-opus-4-6",
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    ...rest,
  });

describe("foldSessionRecord", () => {
  it("folds prompt → tool calls → completion into one closed turn", () => {
    const record = foldSessionRecord([
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd: "/repo" } }),
      prompt("2026-07-01T10:00:01.000Z", "add the screening step"),
      tool("2026-07-01T10:00:02.000Z", "Read"),
      tool("2026-07-01T10:00:03.000Z", "Edit"),
      completed("2026-07-01T10:00:04.000Z", "Added it."),
      event({ type: "session.end", ts: "2026-07-01T10:00:05.000Z", payload: { reason: "exit" } }),
    ]);

    expect(record.cwd).toBe("/repo");
    expect(record.startedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(record.endedAt).toBe("2026-07-01T10:00:05.000Z");
    expect(record.reconstructed).toBe(true);
    expect(record.turnCount).toBe(1);
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]).toMatchObject({
      index: 1,
      prompt: "add the screening step",
      assistantText: "Added it.",
      model: "claude-opus-4-6",
      usage: { inputTokens: 100, outputTokens: 20 },
      completedAt: "2026-07-01T10:00:04.000Z",
      incomplete: false,
    });
    expect(record.turns[0].toolCalls.map((call) => call.name)).toEqual(["Read", "Edit"]);
  });

  it("orders by (ts, seq), so a seq restart across a resume doesn't reorder turns", () => {
    // The real shape from a resumed session: the pty's second process restarts
    // the per-session counter, so seq reads 1, 2 then 1, 1, 1.
    const record = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "first", { seq: 1 }),
      completed("2026-07-01T10:00:01.000Z", "first reply", { seq: 2 }),
      prompt("2026-07-01T11:00:00.000Z", "second", { seq: 1 }),
      tool("2026-07-01T11:00:01.000Z", "Bash", { seq: 1 }),
      completed("2026-07-01T11:00:02.000Z", "second reply", { seq: 1 }),
    ]);

    expect(record.turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
    expect(record.turns[1].toolCalls.map((call) => call.name)).toEqual(["Bash"]);
    // Sorting by seq alone would have put the resume's events first.
    expect(record.turns[0].assistantText).toBe("first reply");
  });

  it("breaks same-ts ties by seq", () => {
    const ordered = sortEventsForFold([
      completed("2026-07-01T10:00:00.000Z", "reply", { seq: 2 }),
      prompt("2026-07-01T10:00:00.000Z", "ask", { seq: 1 }),
    ]);
    expect(ordered.map((e) => e.type)).toEqual(["prompt.submitted", "turn.completed"]);
  });

  it("keeps a trailing open turn and marks it incomplete", () => {
    const record = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "deploy it"),
      tool("2026-07-01T10:00:01.000Z", "Bash"),
      // No turn.completed: the session was killed mid-turn.
    ]);

    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]).toMatchObject({ prompt: "deploy it", incomplete: true, completedAt: null });
    expect(record.turns[0].toolCalls).toHaveLength(1);
    expect(record.limitations).toContain("incomplete-final-turn");
  });

  it("session.end never closes the open turn — a session that died mid-turn says so", () => {
    const record = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "deploy it"),
      event({ type: "session.end", ts: "2026-07-01T10:00:01.000Z", payload: { reason: "other" } }),
    ]);

    expect(record.turns[0].incomplete).toBe(true);
    expect(record.endedAt).toBe("2026-07-01T10:00:01.000Z");
  });

  it("gives a tool.call with no enclosing turn its own promptless turn", () => {
    const record = foldSessionRecord([
      tool("2026-07-01T10:00:00.000Z", "Read"),
      completed("2026-07-01T10:00:01.000Z", "done"),
      prompt("2026-07-01T10:00:02.000Z", "and now this"),
      completed("2026-07-01T10:00:03.000Z", "ok"),
    ]);

    expect(record.turns).toHaveLength(2);
    expect(record.turns[0].prompt).toBeNull();
    expect(record.turns[0].toolCalls).toHaveLength(1);
    expect(record.turns[0].assistantText).toBe("done");
    // turnCount counts HUMAN prompts, so the promptless turn isn't one.
    expect(record.turnCount).toBe(1);
  });

  it("gives a turn.completed with nothing open its own promptless turn", () => {
    const record = foldSessionRecord([completed("2026-07-01T10:00:00.000Z", "unprompted")]);
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]).toMatchObject({ prompt: null, assistantText: "unprompted", incomplete: false });
  });

  it("a second prompt closes the open turn as incomplete rather than dropping it", () => {
    const record = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "first"),
      tool("2026-07-01T10:00:01.000Z", "Read"),
      prompt("2026-07-01T10:00:02.000Z", "actually, do this instead"),
      completed("2026-07-01T10:00:03.000Z", "did the second"),
    ]);

    expect(record.turns).toHaveLength(2);
    expect(record.turns[0]).toMatchObject({ prompt: "first", incomplete: true });
    expect(record.turns[0].toolCalls).toHaveLength(1);
    expect(record.turns[1]).toMatchObject({ prompt: "actually, do this instead", incomplete: false });
    // The incomplete turn isn't the LAST one, so that limitation doesn't apply.
    expect(record.limitations).not.toContain("incomplete-final-turn");
  });

  it("reports a truncated tool result as a limitation and on the call itself", () => {
    const record = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "read the big file"),
      event({
        type: "tool.call",
        ts: "2026-07-01T10:00:01.000Z",
        payload: {
          toolName: "Read",
          toolInput: "{}",
          toolResponseSummary: "the first part…[truncated 4096 chars]",
        },
      }),
      completed("2026-07-01T10:00:02.000Z", "read it"),
    ]);

    expect(record.turns[0].toolCalls[0].responseTruncated).toBe(true);
    expect(record.limitations).toContain("truncated-tool-output");
  });

  it("flags the narration gap only when a turn has both tool calls and a reply", () => {
    const withTools = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "go"),
      tool("2026-07-01T10:00:01.000Z", "Read"),
      completed("2026-07-01T10:00:02.000Z", "done"),
    ]);
    expect(withTools.limitations).toContain("assistant-narration-gap");

    const noTools = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "go"),
      completed("2026-07-01T10:00:01.000Z", "done"),
    ]);
    expect(noTools.limitations).not.toContain("assistant-narration-gap");
  });

  it("flags missing assistant text — the Codex shape (no Stop-hook message)", () => {
    const record = foldSessionRecord([
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd: "/repo" } }),
      prompt("2026-07-01T10:00:01.000Z", "summarize this"),
      tool("2026-07-01T10:00:02.000Z", "shell"),
      // The codex tailer emits Stop with no last_assistant_message, so the
      // normalizer records assistantText: null and no model/usage.
      event({ type: "turn.completed", ts: "2026-07-01T10:00:03.000Z", payload: { stopHookActive: false, assistantText: null } }),
    ]);

    expect(record.turns[0]).toMatchObject({ assistantText: null, model: null, usage: null, incomplete: false });
    expect(record.turns[0].toolCalls).toHaveLength(1);
    expect(record.limitations).toContain("missing-assistant-text");
  });

  it("ignores UI-interaction events, counting them but never rendering them as turns", () => {
    const record = foldSessionRecord([
      prompt("2026-07-01T10:00:00.000Z", "go"),
      event({ type: "macro.invoked", ts: "2026-07-01T10:00:01.000Z", payload: { surface: "ui" } }),
      completed("2026-07-01T10:00:02.000Z", "done"),
    ]);

    expect(record.turns).toHaveLength(1);
    expect(record.eventCount).toBe(3);
  });

  it("is empty, not broken, for a session with no events", () => {
    const record = foldSessionRecord([]);
    expect(record).toMatchObject({ turns: [], turnCount: 0, eventCount: 0, limitations: [], reconstructed: true });
  });
});

// ---------------------------------------------------------------------------
// Reader — over a real ndjson file, which is where interleaving, torn lines
// and the index actually matter.
// ---------------------------------------------------------------------------

describe("createSessionRecordReader", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-record-test-"));
    filePath = path.join(tmpDir, "events.ndjson");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeEvents(events: AnalyticsEvent[]): Promise<void> {
    await fs.writeFile(filePath, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
  }

  it("reads one session's record out of an interleaved log", async () => {
    await writeEvents([
      prompt("2026-07-01T10:00:00.000Z", "A first", { session: "sess-a" }),
      prompt("2026-07-01T10:00:01.000Z", "B first", { session: "sess-b" }),
      tool("2026-07-01T10:00:02.000Z", "ReadA", { session: "sess-a" }),
      tool("2026-07-01T10:00:03.000Z", "ReadB", { session: "sess-b" }),
      completed("2026-07-01T10:00:04.000Z", "B reply", { session: "sess-b" }),
      completed("2026-07-01T10:00:05.000Z", "A reply", { session: "sess-a" }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath));
    const recordA = await reader.read("sess-a");
    const recordB = await reader.read("sess-b");

    expect(recordA?.turns).toHaveLength(1);
    expect(recordA?.turns[0].prompt).toBe("A first");
    expect(recordA?.turns[0].assistantText).toBe("A reply");
    expect(recordA?.turns[0].toolCalls.map((c) => c.name)).toEqual(["ReadA"]);
    expect(recordA?.mergedSessionIds).toEqual(["sess-a"]);

    expect(recordB?.turns[0].prompt).toBe("B first");
    expect(recordB?.turns[0].toolCalls.map((c) => c.name)).toEqual(["ReadB"]);
  });

  it("tolerates a torn final line (crash mid-append) and still renders the rest", async () => {
    await writeEvents([
      prompt("2026-07-01T10:00:00.000Z", "go"),
      completed("2026-07-01T10:00:01.000Z", "done"),
    ]);
    // A half-written line with no trailing newline — exactly what a crash
    // between write() and flush leaves behind.
    const torn = JSON.stringify(tool("2026-07-01T10:00:02.000Z", "Read")).slice(0, 60);
    await fs.appendFile(filePath, torn, "utf8");

    const reader = createSessionRecordReader(createEventStore(filePath));
    const record = await reader.read("sess-a");

    expect(record?.turns).toHaveLength(1);
    expect(record?.turns[0].assistantText).toBe("done");
    expect(record?.eventCount).toBe(2);
  });

  it("looks a record up by the agent's session id too (transcript-only rows)", async () => {
    await writeEvents([
      prompt("2026-07-01T10:00:00.000Z", "go", { agentSessionId: "agent-1" }),
      completed("2026-07-01T10:00:01.000Z", "done", { agentSessionId: "agent-1" }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath));
    const record = await reader.read("agent-1");
    expect(record?.harnessSessionId).toBe("sess-a");
    expect(record?.agentSessionId).toBe("agent-1");
  });

  it("merges harness sessions that share an agent session (a resumed conversation)", async () => {
    await writeEvents([
      prompt("2026-07-01T10:00:00.000Z", "first", { session: "sess-a", agentSessionId: "agent-1" }),
      completed("2026-07-01T10:00:01.000Z", "first reply", { session: "sess-a", agentSessionId: "agent-1" }),
      prompt("2026-07-01T11:00:00.000Z", "second", { session: "sess-b", agentSessionId: "agent-1" }),
      completed("2026-07-01T11:00:01.000Z", "second reply", { session: "sess-b", agentSessionId: "agent-1" }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath));
    const record = await reader.read("sess-b");
    expect(record?.mergedSessionIds).toEqual(["sess-a", "sess-b"]);
    expect(record?.harnessSessionId).toBe("sess-a");
    expect(record?.turns.map((t) => t.prompt)).toEqual(["first", "second"]);
    // Every key reports the whole conversation, so a history row can't
    // contradict the record it links to whichever id it was keyed by.
    const counts = await reader.turnCounts();
    expect(counts.get("agent-1")).toBe(2);
    expect(counts.get("sess-a")).toBe(2);
    expect(counts.get("sess-b")).toBe(2);
    expect(record?.turnCount).toBe(2);
  });

  it("returns null for an unknown session and for a missing events file", async () => {
    await writeEvents([prompt("2026-07-01T10:00:00.000Z", "go")]);
    const reader = createSessionRecordReader(createEventStore(filePath));
    expect(await reader.read("nope")).toBeNull();

    const absent = createSessionRecordReader(createEventStore(path.join(tmpDir, "gone.ndjson")));
    expect(await absent.read("sess-a")).toBeNull();
    expect(await absent.turnCounts()).toEqual(new Map());
  });

  it("exposes exact turn counts keyed by both harness and agent session id", async () => {
    await writeEvents([
      prompt("2026-07-01T10:00:00.000Z", "one", { session: "sess-a", agentSessionId: "agent-1" }),
      completed("2026-07-01T10:00:01.000Z", "ok", { session: "sess-a", agentSessionId: "agent-1" }),
      prompt("2026-07-01T10:00:02.000Z", "two", { session: "sess-a", agentSessionId: "agent-1" }),
      prompt("2026-07-01T10:00:03.000Z", "elsewhere", { session: "sess-b" }),
    ]);

    const counts = await createSessionRecordReader(createEventStore(filePath)).turnCounts();
    expect(counts.get("sess-a")).toBe(2);
    expect(counts.get("agent-1")).toBe(2);
    expect(counts.get("sess-b")).toBe(1);
  });

  it("sees events appended after the index was built", async () => {
    const store = createEventStore(filePath);
    await store.append(prompt("2026-07-01T10:00:00.000Z", "first"));
    const reader = createSessionRecordReader(store);
    expect((await reader.read("sess-a"))?.turns).toHaveLength(1);

    await store.append(completed("2026-07-01T10:00:01.000Z", "done"));
    await store.append(prompt("2026-07-01T10:00:02.000Z", "second"));

    const record = await reader.read("sess-a");
    expect(record?.turns.map((t) => t.prompt)).toEqual(["first", "second"]);
    expect(record?.turns[0].assistantText).toBe("done");
  });

  it("still renders when the vendor transcript is gone — enrichment is optional", async () => {
    await writeEvents([
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd: "/repo/does-not-exist" } }),
      prompt("2026-07-01T10:00:01.000Z", "go", { agentSessionId: "agent-missing" }),
      event({ type: "turn.completed", ts: "2026-07-01T10:00:02.000Z", payload: { assistantText: null } }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath), {
      // Points at a home directory with no ~/.claude/projects at all.
      enrichFinalTurn: createClaudeTranscriptEnricher({ homeDir: path.join(tmpDir, "home") }),
    });

    const record = await reader.read("sess-a");
    expect(record?.turns).toHaveLength(1);
    expect(record?.turns[0].assistantText).toBeNull();
    expect(record?.limitations).toContain("missing-assistant-text");
  });

  it("fills the final turn's model/usage from the vendor transcript when it IS present", async () => {
    const cwd = "/repo/enriched";
    const homeDir = path.join(tmpDir, "home");
    // Mirrors Claude Code's own encoding of a project path (see the adapter).
    const projectDir = path.join(homeDir, ".claude", "projects", cwd.replace(/:/g, "").replace(/[/.]/g, "-"));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent-enriched.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "from the transcript" }],
          usage: { input_tokens: 42, output_tokens: 7 },
        },
      })}\n`,
      "utf8",
    );

    await writeEvents([
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd } }),
      prompt("2026-07-01T10:00:01.000Z", "go", { agentSessionId: "agent-enriched" }),
      event({
        type: "turn.completed",
        ts: "2026-07-01T10:00:02.000Z",
        agentSessionId: "agent-enriched",
        payload: { assistantText: null },
      }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath), {
      enrichFinalTurn: createClaudeTranscriptEnricher({ homeDir }),
    });

    const record = await reader.read("sess-a");
    expect(record?.turns[0]).toMatchObject({
      assistantText: "from the transcript",
      model: "claude-opus-4-6",
      usage: { inputTokens: 42, outputTokens: 7 },
    });
    // The enrichment closed the gap, so the record stops claiming it.
    expect(record?.limitations).not.toContain("missing-assistant-text");
  });

  it("recomputes limitations after enrichment — filling a turn can OPEN a gap", async () => {
    // The turn has tool calls and no assistant text: our events report
    // `missing-assistant-text` and (correctly) not the narration gap. Enrichment
    // supplies the turn's FINAL message, which closes the first gap and opens
    // the second — whatever the agent said between those tool calls is still
    // missing. Patching the one code instead of recomputing under-reported it.
    const cwd = "/repo/reopens-gap";
    const homeDir = path.join(tmpDir, "home");
    const projectDir = path.join(homeDir, ".claude", "projects", cwd.replace(/:/g, "").replace(/[/.]/g, "-"));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent-gap.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-4-6", content: "the final word" },
      })}\n`,
      "utf8",
    );

    await writeEvents([
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd } }),
      prompt("2026-07-01T10:00:01.000Z", "go", { agentSessionId: "agent-gap" }),
      tool("2026-07-01T10:00:02.000Z", "Read", { agentSessionId: "agent-gap" }),
      event({
        type: "turn.completed",
        ts: "2026-07-01T10:00:03.000Z",
        agentSessionId: "agent-gap",
        payload: { assistantText: null },
      }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath), {
      enrichFinalTurn: createClaudeTranscriptEnricher({ homeDir }),
    });

    const record = await reader.read("sess-a");
    expect(record?.turns[0].assistantText).toBe("the final word");
    expect(record?.limitations).not.toContain("missing-assistant-text");
    expect(record?.limitations).toContain("assistant-narration-gap");
  });

  it("finds the vendor transcript for a symlinked cwd (Claude stores the realpath)", async () => {
    // os.tmpdir() on macOS is itself a symlink (/var → /private/var), which is
    // exactly the case that silently no-ops when a caller skips the realpath.
    const cwd = path.join(tmpDir, "project");
    await fs.mkdir(cwd, { recursive: true });
    // The transcript is placed ONLY at the resolved encoding, so an enricher
    // that built the path from the raw cwd finds nothing and returns null.
    const resolvedCwd = await fs.realpath(cwd);
    const homeDir = path.join(tmpDir, "home");
    const projectDir = path.join(
      homeDir,
      ".claude",
      "projects",
      resolvedCwd.replace(/:/g, "").replace(/[/.]/g, "-"),
    );
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent-symlinked.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-4-6", content: "found via realpath" },
      })}\n`,
      "utf8",
    );

    await writeEvents([
      // The event carries the UNRESOLVED cwd, as the hook payload does.
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd } }),
      prompt("2026-07-01T10:00:01.000Z", "go", { agentSessionId: "agent-symlinked" }),
      event({
        type: "turn.completed",
        ts: "2026-07-01T10:00:02.000Z",
        agentSessionId: "agent-symlinked",
        payload: { assistantText: null },
      }),
    ]);

    const record = await createSessionRecordReader(createEventStore(filePath), {
      enrichFinalTurn: createClaudeTranscriptEnricher({ homeDir }),
    }).read("sess-a");

    expect(record?.cwd).toBe(cwd);
    expect(record?.turns[0].assistantText).toBe("found via realpath");
  });

  it("never lets enrichment overwrite what our own events recorded", async () => {
    const cwd = "/repo/ours-wins";
    const homeDir = path.join(tmpDir, "home");
    const projectDir = path.join(homeDir, ".claude", "projects", cwd.replace(/:/g, "").replace(/[/.]/g, "-"));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "agent-ours.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "some-other-model", content: "transcript text" },
      })}\n`,
      "utf8",
    );

    await writeEvents([
      event({ type: "session.start", ts: "2026-07-01T10:00:00.000Z", payload: { cwd } }),
      prompt("2026-07-01T10:00:01.000Z", "go", { agentSessionId: "agent-ours" }),
      event({
        type: "turn.completed",
        ts: "2026-07-01T10:00:02.000Z",
        agentSessionId: "agent-ours",
        payload: { assistantText: "ours", model: "claude-opus-4-6" },
      }),
    ]);

    const reader = createSessionRecordReader(createEventStore(filePath), {
      enrichFinalTurn: createClaudeTranscriptEnricher({ homeDir }),
    });

    const record = await reader.read("sess-a");
    expect(record?.turns[0].assistantText).toBe("ours");
    expect(record?.turns[0].model).toBe("claude-opus-4-6");
  });
});

// ---------------------------------------------------------------------------
// The archive-aware reader: which of the two sources a record comes from.
//
// Against the real archive rather than a stub, because the thing under test is
// the pair — a compacted file on disk and an event log retention has eaten
// into — and a stub of one of them would prove only that the branch runs.
// ---------------------------------------------------------------------------

describe("createSessionRecordReader with a record archive", () => {
  let tmpDir: string;
  let filePath: string;
  let recordsRoot: string;

  /** Long enough that the archive clips it and the live fold doesn't — the
   *  visible difference between the two sources. */
  const LONG_INPUT = JSON.stringify({ old_string: "x".repeat(2000) });
  const ARCHIVED_AT = "2026-07-01T11:00:00.000Z";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-record-archive-"));
    filePath = path.join(tmpDir, "events.ndjson");
    recordsRoot = path.join(tmpDir, "records");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeArchive(): RecordArchive {
    return createRecordArchive({ root: recordsRoot, now: () => Date.parse(ARCHIVED_AT) });
  }

  async function writeLines(events: AnalyticsEvent[]): Promise<void> {
    await fs.writeFile(filePath, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
  }

  /** The conversation every test here starts from: two completed turns, the
   *  first carrying a tool call whose input only the live log holds whole. */
  const conversation = (): AnalyticsEvent[] => [
    event({
      type: "session.start",
      ts: "2026-07-01T10:00:00.000Z",
      agentSessionId: "agent-1",
      payload: { cwd: "/repo" },
    }),
    prompt("2026-07-01T10:00:01.000Z", "first", { agentSessionId: "agent-1" }),
    event({
      type: "tool.call",
      ts: "2026-07-01T10:00:02.000Z",
      agentSessionId: "agent-1",
      payload: { toolName: "Edit", toolInput: LONG_INPUT, toolResponseSummary: "ok" },
    }),
    completed("2026-07-01T10:00:03.000Z", "first reply", { agentSessionId: "agent-1" }),
    prompt("2026-07-01T10:00:04.000Z", "second", { agentSessionId: "agent-1" }),
    completed("2026-07-01T10:00:05.000Z", "second reply", { agentSessionId: "agent-1" }),
  ];

  /** Fold the conversation and archive it, as the server does at session end. */
  async function archiveNow(archive: RecordArchive): Promise<void> {
    const source = createSessionRecordReader(createEventStore(filePath));
    const folded = await source.readFromEvents("sess-a");
    expect(folded).not.toBeNull();
    expect(await archive.write(folded!)).not.toBeNull();
  }

  it("falls back to the archive when the events behind it are gone", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);

    // What a 30-day sweep leaves behind for this session: nothing.
    await fs.writeFile(filePath, "", "utf8");

    const record = await createSessionRecordReader(createEventStore(filePath), { archive }).read("sess-a");
    expect(record?.turns.map((t) => t.prompt)).toEqual(["first", "second"]);
    expect(record?.archivedAt).toBe(ARCHIVED_AT);
    expect(record?.limitations).toContain("compacted-archive");
    // Reachable by the agent's own session id too, which is all a
    // transcript-sourced history row has.
    const byAgent = await createSessionRecordReader(createEventStore(filePath), { archive }).read("agent-1");
    expect(byAgent?.harnessSessionId).toBe("sess-a");
  });

  it("falls back to the archive when the sweep took the beginning of the conversation", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);

    // sweepNdjson truncates oldest-first: the last two lines survive.
    await writeLines(conversation().slice(-2));

    const record = await createSessionRecordReader(createEventStore(filePath), { archive }).read("sess-a");
    // The archive is the only source that still has the first turn.
    expect(record?.turns.map((t) => t.prompt)).toEqual(["first", "second"]);
    expect(record?.archivedAt).toBe(ARCHIVED_AT);
  });

  it("reads the live events while the log still covers the conversation — the archive is lossier", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);

    const record = await createSessionRecordReader(createEventStore(filePath), { archive }).read("sess-a");
    expect(record?.archivedAt).toBeNull();
    // The whole tool input, not the archive's 512-character excerpt.
    expect(record?.turns[0].toolCalls[0].input).toBe(LONG_INPUT);
    expect(record?.limitations).not.toContain("compacted-archive");
  });

  it("reads the live events when the conversation continued after it was archived", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);

    // Swept back to a suffix AND resumed afterwards: the archive predates the
    // new turn, so serving it would hide work the user just did.
    await writeLines([
      ...conversation().slice(-2),
      prompt("2026-07-01T12:00:00.000Z", "third"),
      completed("2026-07-01T12:00:01.000Z", "third reply"),
    ]);

    const record = await createSessionRecordReader(createEventStore(filePath), { archive }).read("sess-a");
    expect(record?.archivedAt).toBeNull();
    expect(record?.turns.map((t) => t.prompt)).toEqual(["second", "third"]);
  });

  it("scans events when nothing was ever archived, and reports honestly when neither source has anything", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    const reader = createSessionRecordReader(createEventStore(filePath), { archive });

    expect((await reader.read("sess-a"))?.turns).toHaveLength(2);
    expect(await reader.read("sess-never-existed")).toBeNull();

    await fs.writeFile(filePath, "", "utf8");
    expect(await reader.read("sess-a")).toBeNull();
  });

  it("readFromEvents ignores the archive entirely, so a re-archive never compacts a compacted record", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);
    const reader = createSessionRecordReader(createEventStore(filePath), { archive });

    await fs.writeFile(filePath, "", "utf8");
    expect(await reader.readFromEvents("sess-a")).toBeNull();
    // …while the archive-aware read still answers.
    expect(await reader.read("sess-a")).not.toBeNull();
  });

  it("keeps a history row's turn count after its events are swept", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);
    const reader = createSessionRecordReader(createEventStore(filePath), { archive });

    await fs.writeFile(filePath, "", "utf8");
    const counts = await reader.turnCounts();
    // Keyed by both ids, exactly as the live index keys them, so the row and
    // the record it opens can't disagree.
    expect(counts.get("sess-a")).toBe(2);
    expect(counts.get("agent-1")).toBe(2);
  });

  it("prefers the larger count when the log has moved on past the archive", async () => {
    await writeLines(conversation());
    const archive = makeArchive();
    await archiveNow(archive);

    await writeLines([
      ...conversation(),
      prompt("2026-07-01T12:00:00.000Z", "third"),
      completed("2026-07-01T12:00:01.000Z", "third reply"),
    ]);

    const counts = await createSessionRecordReader(createEventStore(filePath), { archive }).turnCounts();
    expect(counts.get("sess-a")).toBe(3);
  });

  it("lists conversations newest-first for the backfill, merging resumed segments", async () => {
    await writeLines([
      prompt("2026-07-01T10:00:00.000Z", "old", { session: "sess-old", agentSessionId: "agent-old" }),
      prompt("2026-07-02T10:00:00.000Z", "first", { session: "sess-a", agentSessionId: "agent-1" }),
      prompt("2026-07-03T10:00:00.000Z", "resumed", { session: "sess-b", agentSessionId: "agent-1" }),
    ]);

    const ids = await createSessionRecordReader(createEventStore(filePath)).conversationIds();
    // sess-a and sess-b are one conversation, named by where it began, and it
    // sorts ahead of the older one on its most recent activity.
    expect(ids).toEqual(["sess-a", "sess-old"]);
  });
});
