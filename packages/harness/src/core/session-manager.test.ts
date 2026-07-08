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

      const ok = await manager.submitInput(session.id, "", true);

      expect(ok).toBe(true);
      expect(spawns[0]?.pty.write).toHaveBeenCalledTimes(1);
      expect(spawns[0]?.pty.write).toHaveBeenCalledWith("\r");
    });

    it("writes only the text, with no \\r at all, when submit is false", async () => {
      const { manager, spawns } = makeManager();
      const session = await manager.create({ cwd: "/tmp/proj", harness: "claude-code" });

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
