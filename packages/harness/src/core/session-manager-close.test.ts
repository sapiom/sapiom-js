import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../shared/types.js";
import { IngestCredentialRegistry } from "./ingest-credentials.js";
import {
  SessionManager,
  type PtySpawnFn,
  type SessionManagerOptions,
} from "./session-manager.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
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

const request = {
  cwd: "/tmp/terminal-close-fixture",
  harness: "claude-code" as const,
};
const history = {
  ...request,
  agentSessionId: "vendor-session",
  title: "Terminal",
  lastActiveAt: "2026-09-14T00:00:00.000Z",
};

describe("Terminal close admission and evidence", () => {
  let directory: string;
  let manager: SessionManager;
  let spawns: { kill: ReturnType<typeof vi.fn>; exit: () => void }[];
  let spawnPty: PtySpawnFn;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "terminal-close-"));
    spawns = [];
    spawnPty = vi.fn(() => {
      const listeners: (() => void)[] = [];
      const kill = vi.fn();
      spawns.push({
        kill,
        exit: () => listeners.forEach((listener) => listener()),
      });
      return {
        pid: 987_000 + spawns.length,
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
  });

  afterEach(async () => {
    spawns.forEach((spawn) => spawn.exit());
    await manager?.flush();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  function make(
    options: Partial<SessionManagerOptions> = {},
    canResume = async () => true,
  ) {
    const spec = {
      command: "fake-terminal",
      args: [],
      env: {},
      cwd: request.cwd,
    };
    const adapter: HarnessAdapter = {
      id: "claude-code",
      eventSource: "hooks",
      doctor: async () => [],
      launch: () => spec,
      resume: () => spec,
      listPastSessions: async () => [],
      canResume,
    };
    let sequence = 0;
    manager = new SessionManager({
      adapters: { "claude-code": adapter },
      ingestUrl: "http://127.0.0.1:4100",
      ingestCredentials: new IngestCredentialRegistry(() => "boot-token"),
      sessionsPath: join(directory, "sessions.json"),
      generateId: () => `terminal-${++sequence}`,
      spawnPty,
      isPidAlive: () => true,
      ...options,
    });
    return manager;
  }

  it.each([
    "identity",
    "options",
    "workspace",
    "canvas",
    "loader",
    "epoch",
    "authority",
  ])("fences create paused in %s before PTY publication", async (stage) => {
    const held = gate();
    let identityCalls = 0;
    make({
      resolveAgentMapIdentity: async (sessionId) => {
        identityCalls += 1;
        if (
          (stage === "identity" && identityCalls === 1) ||
          (stage === "authority" && identityCalls === 3)
        )
          await held.wait();
        return { sessionId, userId: "user-1", projectId: "project-1" };
      },
      buildLaunchOpts: async () => {
        if (stage === "options") await held.wait();
        return {};
      },
      writeWorkspaceContext: async () => {
        if (stage === "workspace") await held.wait();
      },
      ensureCanvasTemplate: async () => {
        if (stage === "canvas") await held.wait();
      },
      ...(stage === "loader"
        ? {
            spawnPty: undefined,
            loadSpawnPty: async () => {
              await held.wait();
              return spawnPty;
            },
          }
        : {}),
      onRuntimeEpochTransition: async (_session, epoch) => {
        if (stage === "epoch" && epoch) await held.wait();
      },
    });
    const creating = manager.create(request);
    await held.entered;
    await manager.close("terminal-1");
    held.release();
    await expect(creating).rejects.toMatchObject({
      code: "SESSION_PREPARATION_CANCELLED",
    });
    expect(spawnPty).not.toHaveBeenCalled();
    expect(
      (await manager.create({ ...request, cwd: "/tmp/other-terminal" })).status,
    ).toBe("running");
  });

  it.each(["preflight", "options", "context", "loader", "epoch"])(
    "fences resume paused in %s and holds replacement preparation until it settles",
    async (stage) => {
      const held = gate();
      make(
        {
          buildLaunchOpts: async () => {
            if (stage === "options") await held.wait();
            return {};
          },
          prepareWorkspaceContext: async () => {
            if (stage === "context") await held.wait();
          },
          ...(stage === "loader"
            ? {
                spawnPty: undefined,
                loadSpawnPty: async () => {
                  await held.wait();
                  return spawnPty;
                },
              }
            : {}),
          onRuntimeEpochTransition: async (_session, epoch) => {
            if (stage === "epoch" && epoch) await held.wait();
          },
        },
        async () => {
          if (stage === "preflight") await held.wait();
          return true;
        },
      );
      const session = await manager.registerHistorical(history);
      const resuming = manager.resume(session.id);
      await held.entered;
      await manager.close(session.id);
      await expect(manager.resume(session.id)).rejects.toMatchObject({
        code: "SESSION_ALREADY_LIVE",
      });
      held.release();
      await expect(resuming).rejects.toMatchObject({
        code: "SESSION_PREPARATION_CANCELLED",
      });
      expect(spawnPty).not.toHaveBeenCalled();
      await manager.resume(session.id);
      expect(spawnPty).toHaveBeenCalledOnce();
    },
  );

  it("captures a reserved create generation before its binding persistence", async () => {
    const held = gate();
    let writes = 0;
    make({
      writeSubsessionBindingRegistry: async () => {
        if (++writes === 1) await held.wait();
      },
    });
    const id = "00000000-0000-4000-8000-000000000123";
    const creating = manager.createReserved(
      id,
      request,
      {
        sessionId: id,
        projectId: "project-1",
        parentSessionId: "parent-1",
        bindingId: "binding-1",
        incarnation: 1,
        spawnEpoch: 1,
      },
      {},
    );
    const cancelled = expect(creating).rejects.toMatchObject({
      code: "SESSION_PREPARATION_CANCELLED",
    });
    await held.entered;
    const closing = manager.close(id);
    try {
      expect(writes).toBe(1);
    } finally {
      held.release();
      await Promise.all([closing, cancelled]);
    }
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("keeps global shutdown synchronous through the final runtime transition", async () => {
    const held = gate();
    make({
      onRuntimeEpochTransition: async (_session, epoch) => {
        if (epoch) await held.wait();
      },
    });
    const session = await manager.registerHistorical(history);
    const resuming = manager.resume(session.id);
    await held.entered;
    manager.beginShutdown();
    await manager.killAll();
    held.release();
    await expect(resuming).rejects.toMatchObject({
      code: "SESSION_MANAGER_CLOSING",
    });
    await expect(manager.create(request)).rejects.toMatchObject({
      code: "SESSION_MANAGER_CLOSING",
    });
    await expect(manager.resume(session.id)).rejects.toMatchObject({
      code: "SESSION_MANAGER_CLOSING",
    });
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("distinguishes absent, positive onExit, and a still-live fallback without blocking another ID", async () => {
    vi.useFakeTimers();
    make();
    expect(await manager.closeWithResult("absent")).toEqual({
      state: "absent",
      runtimeEpoch: null,
    });
    const first = await manager.create(request);
    const second = await manager.create(request);
    const firstEpoch = manager.getRuntimeEpoch(first.id);
    const secondEpoch = manager.getRuntimeEpoch(second.id);
    const firstClose = manager.closeWithResult(first.id);
    const duplicate = manager.closeWithResult(first.id);
    const secondClose = manager.closeWithResult(second.id);
    spawns[1]!.exit();
    expect(await secondClose).toEqual({
      state: "confirmed",
      runtimeEpoch: secondEpoch,
    });
    expect(spawns[0]!.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await firstClose).toEqual({
      state: "unconfirmed",
      runtimeEpoch: firstEpoch,
    });
    expect(await duplicate).toEqual(await firstClose);
    expect(manager.get(first.id)?.status).toBe("exited");
    expect(await manager.closeWithResult(first.id)).toEqual(await firstClose);
    expect(spawns[0]!.kill).toHaveBeenCalledTimes(2);
  });

  it.each(["onExit", "liveness"])(
    "reconciles late %s evidence without touching a replacement",
    async (evidence) => {
      vi.useFakeTimers();
      let alive = true;
      make({ isPidAlive: () => alive });
      const session = await manager.registerHistorical(history);
      await manager.resume(session.id);
      const oldEpoch = manager.getRuntimeEpoch(session.id)!;
      const closing = manager.closeWithResult(session.id);
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await closing).state).toBe("unconfirmed");
      await expect(manager.resume(session.id)).rejects.toMatchObject({
        code: "SESSION_CLEANUP_UNCONFIRMED",
      });
      if (evidence === "onExit") spawns[0]!.exit();
      else alive = false;
      expect(await manager.closeWithResult(session.id)).toEqual({
        state: "confirmed",
        runtimeEpoch: oldEpoch,
      });
      expect(await manager.closeWithResult(session.id)).toEqual({
        state: "confirmed",
        runtimeEpoch: oldEpoch,
      });
      alive = true;
      await manager.resume(session.id);
      const replacementEpoch = manager.getRuntimeEpoch(session.id)!;
      spawns[0]!.exit();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(manager.get(session.id)?.status).toBe("running");
      expect(manager.getRuntimeEpoch(session.id)).not.toBe(oldEpoch);
      expect(await manager.killIfRuntime(session.id, oldEpoch)).toBe(false);
      expect(spawns[1]!.kill).not.toHaveBeenCalled();
      const replacementClose = manager.closeWithResult(session.id);
      await vi.advanceTimersByTimeAsync(2_500);
      spawns[0]!.exit();
      expect(await replacementClose).toEqual({
        state: "unconfirmed",
        runtimeEpoch: replacementEpoch,
      });
      expect(await manager.closeWithResult(session.id)).toEqual(
        await replacementClose,
      );
      spawns[1]!.exit();
      spawns[0]!.exit();
      expect(await manager.closeWithResult(session.id)).toEqual({
        state: "confirmed",
        runtimeEpoch: replacementEpoch,
      });
    },
  );

  it("treats failed signals and liveness probes as unconfirmed", async () => {
    vi.useFakeTimers();
    make({
      isPidAlive: () => {
        throw new Error("probe failed");
      },
    });
    const session = await manager.create(request);
    spawns[0]!.kill.mockImplementation(() => {
      throw new Error("signal failed");
    });
    const closing = manager.closeWithResult(session.id);
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await closing).state).toBe("unconfirmed");
    expect(await manager.closeWithResult(session.id)).toEqual(await closing);
  });

  it("preserves ordinary exits and internal kill followed by same-ID resume", async () => {
    make();
    const session = await manager.registerHistorical(history);
    await manager.resume(session.id);
    spawns[0]!.exit();
    await manager.resume(session.id);
    const killing = manager.kill(session.id);
    spawns[1]!.exit();
    expect(await killing).toBe(true);
    await manager.resume(session.id);
    expect(spawnPty).toHaveBeenCalledTimes(3);
  });

  it("cancels an internal credential restart when End wins during its kill", async () => {
    let generation = 1;
    make({
      currentCredentialGeneration: () => generation,
      buildLaunchOpts: async () => ({
        mcpCredentialLaunch: { generation, credentialBearing: true },
      }),
    });
    const session = await manager.registerHistorical(history);
    await manager.resume(session.id);
    generation = 2;
    manager.reconcileMcpCredentialGeneration(generation);
    // Observe the signal synchronously without making the kill itself wait.
    const signalObserved = new Promise<void>((resolve) => {
      spawns[0]!.kill.mockImplementation(resolve);
    });
    const restarting = manager.restartForMcpCredentials(session.id);
    await signalObserved;
    const closing = manager.closeWithResult(session.id);
    spawns[0]!.exit();
    await expect(restarting).rejects.toMatchObject({
      code: "SESSION_PREPARATION_CANCELLED",
    });
    expect((await closing).state).toBe("confirmed");
    expect(spawnPty).toHaveBeenCalledOnce();
  });
});
