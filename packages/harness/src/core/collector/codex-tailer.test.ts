import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findRolloutFile, tailCodexRollout, type CodexTailerHandle } from "./codex-tailer.js";
import type { RawHookPayload } from "./normalizer.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 20;

function sessionMetaLine(id: string, cwd: string, timestamp: string): string {
  return JSON.stringify({ timestamp, type: "session_meta", payload: { id, timestamp, cwd } }) + "\n";
}
function userMessageLine(message: string): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } }) + "\n";
}
function functionCallLine(callId: string, name: string, args: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: callId, name, arguments: args } }) + "\n";
}
function functionCallOutputLine(callId: string, output: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output } }) + "\n";
}
function taskCompleteLine(): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n";
}
function taskStartedLine(): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n";
}

describe("tailCodexRollout", () => {
  let dir: string;
  let rolloutPath: string;
  let handle: CodexTailerHandle | undefined;
  let onEvent: ReturnType<typeof vi.fn<(hookEvent: string, payload: RawHookPayload) => void>>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-codex-tailer-"));
    rolloutPath = join(dir, "rollout-test.jsonl");
    onEvent = vi.fn();
    onError = vi.fn();
  });

  afterEach(async () => {
    handle?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function start(overrides: { startFromBeginning?: boolean } = {}): CodexTailerHandle {
    handle = tailCodexRollout({ rolloutPath, onEvent, onError, pollIntervalMs: POLL_MS, ...overrides });
    return handle;
  }

  it("waits for the file to appear before emitting anything", async () => {
    start();
    await sleep(POLL_MS * 4);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    await sleep(POLL_MS * 4);
    expect(onEvent).toHaveBeenCalledWith("SessionStart", {
      source: "codex",
      cwd: "/tmp/proj",
      session_id: "agent-1",
    });
  });

  it("emits SessionStart only once even if session_meta somehow reappears", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    start();
    await sleep(POLL_MS * 4);
    await appendFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    await sleep(POLL_MS * 4);

    const sessionStartCalls = onEvent.mock.calls.filter(([event]) => event === "SessionStart");
    expect(sessionStartCalls).toHaveLength(1);
  });

  it("translates a user_message into UserPromptSubmit", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    start();
    await sleep(POLL_MS * 4);

    await appendFile(rolloutPath, userMessageLine("build me a leasing workflow"));
    await sleep(POLL_MS * 4);

    expect(onEvent).toHaveBeenCalledWith("UserPromptSubmit", { prompt: "build me a leasing workflow" });
  });

  it("pairs function_call + function_call_output into a single PostToolUse", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    start();
    await sleep(POLL_MS * 4);

    await appendFile(rolloutPath, functionCallLine("call_1", "exec_command", '{"cmd":"ls"}'));
    await sleep(POLL_MS * 4);
    // No PostToolUse yet — still waiting on the matching output.
    expect(onEvent).not.toHaveBeenCalledWith("PostToolUse", expect.anything());

    await appendFile(rolloutPath, functionCallOutputLine("call_1", "file1.txt\nfile2.txt"));
    await sleep(POLL_MS * 4);

    expect(onEvent).toHaveBeenCalledWith("PostToolUse", {
      tool_name: "exec_command",
      tool_input: '{"cmd":"ls"}',
      tool_response: "file1.txt\nfile2.txt",
    });
  });

  it("translates task_complete into Stop and ignores task_started", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    start();
    await sleep(POLL_MS * 4);

    await appendFile(rolloutPath, taskStartedLine());
    await appendFile(rolloutPath, taskCompleteLine());
    await sleep(POLL_MS * 4);

    expect(onEvent).toHaveBeenCalledWith("Stop", { stop_hook_active: false });
    expect(onEvent.mock.calls.filter(([event]) => event !== "SessionStart")).toEqual([
      ["Stop", { stop_hook_active: false }],
    ]);
  });

  it("processes lines in file order across multiple poll cycles", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    const h = start();
    await sleep(POLL_MS * 4);

    await appendFile(rolloutPath, userMessageLine("first"));
    await sleep(POLL_MS * 4);
    await appendFile(rolloutPath, userMessageLine("second"));
    await sleep(POLL_MS * 4);

    const prompts = onEvent.mock.calls
      .filter(([event]) => event === "UserPromptSubmit")
      .map(([, payload]) => (payload as { prompt: string }).prompt);
    expect(prompts).toEqual(["first", "second"]);
    h.stop();
  });

  it("does not backfill content that existed before the tailer started (resume semantics)", async () => {
    await writeFile(
      rolloutPath,
      sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z") + userMessageLine("old history"),
    );
    start();
    await sleep(POLL_MS * 6);

    expect(onEvent).not.toHaveBeenCalled();

    await appendFile(rolloutPath, userMessageLine("new activity after resume"));
    await sleep(POLL_MS * 4);

    expect(onEvent).toHaveBeenCalledWith("UserPromptSubmit", { prompt: "new activity after resume" });
    expect(onEvent).not.toHaveBeenCalledWith("UserPromptSubmit", { prompt: "old history" });
  });

  it("with startFromBeginning, emits content that already existed when the tailer started", async () => {
    // Simulates the find-then-tail race: a fresh launch's rollout file is
    // only ever discovered once it already has content (session_meta at
    // minimum) — startFromBeginning is what lets that be treated as new
    // rather than swallowed as if it were resume history.
    await writeFile(
      rolloutPath,
      sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z") + userMessageLine("already there"),
    );
    start({ startFromBeginning: true });
    await sleep(POLL_MS * 4);

    expect(onEvent).toHaveBeenCalledWith("SessionStart", {
      source: "codex",
      cwd: "/tmp/proj",
      session_id: "agent-1",
    });
    expect(onEvent).toHaveBeenCalledWith("UserPromptSubmit", { prompt: "already there" });
  });

  it("reports malformed JSON lines via onError instead of throwing, and keeps tailing", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    start();
    await sleep(POLL_MS * 4);

    await appendFile(rolloutPath, "not valid json at all\n");
    await appendFile(rolloutPath, userMessageLine("still works after garbage"));
    await sleep(POLL_MS * 4);

    expect(onError).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith("UserPromptSubmit", { prompt: "still works after garbage" });
  });

  it("handles a line split across two poll cycles (partial trailing write)", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    start();
    await sleep(POLL_MS * 4);

    const fullLine = userMessageLine("split across polls");
    const splitPoint = Math.floor(fullLine.length / 2);
    await appendFile(rolloutPath, fullLine.slice(0, splitPoint));
    await sleep(POLL_MS * 4);
    expect(onEvent).not.toHaveBeenCalledWith("UserPromptSubmit", expect.anything());

    await appendFile(rolloutPath, fullLine.slice(splitPoint));
    await sleep(POLL_MS * 4);
    expect(onEvent).toHaveBeenCalledWith("UserPromptSubmit", { prompt: "split across polls" });
  });

  it("emitSessionEnd() emits a SessionEnd event and stops further polling", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    const h = start();
    await sleep(POLL_MS * 4);

    h.emitSessionEnd("pty exited");
    expect(onEvent).toHaveBeenCalledWith("SessionEnd", { reason: "pty exited" });

    onEvent.mockClear();
    await appendFile(rolloutPath, userMessageLine("after end, should be ignored"));
    await sleep(POLL_MS * 4);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("stop() halts polling without emitting a SessionEnd", async () => {
    await writeFile(rolloutPath, sessionMetaLine("agent-1", "/tmp/proj", "2026-01-01T00:00:00.000Z"));
    const h = start();
    await sleep(POLL_MS * 4);
    onEvent.mockClear();

    h.stop();
    await appendFile(rolloutPath, userMessageLine("after stop, should be ignored"));
    await sleep(POLL_MS * 4);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("findRolloutFile", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "harness-codex-find-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function rolloutDir(): string {
    return join(homeDir, ".codex", "sessions", "2026", "01", "01");
  }

  it("returns null when no sessions directory exists", async () => {
    expect(await findRolloutFile({ cwd: "/tmp/proj", homeDir })).toBeNull();
  });

  it("finds the file whose session_meta.cwd matches", async () => {
    const dir = rolloutDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-a.jsonl"),
      sessionMetaLine("agent-a", "/tmp/proj", "2026-01-01T00:00:00.000Z"),
    );
    await writeFile(
      join(dir, "rollout-b.jsonl"),
      sessionMetaLine("agent-b", "/tmp/other", "2026-01-01T00:01:00.000Z"),
    );

    const found = await findRolloutFile({ cwd: "/tmp/proj", homeDir });
    expect(found).toBe(join(dir, "rollout-a.jsonl"));
  });

  it("excludes sessions started before sinceMs", async () => {
    const dir = rolloutDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-old.jsonl"),
      sessionMetaLine("agent-old", "/tmp/proj", "2026-01-01T00:00:00.000Z"),
    );

    const found = await findRolloutFile({
      cwd: "/tmp/proj",
      homeDir,
      sinceMs: Date.parse("2026-01-01T00:10:00.000Z"),
    });
    expect(found).toBeNull();
  });

  it("picks the most recently modified match when multiple sessions share a cwd", async () => {
    const dir = rolloutDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-earlier.jsonl"),
      sessionMetaLine("agent-earlier", "/tmp/proj", "2026-01-01T00:00:00.000Z"),
    );
    await sleep(20);
    await writeFile(
      join(dir, "rollout-later.jsonl"),
      sessionMetaLine("agent-later", "/tmp/proj", "2026-01-01T00:05:00.000Z"),
    );

    const found = await findRolloutFile({ cwd: "/tmp/proj", homeDir });
    expect(found).toBe(join(dir, "rollout-later.jsonl"));
  });

  it("with agentSessionId, matches that exact session even when a newer one shares the same cwd", async () => {
    const dir = rolloutDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-target.jsonl"),
      sessionMetaLine("agent-target", "/tmp/proj", "2026-01-01T00:00:00.000Z"),
    );
    await sleep(20);
    // Written (and thus more recently modified) after the target — recency
    // alone would pick this one, which is exactly the ambiguity agentSessionId
    // exists to resolve (the resume case).
    await writeFile(
      join(dir, "rollout-newer.jsonl"),
      sessionMetaLine("agent-newer", "/tmp/proj", "2026-01-01T00:05:00.000Z"),
    );

    const found = await findRolloutFile({ cwd: "/tmp/proj", homeDir, agentSessionId: "agent-target" });
    expect(found).toBe(join(dir, "rollout-target.jsonl"));
  });

  it("with agentSessionId, returns null when no rollout file matches that id", async () => {
    const dir = rolloutDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-a.jsonl"),
      sessionMetaLine("agent-a", "/tmp/proj", "2026-01-01T00:00:00.000Z"),
    );

    const found = await findRolloutFile({ cwd: "/tmp/proj", homeDir, agentSessionId: "agent-does-not-exist" });
    expect(found).toBeNull();
  });

  it("matches when the caller's cwd is a symlink to the directory Codex recorded (e.g. macOS /tmp -> /private/tmp)", async () => {
    // Reproduces a real bug: Codex's own session_meta.cwd is the OS-resolved
    // (symlink-free) path, but callers here generally hand us whatever a
    // freshly-created session's cwd literally is — on macOS that's routinely
    // a `/tmp/...` or `/var/folders/...` path, both of which are symlinks
    // into `/private`. An exact string comparison never matches, even though
    // it's the same directory, so the tailer never finds a real rollout file.
    const realProjectDir = await mkdtemp(join(tmpdir(), "harness-codex-real-"));
    const linkParent = await mkdtemp(join(tmpdir(), "harness-codex-link-"));
    const symlinkedCwd = join(linkParent, "proj-link");
    await symlink(realProjectDir, symlinkedCwd);
    const resolvedCwd = await realpath(realProjectDir);

    const dir = rolloutDir();
    await mkdir(dir, { recursive: true });
    // What Codex actually writes: the canonicalized path, not the symlink.
    await writeFile(
      join(dir, "rollout-a.jsonl"),
      sessionMetaLine("agent-a", resolvedCwd, "2026-01-01T00:00:00.000Z"),
    );

    try {
      const found = await findRolloutFile({ cwd: symlinkedCwd, homeDir });
      expect(found).toBe(join(dir, "rollout-a.jsonl"));
    } finally {
      await rm(realProjectDir, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});
