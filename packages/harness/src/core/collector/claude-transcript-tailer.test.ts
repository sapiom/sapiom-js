import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  tailClaudeTranscript,
  findClaudeTranscript,
  transcriptPathForSession,
  encodeProjectPath,
  agentSessionIdFromTranscriptPath,
  type ClaudeTranscriptTailerHandle,
} from "./claude-transcript-tailer.js";
import type { ChatTurn, ChatToolCall } from "../../shared/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 20;

// ---------------------------------------------------------------------------
// JSONL line helpers — mirrors Claude Code's transcript format
// ---------------------------------------------------------------------------

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

function userLineWithBlocks(blocks: unknown[]): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n";
}

function assistantLine(textOrBlocks: string | unknown[]): string {
  const content =
    typeof textOrBlocks === "string"
      ? [{ type: "text", text: textOrBlocks }]
      : textOrBlocks;
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content } }) + "\n";
}

function summaryLine(summary: string): string {
  return JSON.stringify({ type: "summary", summary }) + "\n";
}

function toolUseLine(id: string, name: string, input: unknown = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  }) + "\n";
}

function toolResultLine(toolUseId: string, output: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }],
    },
  }) + "\n";
}

function assistantWithTextAndTool(text: string, id: string, name: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool_use", id, name, input: {} },
      ],
    },
  }) + "\n";
}

// ---------------------------------------------------------------------------
// tailClaudeTranscript — incremental tailer
// ---------------------------------------------------------------------------

describe("tailClaudeTranscript", () => {
  let dir: string;
  let transcriptPath: string;
  let handle: ClaudeTranscriptTailerHandle | undefined;
  let onTurn: ReturnType<typeof vi.fn<(turn: ChatTurn) => void>>;
  let onToolCall: ReturnType<typeof vi.fn<(call: ChatToolCall) => void>>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-claude-tailer-"));
    transcriptPath = join(dir, "session.jsonl");
    onTurn = vi.fn();
    onToolCall = vi.fn();
    onError = vi.fn();
  });

  afterEach(async () => {
    handle?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function start(overrides: { startFromBeginning?: boolean } = {}): ClaudeTranscriptTailerHandle {
    handle = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      onError,
      pollIntervalMs: POLL_MS,
      ...overrides,
    });
    return handle;
  }

  // ── basic emission ──────────────────────────────────────────────────────

  it("waits for the file to appear before emitting anything", async () => {
    start();
    await sleep(POLL_MS * 4);
    expect(onTurn).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await writeFile(transcriptPath, userLine("hello agent"));
    await sleep(POLL_MS * 4);
    expect(onTurn).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "hello agent" }));
  });

  it("emits a user turn for a plain-text user message", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, userLine("build me a leasing workflow"));
    await sleep(POLL_MS * 4);

    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "build me a leasing workflow" }),
    );
  });

  it("emits an assistant turn for a text-block assistant message", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, assistantLine("I'll get started on that now."));
    await sleep(POLL_MS * 4);

    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: "I'll get started on that now." }),
    );
  });

  it("skips summary lines — they are not conversation turns", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, summaryLine("Condensed session history"));
    await sleep(POLL_MS * 4);

    expect(onTurn).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });

  // ── tool_use / tool_result pairing ──────────────────────────────────────

  it("emits a tool call start when a tool_use block appears in an assistant turn", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, toolUseLine("tu-1", "Read"));
    await sleep(POLL_MS * 4);

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Read", status: "start" }),
    );
    expect(onTurn).not.toHaveBeenCalled(); // no text block, no turn
  });

  it("emits a tool call ok when the matching tool_result arrives in a user turn", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, toolUseLine("tu-2", "Write"));
    await sleep(POLL_MS * 4);

    const startCall = onToolCall.mock.calls[0][0] as ChatToolCall;
    expect(startCall.status).toBe("start");

    await appendFile(transcriptPath, toolResultLine("tu-2", "ok"));
    await sleep(POLL_MS * 4);

    expect(onToolCall).toHaveBeenCalledTimes(2);
    const okCall = onToolCall.mock.calls[1][0] as ChatToolCall;
    expect(okCall.callId).toBe(startCall.callId); // same callId
    expect(okCall.status).toBe("ok");
    expect(okCall.toolName).toBe("Write");
  });

  it("emits text turn separately from tool_use in a mixed assistant message", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, assistantWithTextAndTool("Looking at the file…", "tu-3", "Read"));
    await sleep(POLL_MS * 4);

    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: "Looking at the file…" }),
    );
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Read", status: "start" }),
    );
  });

  it("does not emit a user turn for a tool_result-only user message", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, toolUseLine("tu-4", "Bash"));
    await sleep(POLL_MS * 4);

    onTurn.mockClear();
    await appendFile(transcriptPath, toolResultLine("tu-4", "output here"));
    await sleep(POLL_MS * 4);

    // onToolCall ok fired, but NO user turn for the result message
    expect(onTurn).not.toHaveBeenCalled();
  });

  // ── baseline offset (resume vs startFromBeginning) ───────────────────────

  it("does not backfill content that existed before the tailer started", async () => {
    await writeFile(
      transcriptPath,
      userLine("old turn before start") + assistantLine("old reply"),
    );
    start();
    await sleep(POLL_MS * 6);

    expect(onTurn).not.toHaveBeenCalled();

    await appendFile(transcriptPath, userLine("new turn after start"));
    await sleep(POLL_MS * 4);

    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(expect.objectContaining({ content: "new turn after start" }));
  });

  it("with startFromBeginning, emits content that already existed when the tailer started", async () => {
    await writeFile(transcriptPath, userLine("already there") + assistantLine("already replied"));
    start({ startFromBeginning: true });
    await sleep(POLL_MS * 4);

    expect(onTurn).toHaveBeenCalledTimes(2);
    const contents = onTurn.mock.calls.map(([t]: [ChatTurn]) => t.content);
    expect(contents).toContain("already there");
    expect(contents).toContain("already replied");
  });

  // ── incremental polling ──────────────────────────────────────────────────

  it("processes lines in file order across multiple poll cycles", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, userLine("first message"));
    await sleep(POLL_MS * 4);
    await appendFile(transcriptPath, userLine("second message"));
    await sleep(POLL_MS * 4);

    const contents = onTurn.mock.calls.map(([t]: [ChatTurn]) => t.content);
    expect(contents).toEqual(["first message", "second message"]);
  });

  it("handles a line split across two poll cycles (partial trailing write)", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    const full = userLine("split across polls");
    const mid = Math.floor(full.length / 2);
    await appendFile(transcriptPath, full.slice(0, mid));
    await sleep(POLL_MS * 4);
    expect(onTurn).not.toHaveBeenCalled();

    await appendFile(transcriptPath, full.slice(mid));
    await sleep(POLL_MS * 4);
    expect(onTurn).toHaveBeenCalledWith(expect.objectContaining({ content: "split across polls" }));
  });

  // ── error handling ───────────────────────────────────────────────────────

  it("reports malformed JSON via onError and keeps tailing valid lines", async () => {
    await writeFile(transcriptPath, "");
    start();
    await sleep(POLL_MS * 4);

    await appendFile(transcriptPath, "not valid json\n");
    await appendFile(transcriptPath, userLine("still works after garbage"));
    await sleep(POLL_MS * 4);

    expect(onError).toHaveBeenCalled();
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ content: "still works after garbage" }),
    );
  });

  // ── stop() ──────────────────────────────────────────────────────────────

  it("stop() halts polling without throwing", async () => {
    await writeFile(transcriptPath, "");
    const h = start();
    await sleep(POLL_MS * 4);
    onTurn.mockClear();

    h.stop();
    await appendFile(transcriptPath, userLine("after stop"));
    await sleep(POLL_MS * 4);

    expect(onTurn).not.toHaveBeenCalled();
  });

  // ── readHistory() ────────────────────────────────────────────────────────

  it("readHistory() returns an empty array when the file does not exist", async () => {
    const h = tailClaudeTranscript({
      transcriptPath: join(dir, "nonexistent.jsonl"),
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();
    expect(hist).toEqual([]);
  });

  it("readHistory() returns user and assistant turns from an existing transcript", async () => {
    await writeFile(
      transcriptPath,
      userLine("first user turn") +
        assistantLine("first assistant reply") +
        userLine("second user turn"),
    );
    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    expect(hist).toHaveLength(3);
    expect(hist[0]).toMatchObject({ role: "user", content: "first user turn" });
    expect(hist[1]).toMatchObject({ role: "assistant", content: "first assistant reply" });
    expect(hist[2]).toMatchObject({ role: "user", content: "second user turn" });
  });

  it("readHistory() skips summary lines and tool-result-only user messages", async () => {
    await writeFile(
      transcriptPath,
      summaryLine("Condensed history") +
        userLine("real turn") +
        toolUseLine("tu-5", "Bash") +
        toolResultLine("tu-5", "result"),
    );
    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    // Only the plain user turn — summary and tool_result-only user messages filtered
    const turns = hist.filter((t) => t.role === "user");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ content: "real turn" });
  });

  it("readHistory() preserves ordering of multiple turns", async () => {
    const lines = [
      userLine("turn 1"),
      assistantLine("turn 2"),
      userLine("turn 3"),
      assistantLine("turn 4"),
    ].join("");
    await writeFile(transcriptPath, lines);

    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    expect(hist.map((t) => t.content)).toEqual(["turn 1", "turn 2", "turn 3", "turn 4"]);
  });

  it("readHistory() returns unique turnIds for each turn", async () => {
    await writeFile(
      transcriptPath,
      userLine("msg a") + userLine("msg b") + assistantLine("reply"),
    );
    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    const ids = hist.map((t) => t.turnId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("readHistory() handles a multi-block assistant message (only text blocks returned)", async () => {
    const line = assistantWithTextAndTool("Let me check that for you.", "tu-6", "Read");
    await writeFile(transcriptPath, line);

    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ role: "assistant", content: "Let me check that for you." });
  });

  // ── readHistory() — newest-content window ────────────────────────────────

  it("readHistory() returns the NEWEST turns when the transcript exceeds HISTORY_MAX_BYTES", async () => {
    // Build a transcript that is 3× the 128 KB cap so the oldest turns are
    // evicted from the window. Each line is padded to a fixed size so we know
    // exactly which turns end up in the tail window.
    //
    // Strategy: write (cap / lineSize) "old" turns then twice that many "new"
    // turns so the history window contains only the newer half.
    const HISTORY_MAX_BYTES = 128 * 1024;

    // Each padded user line is approximately 150 bytes; 1000 of them ~= 150 KB.
    const pad = "x".repeat(100);
    const makeLine = (label: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `${label} ${pad}` } }) + "\n";

    // Write enough "old" turns to fill >1× cap, then "new" turns to fill another ~2× cap.
    const LINES_PER_BATCH = Math.ceil(HISTORY_MAX_BYTES / makeLine("old-0000").length) + 10;
    let content = "";
    for (let i = 0; i < LINES_PER_BATCH; i++) {
      content += makeLine(`old-${String(i).padStart(4, "0")}`);
    }
    // Marker: last "old" turn that should NOT appear in history window
    const lastOldTurn = `old-${String(LINES_PER_BATCH - 1).padStart(4, "0")} ${pad}`;

    // Write enough new turns so the combined file is well over 3× cap
    const newTurnLabel = "newest-turn";
    for (let i = 0; i < LINES_PER_BATCH * 2; i++) {
      content += makeLine(`${newTurnLabel}-${String(i).padStart(4, "0")}`);
    }
    const lastNewTurn = `${newTurnLabel}-${String(LINES_PER_BATCH * 2 - 1).padStart(4, "0")} ${pad}`;

    await writeFile(transcriptPath, content);

    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    // The history window should contain the newest turns
    const contents = hist.map((t) => t.content);
    expect(contents.some((c) => c.includes(newTurnLabel))).toBe(true);
    // The very last new turn must be present (it's within the window)
    expect(contents.some((c) => c.includes(lastNewTurn))).toBe(true);
    // The old turns that fell before the window should be absent
    expect(contents.some((c) => c.includes(lastOldTurn))).toBe(false);
  });

  it("readHistory() drops the first partial line when seeking mid-file", async () => {
    // Write a file that is just over HISTORY_MAX_BYTES so the seek lands
    // partway through the second line. The first "line" in the read buffer
    // will be a fragment and must be dropped.
    const HISTORY_MAX_BYTES = 128 * 1024;
    const pad = "y".repeat(100);
    const makeLine = (label: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `${label} ${pad}` } }) + "\n";
    const lineSize = makeLine("probe").length;

    // Fill to just beyond the cap so startAt > 0 but small
    const linesNeeded = Math.ceil(HISTORY_MAX_BYTES / lineSize) + 1;
    let content = "";
    for (let i = 0; i < linesNeeded; i++) {
      content += makeLine(`line-${i}`);
    }
    await writeFile(transcriptPath, content);

    const h = tailClaudeTranscript({
      transcriptPath,
      onTurn,
      onToolCall,
      pollIntervalMs: POLL_MS,
    });
    const hist = await h.readHistory();
    h.stop();

    // All returned turns should be fully-parsed (no JSON errors, clean content)
    for (const turn of hist) {
      expect(turn.content).toMatch(/^line-\d+/);
    }
    // The very first historical turn (line-0) is outside the window
    expect(hist.map((t) => t.content).some((c) => c.startsWith("line-0 "))).toBe(false);
  });

  // ── resume regression — no duplicate turns ────────────────────────────────

  it("resume: readHistory() delivers past turns; fresh new turn arrives exactly once via onTurn", async () => {
    // Seed a transcript with two historical turns already written
    const histTurn1 = userLine("historical turn 1");
    const histTurn2 = assistantLine("historical reply");
    await writeFile(transcriptPath, histTurn1 + histTurn2);

    // Resume semantics: startFromBeginning = false → tailer starts at EOF,
    // so the live stream only emits content appended AFTER start.
    const h = tailClaudeTranscript({
      transcriptPath,
      startFromBeginning: false,
      onTurn,
      onToolCall,
      onError,
      pollIntervalMs: POLL_MS,
    });

    // Read history synchronously first (as the server does)
    const hist = await h.readHistory();

    // History path: both seeded turns should appear exactly once
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ role: "user", content: "historical turn 1" });
    expect(hist[1]).toMatchObject({ role: "assistant", content: "historical reply" });

    // Wait for the tailer to resolve its baseline (EOF)
    await sleep(POLL_MS * 3);
    // The live stream must NOT have fired for the historical content
    expect(onTurn).not.toHaveBeenCalled();

    // Append a truly new turn — must arrive exactly once via onTurn
    await appendFile(transcriptPath, userLine("brand new turn"));
    await sleep(POLL_MS * 4);

    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "brand new turn" }),
    );

    h.stop();
  });

  it("fresh launch (startFromBeginning=true): turns arrive via onTurn, NOT via readHistory duplication", async () => {
    // A fresh session file — tailer tails from offset 0
    const h = tailClaudeTranscript({
      transcriptPath,
      startFromBeginning: true,
      onTurn,
      onToolCall,
      onError,
      pollIntervalMs: POLL_MS,
    });

    // File doesn't exist yet — create it with one turn
    await writeFile(transcriptPath, userLine("first ever turn"));
    await sleep(POLL_MS * 4);

    // Live stream delivers the turn
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({ content: "first ever turn" }),
    );

    // readHistory() on a fresh session also sees the same turn — but the
    // caller (server) only invokes one or the other, not both.
    // Verify readHistory still returns it correctly.
    const hist = await h.readHistory();
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ content: "first ever turn" });

    h.stop();
  });
});

// ---------------------------------------------------------------------------
// encodeProjectPath
// ---------------------------------------------------------------------------

describe("encodeProjectPath", () => {
  it("strips leading slash and replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/demo/acme-app")).toBe("-Users-demo-acme-app");
  });

  it("replaces dots with dashes", () => {
    expect(encodeProjectPath("/home/user/.config/project")).toBe("-home-user--config-project");
  });

  it("handles a path without a leading slash", () => {
    // Unusual, but the function should not crash
    const result = encodeProjectPath("relative/path");
    expect(result).toBe("relative-path");
  });

  it("handles a Windows-style path (backslashes normalized)", () => {
    // Backslashes should be normalized to forward slashes first
    const result = encodeProjectPath("C:\\Users\\demo\\project");
    // colon stripped, then / and . → -
    expect(result).toMatch(/C-Users-demo-project|C-Users-demo-project/);
  });
});

// ---------------------------------------------------------------------------
// transcriptPathForSession
// ---------------------------------------------------------------------------

describe("transcriptPathForSession", () => {
  it("returns the expected path for a given cwd and agentSessionId", () => {
    const path = transcriptPathForSession("/Users/demo/acme-app", "abc-123", "/home/user");
    expect(path).toBe("/home/user/.claude/projects/-Users-demo-acme-app/abc-123.jsonl");
  });

  it("uses the real homedir when homeDir is not provided (smoke check)", () => {
    const path = transcriptPathForSession("/tmp/test", "sess-1");
    expect(path).toContain(".claude");
    expect(path).toContain("sess-1.jsonl");
  });
});

// ---------------------------------------------------------------------------
// agentSessionIdFromTranscriptPath
// ---------------------------------------------------------------------------

describe("agentSessionIdFromTranscriptPath", () => {
  it("extracts the UUID from a transcript path", () => {
    const uuid = "4b3c2a1d-5e6f-4071-8b9a-0c1d2e3f4a50";
    const path = `/home/user/.claude/projects/-Users-demo-project/${uuid}.jsonl`;
    expect(agentSessionIdFromTranscriptPath(path)).toBe(uuid);
  });
});

// ---------------------------------------------------------------------------
// findClaudeTranscript
// ---------------------------------------------------------------------------

describe("findClaudeTranscript", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "harness-claude-find-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function projectDir(cwd: string): string {
    const encoded = encodeProjectPath(cwd);
    return join(homeDir, ".claude", "projects", encoded);
  }

  it("returns null when the projects directory does not exist", async () => {
    const result = await findClaudeTranscript({ cwd: "/tmp/proj", homeDir });
    expect(result).toBeNull();
  });

  it("returns the transcript for a specific agentSessionId", async () => {
    const dir = projectDir("/tmp/proj");
    await mkdir(dir, { recursive: true });
    const uuid = "9a1b2c3d-4e5f-4a61-8b7c-6d5e4f3a2b1a";
    await writeFile(join(dir, `${uuid}.jsonl`), userLine("hi"));

    const found = await findClaudeTranscript({ cwd: "/tmp/proj", homeDir, agentSessionId: uuid });
    expect(found).toBe(join(dir, `${uuid}.jsonl`));
  });

  it("returns a constructed path for agentSessionId even when the file does not yet exist", async () => {
    // findClaudeTranscript with agentSessionId returns the expected path
    // unconditionally — the tailer's startFromBeginning + poll handles the
    // file-not-yet-exists case without needing null here.
    const dir = projectDir("/tmp/proj");
    await mkdir(dir, { recursive: true });

    const found = await findClaudeTranscript({
      cwd: "/tmp/proj",
      homeDir,
      agentSessionId: "my-session-id",
    });
    expect(found).toBe(join(dir, "my-session-id.jsonl"));
  });

  it("returns the most recently modified transcript when no agentSessionId is given", async () => {
    const dir = projectDir("/tmp/proj");
    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, "older.jsonl"), userLine("older"));
    await sleep(20);
    await writeFile(join(dir, "newer.jsonl"), userLine("newer"));

    const found = await findClaudeTranscript({ cwd: "/tmp/proj", homeDir });
    expect(found).toBe(join(dir, "newer.jsonl"));
  });

  it("ignores non-.jsonl files in the project directory", async () => {
    const dir = projectDir("/tmp/proj");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), "{}");

    const found = await findClaudeTranscript({ cwd: "/tmp/proj", homeDir });
    expect(found).toBeNull();
  });
});
