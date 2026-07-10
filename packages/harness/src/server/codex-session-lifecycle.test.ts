/**
 * Real end-to-end proof (no mocking of core/collector/codex-tailer.js):
 * boots the real server, spawns a real pty (bash standing in for `codex`),
 * writes a fixture rollout file the same way the real Codex CLI would, and
 * appends to it exactly like a live session. Proves a codex-kind session's
 * analytics land in the event store the same way a claude-code session's do
 * — via the same normalize/store/batcher pipeline, just fed by the tailer
 * instead of a hook POST. See codex-tailer-wiring.test.ts for the isolated,
 * mocked unit-level test of the lifecycle glue itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type HarnessServer } from "./index.js";
import type { AnalyticsEvent, HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";

function fakeCodexAdapter(): HarnessAdapter {
  return {
    id: "codex",
    eventSource: "transcript-tail",
    doctor: async () => [],
    launch: (opts: LaunchOpts): SpawnSpec => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
    resume: (_agentSessionId: string, opts: LaunchOpts): SpawnSpec => ({
      command: "bash",
      args: [],
      env: {},
      cwd: opts.cwd,
    }),
    listPastSessions: async () => [],
  };
}

function sessionMetaLine(id: string, cwd: string, timestamp: string): string {
  return JSON.stringify({ timestamp, type: "session_meta", payload: { id, timestamp, cwd } }) + "\n";
}
function userMessageLine(message: string): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } }) + "\n";
}
function functionCallLine(callId: string, name: string, args: string): string {
  return (
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: callId, name, arguments: args } }) +
    "\n"
  );
}
function functionCallOutputLine(callId: string, output: string): string {
  return (
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output } }) + "\n"
  );
}
function taskCompleteLine(): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n";
}

async function readEvents(eventStorePath: string): Promise<AnalyticsEvent[]> {
  try {
    const content = await readFile(eventStorePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AnalyticsEvent);
  } catch {
    return [];
  }
}

describe("codex session lifecycle (real files, no mocking)", () => {
  let dir: string;
  let codexHomeDir: string;
  let cwd: string;
  let eventStorePath: string;
  let server: HarnessServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-codex-e2e-"));
    codexHomeDir = join(dir, "codex-home");
    cwd = join(dir, "project");
    eventStorePath = join(dir, "events.ndjson");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    // server.close() resolves once the HTTP server stops listening —
    // independent of whether killAll()'s asynchronous pty-exit events have
    // finished their own persist() writes — so flush before AND after.
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("produces session.start, prompt.submitted, tool.call, and turn.completed for a codex-kind session", async () => {
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { codex: fakeCodexAdapter() },
      stateRoot: dir,
      codexHomeDir,
    });

    const session = await server.sessionManager.create({ cwd, harness: "codex" });
    expect(session.status).toBe("running");

    // Simulate Codex creating its rollout file shortly after being spawned —
    // real discovery has to poll for this, since there's no way to know the
    // exact timestamp+UUID path in advance.
    const agentSessionId = "019e00000000-integration-test";
    const rolloutDir = join(codexHomeDir, ".codex", "sessions", "2026", "01", "01");
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, `rollout-2026-01-01T00-00-00-${agentSessionId}.jsonl`);
    // Real Codex records the OS-canonicalized cwd (symlinks resolved) — on
    // this machine's tmpdir that differs from the raw path (e.g. macOS's
    // /var -> /private/var), so mirror that here rather than the raw value,
    // to actually exercise findRolloutFile's realpath-normalized matching.
    await writeFile(rolloutPath, sessionMetaLine(agentSessionId, await realpath(cwd), new Date().toISOString()));

    // --- session.start, and the rollout id links into the registry ---
    await vi.waitFor(
      async () => {
        expect(server!.sessionManager.get(session.id)?.agentSessionId).toBe(agentSessionId);
        const events = await readEvents(eventStorePath);
        expect(events.some((e) => e.type === "session.start" && e.harnessSessionId === session.id)).toBe(true);
      },
      { timeout: 10_000, interval: 200 },
    );

    // --- live activity: a prompt, a tool call, and the turn completing ---
    await appendFile(rolloutPath, userMessageLine("build me a leasing workflow"));
    await appendFile(rolloutPath, functionCallLine("call_1", "exec_command", '{"cmd":"ls"}'));
    await appendFile(rolloutPath, functionCallOutputLine("call_1", "file1.txt\nfile2.txt"));
    await appendFile(rolloutPath, taskCompleteLine());

    await vi.waitFor(
      async () => {
        const events = await readEvents(eventStorePath);
        const forSession = events.filter((e) => e.harnessSessionId === session.id);
        expect(forSession.some((e) => e.type === "prompt.submitted")).toBe(true);
        expect(forSession.some((e) => e.type === "tool.call")).toBe(true);
        expect(forSession.some((e) => e.type === "turn.completed")).toBe(true);
      },
      { timeout: 10_000, interval: 200 },
    );

    const events = await readEvents(eventStorePath);
    const prompt = events.find((e) => e.harnessSessionId === session.id && e.type === "prompt.submitted");
    expect(prompt?.payload).toMatchObject({ prompt: "build me a leasing workflow" });
    expect(prompt?.harness).toBe("codex");

    const toolCall = events.find((e) => e.harnessSessionId === session.id && e.type === "tool.call");
    expect(toolCall?.payload).toMatchObject({
      toolName: "exec_command",
      toolInput: '{"cmd":"ls"}',
    });

    // --- session end: killing the pty should synthesize a SessionEnd ---
    void server.sessionManager.kill(session.id);
    await vi.waitFor(
      async () => {
        const finalEvents = await readEvents(eventStorePath);
        expect(finalEvents.some((e) => e.harnessSessionId === session.id && e.type === "session.end")).toBe(true);
      },
      { timeout: 5_000, interval: 200 },
    );
  }, 20_000);
});
