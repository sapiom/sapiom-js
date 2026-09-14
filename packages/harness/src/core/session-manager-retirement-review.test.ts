import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../shared/types.js";
import { IngestCredentialRegistry } from "./ingest-credentials.js";
import { SessionManager, type PtySpawnFn } from "./session-manager.js";

function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
    enter = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await held;
    },
  };
}

describe("retained Terminal cleanup and bound restart cancellation", () => {
  let root: string;
  let manager: SessionManager;
  let spawns: { kill: ReturnType<typeof vi.fn>; exit: () => void }[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "terminal-retirement-review-"));
    spawns = [];
  });
  afterEach(async () => {
    spawns.forEach((spawn) => spawn.exit());
    await manager?.flush();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  function fixture() {
    const request = { cwd: root, harness: "claude-code" as const };
    const path = join(root, "sessions.json");
    const writeBinding = vi.fn(async (file: string, text: string) => {
      await writeFile(file, text);
    });
    const resolveIdentity = vi.fn(async (sessionId: string) => ({
      sessionId,
      projectId: "project-1",
      userId: "user-1",
    }));
    const isPidAlive = vi.fn(() => true);
    const canResume = vi.fn(async () => false);
    const spec = { command: "fake-terminal", args: [], env: {}, cwd: root };
    const adapter: HarnessAdapter = {
      id: "claude-code",
      eventSource: "hooks",
      doctor: async () => [],
      launch: vi.fn(() => spec),
      resume: vi.fn(() => spec),
      listPastSessions: async () => [],
      canResume,
    };
    const spawnPty: PtySpawnFn = vi.fn(() => {
      const listeners: (() => void)[] = [];
      const kill = vi.fn();
      spawns.push({
        kill,
        exit: () => listeners.forEach((listener) => listener()),
      });
      return {
        pid: 900_000 + spawns.length,
        kill,
        write: vi.fn(),
        resize: vi.fn(),
        onData: () => ({ dispose: () => {} }),
        onExit: (listener: (event: { exitCode: number }) => void) => {
          listeners.push(() => listener({ exitCode: 0 }));
          return { dispose: () => {} };
        },
      } as unknown as ReturnType<PtySpawnFn>;
    });
    manager = new SessionManager({
      sessionsPath: path,
      ingestUrl: "http://127.0.0.1:4100",
      ingestCredentials: new IngestCredentialRegistry(() => "boot"),
      adapters: { "claude-code": adapter },
      resolveAgentMapIdentity: resolveIdentity,
      writeSubsessionBindingRegistry: writeBinding,
      onSubsessionUserClosed: async () => {},
      spawnPty,
      isPidAlive,
    });
    return {
      request,
      path,
      writeBinding,
      resolveIdentity,
      isPidAlive,
      canResume,
      spawnPty,
      adapter,
    };
  }

  it.each(["onExit", "liveness", "signal-failure"])(
    "shutdown retries an exact retired handle and preserves %s evidence",
    async (evidence) => {
      vi.useFakeTimers();
      const { request, isPidAlive } = fixture();
      const session = await manager.create(request);
      const epoch = manager.getRuntimeEpoch(session.id);
      const closing = manager.closeWithResult(session.id);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await closing).toEqual({
        state: "unconfirmed",
        runtimeEpoch: epoch,
      });
      expect(manager.isLive(session.id)).toBe(false);
      const kill = spawns[0]!.kill;
      kill.mockImplementation(() => {
        if (evidence === "onExit") spawns[0]!.exit();
        if (evidence === "liveness") isPidAlive.mockReturnValue(false);
        if (evidence === "signal-failure") throw new Error("signal failed");
      });
      manager.beginShutdown();
      const shutdown = manager.killAll(),
        duplicate = manager.killAll();
      expect(kill).toHaveBeenCalledTimes(3);
      expect(kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(manager.isLive(session.id)).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([shutdown, duplicate]);
      expect(await manager.closeWithResult(session.id)).toEqual({
        state: evidence === "signal-failure" ? "unconfirmed" : "confirmed",
        runtimeEpoch: epoch,
      });
    },
  );

  it("a late retired-handle retry cannot touch a replacement runtime", async () => {
    vi.useFakeTimers();
    const { request, canResume } = fixture();
    const session = await manager.create(request);
    await manager.setAgentSessionId(
      session.id,
      "vendor-1",
      "startup",
      manager.getRuntimeEpoch(session.id)!,
    );
    const closing = manager.closeWithResult(session.id);
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await closing).state).toBe("unconfirmed");
    const retry = manager.killAll();
    spawns[0]!.exit();
    canResume.mockResolvedValue(true);
    await manager.resume(session.id);
    const epoch = manager.getRuntimeEpoch(session.id);
    spawns[0]!.exit();
    await vi.advanceTimersByTimeAsync(500);
    await retry;
    expect(manager.getRuntimeEpoch(session.id)).toBe(epoch);
    expect(manager.isLive(session.id)).toBe(true);
    expect(spawns[1]!.kill).not.toHaveBeenCalled();
  });

  it.each(["vendor-probe", "history-probe", "binding-write", "authority"])(
    "End cannot be undone by a fresh restart paused in %s",
    async (stage) => {
      const {
        request,
        path,
        writeBinding,
        resolveIdentity,
        canResume,
        spawnPty,
        adapter,
      } = fixture();
      const id = "00000000-0000-4000-8000-000000000333";
      const marker = {
        sessionId: id,
        projectId: "project-1",
        parentSessionId: "parent-1",
        bindingId: "binding-1",
        incarnation: 1,
        spawnEpoch: 1,
      };
      const trusted = {
        agentMapIdentity: () => ({
          sessionId: id,
          projectId: "project-1",
          userId: "user-1",
        }),
      };
      await manager.createReserved(id, request, marker, trusted);
      if (stage === "vendor-probe")
        await manager.setAgentSessionId(
          id,
          "vendor-1",
          "startup",
          manager.getRuntimeEpoch(id)!,
        );
      spawns[0]!.exit();
      await manager.flush();
      const held = gate();
      const recorded = vi.fn(async () => {
        if (stage === "history-probe") await held.wait();
        return false;
      });
      if (stage === "vendor-probe")
        canResume.mockImplementationOnce(async () => {
          await held.wait();
          return false;
        });
      if (stage === "binding-write")
        writeBinding.mockImplementationOnce(async (file, text) => {
          await held.wait();
          await writeFile(file, text);
        });
      if (stage === "authority")
        resolveIdentity.mockImplementationOnce(async () => {
          await held.wait();
          return trusted.agentMapIdentity();
        });
      const restarting = manager.restartFreshBound(
        id,
        marker,
        { ...marker, incarnation: 2, spawnEpoch: 2 },
        trusted,
        recorded,
      );
      const cancelled = expect(restarting).rejects.toMatchObject({
        code: "SESSION_PREPARATION_CANCELLED",
      });
      await held.entered;
      const closing = manager.close(id);
      try {
        if (stage === "binding-write") {
          // The initial reservation and held restart are the only writes.
          // End must wait for the older write before persisting its tombstone.
          expect(writeBinding).toHaveBeenCalledTimes(2);
        } else {
          await closing;
          expect(manager.getSubsessionBinding(id)).toBeNull();
        }
      } finally {
        held.release();
        await Promise.all([closing, cancelled]);
      }
      expect(manager.getSubsessionBinding(id)).toBeNull();
      expect(
        JSON.parse(await readFile(`${path}.subsession-bindings.json`, "utf8")),
      ).toEqual({ version: 1, markers: {}, closedSessionIds: [] });
      expect(spawnPty).toHaveBeenCalledOnce();
      expect(adapter.launch).toHaveBeenCalledOnce();
      expect(manager.get(id)?.status).toBe("exited");
      if (stage === "vendor-probe") expect(recorded).not.toHaveBeenCalled();
      fixture();
      await manager.init();
      expect(manager.getSubsessionBinding(id)).toBeNull();
    },
  );

  it.each([false, true])(
    "surfaces failed marker repair after commit=%s and permits durable close retry",
    async (committed) => {
      const { request, path, writeBinding, spawnPty } = fixture();
      const id = "00000000-0000-4000-8000-000000000334";
      const marker = {
        sessionId: id,
        projectId: "project-1",
        parentSessionId: "parent-1",
        bindingId: "binding-1",
        incarnation: 1,
        spawnEpoch: 1,
      };
      const trusted = {
        agentMapIdentity: () => ({
          sessionId: id,
          projectId: "project-1",
          userId: "user-1",
        }),
      };
      await manager.createReserved(id, request, marker, trusted);
      spawns[0]!.exit();
      await manager.flush();
      const repairFailure = Object.assign(new Error("marker repair failed"), {
        code: "ENOSPC",
      });
      writeBinding
        .mockImplementationOnce(async (file, text) => {
          if (committed) await writeFile(file, text);
          throw new Error("marker write outcome uncertain");
        })
        .mockRejectedValueOnce(repairFailure);
      await expect(
        manager.restartFreshBound(
          id,
          marker,
          { ...marker, incarnation: 2, spawnEpoch: 2 },
          trusted,
          async () => false,
        ),
      ).rejects.toBe(repairFailure);
      expect(spawnPty).toHaveBeenCalledOnce();
      // A failed write must not poison the queue or conceal the repair error.
      // A later successful End must remove even a possibly committed marker.
      await manager.close(id);
      expect(
        JSON.parse(await readFile(`${path}.subsession-bindings.json`, "utf8")),
      ).toEqual({ version: 1, markers: {}, closedSessionIds: [] });
      fixture();
      await manager.init();
      expect(manager.getSubsessionBinding(id)).toBeNull();
    },
  );
});
