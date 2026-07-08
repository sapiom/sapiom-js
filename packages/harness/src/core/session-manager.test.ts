import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessAdapter, HarnessSession, SpawnSpec } from "../shared/types.js";
import { SessionManager, type PtySpawnFn, type SessionManagerOptions } from "./session-manager.js";

/** Minimal fake IPty: lets tests drive onData/onExit and observe write/resize/kill. */
function createFakePty() {
  const dataListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  const pty = {
    onData: (cb: (chunk: string) => void) => {
      dataListeners.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(cb);
      return { dispose: () => {} };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return {
    pty,
    emitData: (chunk: string) => dataListeners.forEach((cb) => cb(chunk)),
    emitExit: (exitCode = 0) => exitListeners.forEach((cb) => cb({ exitCode })),
  };
}

function createFakeAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: vi.fn(async () => []),
    launch: vi.fn(
      (opts): SpawnSpec => ({
        command: "fake-claude",
        args: ["--launch"],
        env: {},
        cwd: opts.cwd,
      }),
    ),
    resume: vi.fn(
      (agentSessionId, opts): SpawnSpec => ({
        command: "fake-claude",
        args: ["--resume", agentSessionId],
        env: {},
        cwd: opts.cwd,
      }),
    ),
    listPastSessions: vi.fn(async () => []),
    ...overrides,
  };
}

describe("SessionManager", () => {
  let dir: string;
  let sessionsPath: string;

  let managers: SessionManager[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-sm-test-"));
    sessionsPath = join(dir, "sessions.json");
    managers = [];
  });

  afterEach(async () => {
    // Pty exit/write handlers fire persist() without awaiting it; flush
    // before cleanup so a lingering write doesn't race the temp-dir removal.
    await Promise.all(managers.map((m) => m.flush()));
    await rm(dir, { recursive: true, force: true });
  });

  function makeManager(
    opts: {
      adapter?: HarnessAdapter;
      spawnPty?: PtySpawnFn;
      buildLaunchOpts?: SessionManagerOptions["buildLaunchOpts"];
      writeWorkspaceContext?: SessionManagerOptions["writeWorkspaceContext"];
      workspaceContextExists?: SessionManagerOptions["workspaceContextExists"];
      ensureCanvasTemplate?: SessionManagerOptions["ensureCanvasTemplate"];
    } = {},
  ) {
    const adapter = opts.adapter ?? createFakeAdapter();
    const spawns: ReturnType<typeof createFakePty>[] = [];
    const spawnPty: PtySpawnFn =
      opts.spawnPty ??
      ((file, args) => {
        const fake = createFakePty();
        spawns.push(fake);
        void file;
        void args;
        return fake.pty as unknown as ReturnType<PtySpawnFn>;
      });
    const manager = new SessionManager({
      adapters: { "claude-code": adapter },
      ingestUrl: "http://127.0.0.1:4100",
      ingestToken: "boot-token",
      sessionsPath,
      spawnPty,
      buildLaunchOpts: opts.buildLaunchOpts,
      writeWorkspaceContext: opts.writeWorkspaceContext,
      workspaceContextExists: opts.workspaceContextExists,
      ensureCanvasTemplate: opts.ensureCanvasTemplate,
    });
    managers.push(manager);
    return { manager, adapter, spawns };
  }

  it("creates a session, spawns via the adapter's SpawnSpec, and marks it running", async () => {
    const { manager, adapter } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(adapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/proj", harnessSessionId: session.id }),
    );
    expect(session.status).toBe("running");
    expect(session.cwd).toBe("/tmp/proj");
    expect(session.title).toBe("proj");
    expect(manager.get(session.id)).toEqual(session);
    expect(manager.list()).toHaveLength(1);
  });

  it("persists sessions to disk and reconciles non-exited sessions to exited on reload", async () => {
    const { manager } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
    expect(session.status).toBe("running");

    const raw = JSON.parse(await readFile(sessionsPath, "utf8")) as HarnessSession[];
    expect(raw).toHaveLength(1);
    expect(raw[0]?.id).toBe(session.id);
    expect(raw[0]?.status).toBe("running");

    // A fresh process (new SessionManager instance) has no live ptys — any
    // session that was "running"/"starting" on disk must reconcile to "exited".
    const { manager: reloaded } = makeManager();
    await reloaded.init();
    expect(reloaded.get(session.id)?.status).toBe("exited");
  });

  it("routes write() and resize() to the underlying pty", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(manager.write(session.id, "echo hi\r")).toBe(true);
    expect(spawns[0]?.pty.write).toHaveBeenCalledWith("echo hi\r");

    expect(manager.resize(session.id, 120, 40)).toBe(true);
    expect(spawns[0]?.pty.resize).toHaveBeenCalledWith(120, 40);

    expect(manager.write("unknown-id", "x")).toBe(false);
    expect(manager.resize("unknown-id", 1, 1)).toBe(false);
  });

  describe("submitInput", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("splits non-empty submitted text into a text write, then a separate \\r after a delay", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const submitPromise = manager.submitInput(session.id, "hello world", true);

      // Text lands immediately; the trailing Enter must NOT be part of the
      // same write (that's exactly the bracketed-paste bug this fixes).
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("hello world");
      expect(spawns[0]?.pty.write).not.toHaveBeenCalledWith("\r");

      await vi.advanceTimersByTimeAsync(300);
      const ok = await submitPromise;

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(2);
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "hello world");
      expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
    });

    it("writes a bare \\r in a single call for submit:true with empty text (no splitting needed)", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const ok = await manager.submitInput(session.id, "", true);

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("\r");
    });

    it("writes only the text, with no \\r at all, when submit is false", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const ok = await manager.submitInput(session.id, "draft text", false);

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("draft text");
    });

    it("returns false for an unknown session without ever touching a pty", async () => {
      const { manager } = makeManager();
      expect(await manager.submitInput("unknown-id", "hello", true)).toBe(false);
    });

    it("does not write the trailing \\r if the session's pty is gone by the time the delay elapses", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setReady(session.id);

      const submitPromise = manager.submitInput(session.id, "hello", true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);

      spawns[0]?.emitExit(0);
      await vi.advanceTimersByTimeAsync(300);
      const ok = await submitPromise;

      expect(ok).toBe(false);
      // Still just the one write from before the pty exited — no trailing \r.
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
    });
  });

  describe("readiness gating (SessionNotReadyError / setReady / detectBlockingPrompt)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a fresh session starts not-ready even though its pty is already \"running\"", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      expect(session.status).toBe("running");
      expect(session.ready).toBe(false);
    });

    it("write() (raw keystrokes) is never gated on readiness — a human must be able to answer a blocking prompt themselves", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      expect(session.ready).toBe(false);

      expect(manager.write(session.id, "1\r")).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("1\r");
    });

    it(
      "THE RACE REPRO: submitInput() against a not-yet-ready session queues and succeeds once " +
        "setReady() fires before the grace period elapses (macro fired a beat before onboarding finished)",
      async () => {
        const { manager, spawns } = makeManager();
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        const submitPromise = manager.submitInput(session.id, "hello", true);
        // Not ready yet — must NOT have written anything, this is exactly the
        // bug: input landing on a TUI that isn't listening yet.
        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

        // The real SessionStart hook lands a moment later.
        await vi.advanceTimersByTimeAsync(500);
        manager.setReady(session.id);

        // Generous, not tightly matched to SUBMIT_DELAY_MS: the readiness
        // poll loop's own in-flight tick can eat into part of a
        // precisely-sized advance before SUBMIT_DELAY_MS's sleep even
        // starts, since setReady() above only flips a flag — the loop still
        // has to wake up and notice it on its own schedule.
        await vi.advanceTimersByTimeAsync(1_000);
        const ok = await submitPromise;

        expect(ok).toBe(true);
        expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(1, "hello");
        expect(spawns[0]?.pty.write).toHaveBeenNthCalledWith(2, "\r");
      },
    );

    it("throws SessionNotReadyError (never silently proceeds) when a session never becomes ready within the grace period", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const submitPromise = manager.submitInput(session.id, "hello", true);
      const assertion = expect(submitPromise).rejects.toThrow(/not ready yet/i);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      // The whole point: nothing was ever written into the not-listening TUI.
      expect(spawns[0]?.pty.write).not.toHaveBeenCalled();
    });

    it("resuming resets ready back to false, even for a session that was ready before its pty exited", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setAgentSessionId(session.id, "agent-1");
      manager.setReady(session.id);
      expect(manager.get(session.id)?.ready).toBe(true);

      spawns[0]?.emitExit(0);
      expect(manager.get(session.id)?.status).toBe("exited");

      await manager.resume(session.id);
      expect(manager.get(session.id)?.status).toBe("running");
      // Trust dialogs can reappear on resume (e.g. different sandbox flags)
      // — a fresh pty hasn't proven itself interactive yet either way.
      expect(manager.get(session.id)?.ready).toBe(false);
    });

    it("setReady is idempotent and a silent no-op for an unknown session id", () => {
      const { manager } = makeManager();
      expect(() => manager.setReady("unknown-id")).not.toThrow();
    });

    describe("harnesses with detectBlockingPrompt (Codex's lazy-rollout-file bridge)", () => {
      it("is not ready before the settle window elapses, even with a clean scrollback", async () => {
        const detectBlockingPrompt = vi.fn(() => false);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        const submitPromise = manager.submitInput(session.id, "hello", true);
        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

        // Generous, not tightly matched to READY_SETTLE_MS + SUBMIT_DELAY_MS:
        // the settle window is checked once per READY_POLL_MS poll tick, not
        // the instant it elapses, so the actual crossing (and the fresh
        // SUBMIT_DELAY_MS sleep that only starts once it does) can land
        // meaningfully later than the nominal 700ms.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(await submitPromise).toBe(true);
      });

      it("becomes ready enough after the settle window when the scrollback shows no blocking prompt (the common already-trusted case)", async () => {
        const detectBlockingPrompt = vi.fn(() => false);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        await vi.advanceTimersByTimeAsync(700);
        const submitPromise = manager.submitInput(session.id, "hello", true);
        await vi.advanceTimersByTimeAsync(1_000);
        const ok = await submitPromise;

        expect(ok).toBe(true);
        expect(spawns[0]?.pty.write).toHaveBeenCalledWith("hello");
        // Only the tail of retained scrollback is scanned, not the full history.
        expect(detectBlockingPrompt).toHaveBeenCalledWith(expect.any(String));
      });

      it("stays not-ready while the scrollback shows a blocking prompt, then proceeds once it clears", async () => {
        let showingPrompt = true;
        const detectBlockingPrompt = vi.fn(() => showingPrompt);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        const submitPromise = manager.submitInput(session.id, "hello", true);
        await vi.advanceTimersByTimeAsync(700);
        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();

        // Simulated: a human answers the prompt directly in the terminal.
        showingPrompt = false;
        await vi.advanceTimersByTimeAsync(150); // one READY_POLL_MS tick
        await vi.advanceTimersByTimeAsync(300);
        expect(await submitPromise).toBe(true);
      });

      it("throws SessionNotReadyError if the blocking prompt never clears within the grace period", async () => {
        const detectBlockingPrompt = vi.fn(() => true);
        const { manager, spawns } = makeManager({ adapter: createFakeAdapter({ detectBlockingPrompt }) });
        const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

        const submitPromise = manager.submitInput(session.id, "hello", true);
        const assertion = expect(submitPromise).rejects.toThrow(/not ready yet/i);
        await vi.advanceTimersByTimeAsync(8_000);
        await assertion;

        expect(spawns[0]?.pty.write).not.toHaveBeenCalled();
      });
    });
  });

  it("replays the scrollback buffer to new attach()ers and streams live data", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    spawns[0]?.emitData("hello ");
    spawns[0]?.emitData("world");

    const received: string[] = [];
    const detach = manager.attach(session.id, (chunk) => received.push(chunk));
    expect(received).toEqual(["hello world"]);

    spawns[0]?.emitData("!");
    expect(received).toEqual(["hello world", "!"]);

    detach?.();
    spawns[0]?.emitData("ignored");
    expect(received).toEqual(["hello world", "!"]);
  });

  describe("onActivity", () => {
    it("broadcasts once immediately, then throttles further data within the window", async () => {
      vi.useFakeTimers();
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const activity: string[] = [];
      manager.onActivity((id) => activity.push(id));

      spawns[0]?.emitData("hello");
      expect(activity).toEqual([session.id]);

      // Still within the 2s throttle window — no second broadcast yet.
      spawns[0]?.emitData("more");
      await vi.advanceTimersByTimeAsync(1_000);
      spawns[0]?.emitData("even more");
      expect(activity).toEqual([session.id]);

      // Past the window — the next chunk broadcasts again.
      await vi.advanceTimersByTimeAsync(1_100);
      spawns[0]?.emitData("after the window");
      expect(activity).toEqual([session.id, session.id]);

      vi.useRealTimers();
    });

    it("broadcasts independently per session", async () => {
      const { manager, spawns } = makeManager();
      const a = await manager.create({ cwd: "/tmp/a", harness: "claude-code" });
      const b = await manager.create({ cwd: "/tmp/b", harness: "claude-code" });

      const activity: string[] = [];
      manager.onActivity((id) => activity.push(id));

      spawns[0]?.emitData("from a");
      spawns[1]?.emitData("from b");

      expect(activity).toEqual([a.id, b.id]);
    });

    it("stops notifying an unsubscribed listener", async () => {
      const { manager, spawns } = makeManager();
      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const activity: string[] = [];
      const unsubscribe = manager.onActivity((id) => activity.push(id));
      unsubscribe();

      spawns[0]?.emitData("hello");
      expect(activity).toEqual([]);
    });
  });

  it("marks a session exited when its pty exits, and notifies status listeners", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    const statuses: HarnessSession["status"][] = [];
    manager.onStatusChange((s) => {
      if (s.id === session.id) statuses.push(s.status);
    });

    spawns[0]?.emitExit(1);

    expect(manager.get(session.id)?.status).toBe("exited");
    expect(manager.get(session.id)?.exitCode).toBe(1);
    expect(statuses).toEqual(["exited"]);
  });

  it("kill() signals the pty for a running session and is a no-op otherwise", async () => {
    const { manager, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(manager.kill(session.id)).toBe(true);
    expect(spawns[0]?.pty.kill).toHaveBeenCalled();
    expect(manager.kill("unknown-id")).toBe(false);
  });

  it("killAll() signals every currently-live pty", async () => {
    const { manager, spawns } = makeManager();
    const a = await manager.create({ cwd: "/tmp/a", harness: "claude-code" });
    const b = await manager.create({ cwd: "/tmp/b", harness: "claude-code" });
    spawns[0]?.emitExit(0); // a exits on its own before killAll() runs

    manager.killAll();

    expect(spawns[0]?.pty.kill).not.toHaveBeenCalled(); // already gone — nothing to signal
    expect(spawns[1]?.pty.kill).toHaveBeenCalled();
    expect(manager.get(a.id)?.status).toBe("exited");
    void b;
  });

  it("killAll() is a harmless no-op with no live sessions", () => {
    const { manager } = makeManager();
    expect(() => manager.killAll()).not.toThrow();
  });

  it("resume() requires a known agentSessionId and respawns via adapter.resume", async () => {
    const { manager, adapter, spawns } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    await expect(manager.resume(session.id)).rejects.toThrow(/no agentSessionId/);

    manager.setAgentSessionId(session.id, "agent-uuid-1");
    spawns[0]?.emitExit(0);
    expect(manager.get(session.id)?.status).toBe("exited");

    const resumed = await manager.resume(session.id);
    expect(adapter.resume).toHaveBeenCalledWith(
      "agent-uuid-1",
      expect.objectContaining({ harnessSessionId: session.id, cwd: "/tmp/proj" }),
    );
    expect(resumed.status).toBe("running");
    expect(resumed.id).toBe(session.id);

    await expect(manager.resume("does-not-exist")).rejects.toThrow(/Unknown session/);
  });

  it("awaits an async buildLaunchOpts and merges its result into launch opts", async () => {
    const buildLaunchOpts = vi.fn(async (harnessSessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { settingsFile: `/generated/${harnessSessionId}/settings.json` };
    });
    const { manager, adapter } = makeManager({ buildLaunchOpts });
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(buildLaunchOpts).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ cwd: "/tmp/proj", harness: "claude-code" }),
    );
    expect(adapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({ settingsFile: `/generated/${session.id}/settings.json` }),
    );
  });

  it("also awaits an async buildLaunchOpts on resume()", async () => {
    const buildLaunchOpts = vi.fn(async (harnessSessionId: string) => ({
      mcpConfigFile: `/generated/${harnessSessionId}/mcp-config.json`,
    }));
    const { manager, adapter, spawns } = makeManager({ buildLaunchOpts });
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
    manager.setAgentSessionId(session.id, "agent-uuid-1");
    spawns[0]?.emitExit(0);

    await manager.resume(session.id);

    expect(adapter.resume).toHaveBeenLastCalledWith(
      "agent-uuid-1",
      expect.objectContaining({ mcpConfigFile: `/generated/${session.id}/mcp-config.json` }),
    );
  });

  it("registerHistorical() creates an exited placeholder session resumable later", async () => {
    const { manager } = makeManager();
    const session = manager.registerHistorical({
      agentSessionId: "agent-uuid-9",
      harness: "claude-code",
      cwd: "/tmp/proj",
      title: "past session",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });

    expect(session.status).toBe("exited");
    expect(session.agentSessionId).toBe("agent-uuid-9");

    const resumed = await manager.resume(session.id);
    expect(resumed.status).toBe("running");
  });

  it("new sessions start with boundWorkflowPath: null", async () => {
    const { manager } = makeManager();
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
    expect(session.boundWorkflowPath).toBeNull();
    expect(manager.get(session.id)?.boundWorkflowPath).toBeNull();
  });

  describe("harness-context.json wiring", () => {
    it("create() writes the initial workspace context for every session, regardless of caller", async () => {
      const writeWorkspaceContext = vi.fn(async () => {});
      const { manager } = makeManager({ writeWorkspaceContext });

      // No REST layer involved at all here — this is exactly the
      // autoCreateSession call shape (server/index.ts calling
      // sessionManager.create() directly), the entry point that used to skip
      // the write entirely because it lived in the REST handler instead.
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      expect(writeWorkspaceContext).toHaveBeenCalledTimes(1);
      expect(writeWorkspaceContext).toHaveBeenCalledWith(session);
    });

    it("create() writes the workspace context before the pty is actually spawned", async () => {
      const order: string[] = [];
      const writeWorkspaceContext = vi.fn(async () => {
        order.push("write");
      });
      const spawnPty: PtySpawnFn = (file, args) => {
        order.push("spawn");
        void file;
        void args;
        return createFakePty().pty as unknown as ReturnType<PtySpawnFn>;
      };
      const { manager } = makeManager({ writeWorkspaceContext, spawnPty });

      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      // The agent's very first read of HARNESS_CONTEXT_FILE must never race
      // session creation with an ENOENT — that only holds if the write is
      // fully awaited before the real process (the pty) ever starts.
      expect(order).toEqual(["write", "spawn"]);
    });

    it("create() still creates and spawns the session even if writeWorkspaceContext rejects", async () => {
      const writeWorkspaceContext = vi.fn(async () => {
        throw new Error("disk full");
      });
      const { manager } = makeManager({ writeWorkspaceContext });

      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).rejects.toThrow("disk full");
    });

    it("resume() backfills the workspace context only when it's missing", async () => {
      const writeWorkspaceContext = vi.fn(async () => {});
      const workspaceContextExists = vi.fn(async () => false);
      const { manager } = makeManager({ writeWorkspaceContext, workspaceContextExists });

      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      writeWorkspaceContext.mockClear(); // registerHistorical() doesn't call it; isolate resume()'s call

      await manager.resume(session.id);

      expect(workspaceContextExists).toHaveBeenCalledWith("/tmp/proj");
      expect(writeWorkspaceContext).toHaveBeenCalledTimes(1);
      // Same object reference resume() mutated in place (status, exitCode,
      // lastActiveAt) before writing — the callee (server/index.ts's
      // writeSessionContext) resolves boundWorkflowPath itself, so passing
      // the whole session is all resume() needs to do here.
      expect(writeWorkspaceContext).toHaveBeenCalledWith(manager.get(session.id));
    });

    it("resume() never overwrites an existing workspace context file", async () => {
      const writeWorkspaceContext = vi.fn(async () => {});
      const workspaceContextExists = vi.fn(async () => true);
      const { manager } = makeManager({ writeWorkspaceContext, workspaceContextExists });

      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });

      await manager.resume(session.id);

      expect(workspaceContextExists).toHaveBeenCalledWith("/tmp/proj");
      expect(writeWorkspaceContext).not.toHaveBeenCalled();
    });

    it("defaults to a no-op for both hooks so tests with fake cwds never touch the real filesystem", async () => {
      // makeManager() with no overrides exercises the SessionManagerOptions
      // defaults directly against a fake cwd ("/tmp/proj") that this test
      // never creates on disk. If the defaults silently did real fs I/O
      // instead of no-op'ing, this would either throw (ENOENT under a path
      // that doesn't exist) or leave a real .sapiom dir behind on the test
      // runner's machine — neither happens, proving both defaults are inert.
      const { manager } = makeManager();
      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).resolves.toBeDefined();

      const historical = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      await expect(manager.resume(historical.id)).resolves.toBeDefined();
    });
  });

  describe("canvas template wiring", () => {
    it("create() drops the canvas template for every session, regardless of caller", async () => {
      const ensureCanvasTemplate = vi.fn(async () => {});
      const { manager } = makeManager({ ensureCanvasTemplate });

      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      expect(ensureCanvasTemplate).toHaveBeenCalledTimes(1);
      expect(ensureCanvasTemplate).toHaveBeenCalledWith("/tmp/proj");
    });

    it("create() ensures the canvas template before the pty is actually spawned", async () => {
      const order: string[] = [];
      const ensureCanvasTemplate = vi.fn(async () => {
        order.push("canvas");
      });
      const spawnPty: PtySpawnFn = (file, args) => {
        order.push("spawn");
        void file;
        void args;
        return createFakePty().pty as unknown as ReturnType<PtySpawnFn>;
      };
      const { manager } = makeManager({ ensureCanvasTemplate, spawnPty });

      await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      // Same reasoning as writeWorkspaceContext: the canvas pane can open the
      // moment the session reports "running", so the template must already
      // be on disk before the real process (the pty) ever starts.
      expect(order).toEqual(["canvas", "spawn"]);
    });

    it("resume() also ensures the canvas template — the function itself is the backfill check", async () => {
      const ensureCanvasTemplate = vi.fn(async () => {});
      const { manager } = makeManager({ ensureCanvasTemplate });

      const session = manager.registerHistorical({
        agentSessionId: "agent-uuid-9",
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "past session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      ensureCanvasTemplate.mockClear(); // registerHistorical() doesn't call it; isolate resume()'s call

      await manager.resume(session.id);

      expect(ensureCanvasTemplate).toHaveBeenCalledWith("/tmp/proj");
    });

    it("defaults to a no-op so tests with fake cwds never touch the real filesystem", async () => {
      const { manager } = makeManager();
      await expect(manager.create({ cwd: "/tmp/proj", harness: "claude-code" })).resolves.toBeDefined();
    });
  });

  describe("setBoundWorkflowPath", () => {
    it("updates the in-memory session, persists it, and notifies status listeners", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

      const statuses: (string | null)[] = [];
      manager.onStatusChange((s) => {
        if (s.id === session.id) statuses.push(s.boundWorkflowPath);
      });

      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");
      await manager.flush();

      expect(manager.get(session.id)?.boundWorkflowPath).toBe("/tmp/leasing");
      expect(statuses).toEqual(["/tmp/leasing"]);

      const raw = JSON.parse(await readFile(sessionsPath, "utf8")) as HarnessSession[];
      expect(raw.find((s) => s.id === session.id)?.boundWorkflowPath).toBe("/tmp/leasing");
    });

    it("unbinds with null, persisting and notifying again", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");

      const statuses: (string | null)[] = [];
      manager.onStatusChange((s) => {
        if (s.id === session.id) statuses.push(s.boundWorkflowPath);
      });

      manager.setBoundWorkflowPath(session.id, null);
      await manager.flush();

      expect(manager.get(session.id)?.boundWorkflowPath).toBeNull();
      expect(statuses).toEqual([null]);
    });

    it("is a no-op (doesn't throw, doesn't notify) for an unknown session id", async () => {
      const { manager } = makeManager();
      const statuses: string[] = [];
      manager.onStatusChange(() => statuses.push("fired"));

      expect(() => manager.setBoundWorkflowPath("does-not-exist", "/tmp/leasing")).not.toThrow();
      await manager.flush();
      expect(statuses).toEqual([]);
    });

    it("is a no-op when rebinding to the already-current value (no redundant persist/notify)", async () => {
      const { manager } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });
      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");
      await manager.flush();

      const statuses: (string | null)[] = [];
      manager.onStatusChange((s) => {
        if (s.id === session.id) statuses.push(s.boundWorkflowPath);
      });

      manager.setBoundWorkflowPath(session.id, "/tmp/leasing");
      await manager.flush();
      expect(statuses).toEqual([]);
    });
  });

  it("injects the contract's ENV.* variables into the spawned process env", async () => {
    const capturedEnvs: Record<string, string | undefined>[] = [];
    const spawnPty: PtySpawnFn = (_file, _args, options) => {
      capturedEnvs.push(options.env ?? {});
      const fake = createFakePty();
      return fake.pty as unknown as ReturnType<PtySpawnFn>;
    };
    const { manager } = makeManager({ spawnPty });
    const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    const env = capturedEnvs[0];
    expect(env?.["SAPIOM_HARNESS_INGEST_URL"]).toBe("http://127.0.0.1:4100/ingest");
    expect(env?.["SAPIOM_HARNESS_INGEST_TOKEN"]).toBe("boot-token");
    expect(env?.["SAPIOM_HARNESS_SESSION_ID"]).toBe(session.id);
  });

  it("unsets env vars the adapter's SpawnSpec maps to null", async () => {
    process.env["HARNESS_TEST_UNSET_ME"] = "should-be-removed";
    const capturedEnvs: Record<string, string | undefined>[] = [];
    const adapter = createFakeAdapter({
      launch: vi.fn(
        (opts): SpawnSpec => ({
          command: "fake-claude",
          args: [],
          env: { HARNESS_TEST_UNSET_ME: null },
          cwd: opts.cwd,
        }),
      ),
    });
    const spawnPty: PtySpawnFn = (_file, _args, options) => {
      capturedEnvs.push(options.env ?? {});
      const fake = createFakePty();
      return fake.pty as unknown as ReturnType<PtySpawnFn>;
    };
    const { manager } = makeManager({ adapter, spawnPty });
    await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

    expect(capturedEnvs[0]?.["HARNESS_TEST_UNSET_ME"]).toBeUndefined();
    delete process.env["HARNESS_TEST_UNSET_ME"];
  });
});
