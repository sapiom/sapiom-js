/**
 * Unit-level test for the codex-tailer lifecycle wiring in server/index.ts:
 * mocks core/collector/codex-tailer.js entirely so this exercises just the
 * glue (when discovery/tailing starts and stops, and that a tailer's emitted
 * event actually reaches the session registry) without any real file I/O or
 * polling delay. See codex-session-lifecycle.test.ts for the real-files,
 * no-mocking end-to-end proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../core/collector/codex-tailer.js", () => ({
  tailCodexRollout: vi.fn(),
  findRolloutFile: vi.fn(),
}));

import { tailCodexRollout, findRolloutFile, type CodexEventListener } from "../core/collector/codex-tailer.js";
import { startServer, type HarnessServer } from "./index.js";
import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";

type FakeTailerHandle = { stop: ReturnType<typeof vi.fn>; emitSessionEnd: ReturnType<typeof vi.fn> };

/**
 * `vi.waitFor`'s own default (1000ms timeout / 50ms interval — tuned for
 * in-process, microtask-scale assertions) is too tight for the real,
 * OS-level pty-exit transition the waits below depend on. Root-caused via
 * instrumented real-process runs (process pid, spawn/kill/exit timestamps,
 * and an OS-level `process.kill(pid, 0)` liveness check at the point of
 * failure): node-pty's own `onExit` callback can simply never fire for a
 * pty killed within milliseconds of being spawned, even though the OS
 * process is already confirmed gone by then — a missed-event bug in
 * node-pty itself, not a slow or lost signal. `SessionManager.kill()` now
 * self-heals that (see its own comment) by synthesizing the exit from an
 * OS-level liveness check ~2.5s after the graceful signal if node-pty never
 * reports it — this bounds the wait below at that plus real
 * scheduling/persist overhead, comfortable margin rather than an
 * arbitrary/unexamined number.
 */
const PTY_EXIT_WAIT_OPTIONS = { timeout: 5_000, interval: 200 };

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

describe("codex tailer lifecycle wiring", () => {
  let dir: string;
  let server: HarnessServer | undefined;
  let fakeHandle: FakeTailerHandle;
  let lastTailerOnEvent: CodexEventListener | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-codex-wiring-"));

    fakeHandle = { stop: vi.fn(), emitSessionEnd: vi.fn() };
    vi.mocked(tailCodexRollout).mockReset().mockImplementation((opts) => {
      lastTailerOnEvent = opts.onEvent;
      return fakeHandle;
    });
    vi.mocked(findRolloutFile).mockReset().mockResolvedValue("/fake/rollout/path.jsonl");
  });

  afterEach(async () => {
    // Status-change side effects (setAgentSessionId, spawn/exit) fire
    // persist() without awaiting it — flush before removing the temp dir so
    // a lingering write can't race the cleanup. server.close() itself
    // resolves once the HTTP server stops listening — independent of
    // whether killAll()'s asynchronous pty-exit events have finished their
    // own persist() writes — so flush a second time afterward too.
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("discovers, tails, and links agentSessionId once a codex session is running", async () => {
    const cwd = join(dir, "project");
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { codex: fakeCodexAdapter() },
      stateRoot: dir,
    });

    const session = await server.sessionManager.create({ cwd, harness: "codex" });
    expect(session.status).toBe("running");

    await vi.waitFor(() => {
      expect(findRolloutFile).toHaveBeenCalled();
      expect(tailCodexRollout).toHaveBeenCalledWith(
        expect.objectContaining({ rolloutPath: "/fake/rollout/path.jsonl" }),
      );
    });

    // findRolloutFile should have been asked for this session's cwd, and (a
    // fresh launch has no agentSessionId yet) bounded by sinceMs rather than
    // an exact id.
    expect(findRolloutFile).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, sinceMs: expect.any(Number) }),
    );

    // Simulate the tailer emitting a SessionStart — proves the emitted event
    // actually flows through processIngest -> normalize -> onAgentSessionResolved
    // -> SessionManager, exactly like a real hook POST would.
    lastTailerOnEvent!("SessionStart", { source: "codex", cwd, session_id: "agent-xyz" });

    await vi.waitFor(() => {
      expect(server!.sessionManager.get(session.id)?.agentSessionId).toBe("agent-xyz");
    });

    // kill() only sends the signal — it doesn't wait for the real bash
    // process to actually terminate. Waiting for "exited" here (rather than
    // leaving that to afterEach's close()) avoids a real race: close()
    // resolves once the HTTP server stops listening, independent of whether
    // this session's exit-triggered persist() has landed yet, which can
    // still be mid-write when the test's temp dir gets removed.
    server.sessionManager.kill(session.id);
    await vi.waitFor(() => {
      expect(server!.sessionManager.get(session.id)?.status).toBe("exited");
    }, PTY_EXIT_WAIT_OPTIONS);
    // vitest's default per-test timeout (5000ms) leaves no margin over
    // PTY_EXIT_WAIT_OPTIONS' own 5s allowance above — without bumping this
    // too, the outer test timeout could fire first and mask it entirely.
  }, 15_000);

  it("resumes by exact agentSessionId rather than cwd+sinceMs when one is already known", async () => {
    const cwd = join(dir, "project");
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { codex: fakeCodexAdapter() },
      stateRoot: dir,
    });

    const historical = server.sessionManager.registerHistorical({
      agentSessionId: "agent-resumed",
      harness: "codex",
      cwd,
      title: "past session",
      lastActiveAt: new Date().toISOString(),
    });

    const resumed = await server.sessionManager.resume(historical.id);

    await vi.waitFor(() => {
      expect(findRolloutFile).toHaveBeenCalledWith(
        expect.objectContaining({ cwd, agentSessionId: "agent-resumed" }),
      );
    });

    // See the first test's comment: wait for the real spawned process to
    // actually exit rather than leaving that race to afterEach's close().
    server.sessionManager.kill(resumed.id);
    await vi.waitFor(() => {
      expect(server!.sessionManager.get(resumed.id)?.status).toBe("exited");
    }, PTY_EXIT_WAIT_OPTIONS);
    // See the first test's comment: the outer test timeout needs the same bump.
  }, 15_000);

  it("stops the tailer and does not start a new one for a non-codex session", async () => {
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: {
        "claude-code": {
          id: "claude-code",
          eventSource: "hooks",
          doctor: async () => [],
          launch: (opts: LaunchOpts): SpawnSpec => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
          resume: (_id: string, opts: LaunchOpts): SpawnSpec => ({
            command: "bash",
            args: [],
            env: {},
            cwd: opts.cwd,
          }),
          listPastSessions: async () => [],
        },
      },
      stateRoot: dir,
    });

    const session = await server.sessionManager.create({ cwd: join(dir, "project"), harness: "claude-code" });
    expect(session.status).toBe("running");

    // Give any (incorrect) codex wiring a chance to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(findRolloutFile).not.toHaveBeenCalled();
    expect(tailCodexRollout).not.toHaveBeenCalled();

    // See the first test's comment: wait for the real spawned process to
    // actually exit rather than leaving that race to afterEach's close().
    server.sessionManager.kill(session.id);
    await vi.waitFor(() => {
      expect(server!.sessionManager.get(session.id)?.status).toBe("exited");
    }, PTY_EXIT_WAIT_OPTIONS);
    // See the first test's comment: the outer test timeout needs the same bump.
  }, 15_000);

  it("emits SessionEnd and removes the tailer when the session exits", async () => {
    const cwd = join(dir, "project");
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { codex: fakeCodexAdapter() },
      stateRoot: dir,
    });

    const session = await server.sessionManager.create({ cwd, harness: "codex" });
    await vi.waitFor(() => expect(tailCodexRollout).toHaveBeenCalled());

    server.sessionManager.kill(session.id);

    // emitSessionEnd() only fires from the onStatusChange("exited") handler
    // — it's downstream of the same real pty-exit transition as the other
    // waits in this file, so it needs the same allowance.
    await vi.waitFor(() => {
      expect(fakeHandle.emitSessionEnd).toHaveBeenCalled();
    }, PTY_EXIT_WAIT_OPTIONS);
    // See the first test's comment: the outer test timeout needs the same bump.
  }, 15_000);
});
