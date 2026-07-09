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
