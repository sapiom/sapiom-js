import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessAdapter, HarnessSession, SpawnSpec } from "../shared/types.js";
import { SessionManager, type PtySpawnFn } from "./session-manager.js";

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

  function makeManager(opts: { adapter?: HarnessAdapter; spawnPty?: PtySpawnFn } = {}) {
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
