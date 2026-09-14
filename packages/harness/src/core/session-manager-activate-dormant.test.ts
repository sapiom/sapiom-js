import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter, HarnessSession } from "../shared/types.js";
import { AssistantSessionStore } from "./assistant-session-store.js";
import { IngestCredentialRegistry } from "./ingest-credentials.js";
import {
  SessionManager,
  ProjectSessionScopeUnavailableError,
  type PtySpawnFn,
} from "./session-manager.js";

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

describe("explicit dormant Terminal activation", () => {
  let root: string;
  let manager: SessionManager;
  let spawns: {
    kill: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    exit: () => void;
  }[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "activate-terminal-"));
    spawns = [];
  });
  afterEach(async () => {
    spawns.forEach((spawn) => spawn.exit());
    await manager?.flush();
    await rm(root, { recursive: true, force: true });
  });

  async function fixture() {
    const path = join(root, "sessions.json");
    const identity = {
      projectId: "project-1",
      userId: "user-1",
      sessionId: "parent",
    };
    const parent: HarnessSession = {
      id: "parent",
      cwd: root,
      harness: "claude-code",
      title: "parent",
      status: "exited",
      ready: false,
      agentSessionId: null,
      boundWorkflowPath: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      lastActiveAt: "2020-01-01T00:00:00.000Z",
      agentMapIdentity: identity,
    };
    await writeFile(path, JSON.stringify([parent]));
    const authority = {
      userId: identity.userId,
      projectId: identity.projectId,
      generation: 1,
    };
    const resolver = vi.fn(
      async (sessionId: string, cwd: string, persisted = identity) => {
        if (
          cwd !== root ||
          persisted.userId !== authority.userId ||
          persisted.projectId !== authority.projectId ||
          persisted.sessionId !== sessionId
        )
          throw new ProjectSessionScopeUnavailableError(sessionId);
        return { ...persisted };
      },
    );
    const spawnPty = vi.fn<PtySpawnFn>(() => {
      const listeners: (() => void)[] = [];
      const exit = () => listeners.forEach((listener) => listener());
      const kill = vi.fn(exit),
        write = vi.fn();
      spawns.push({ kill, write, exit });
      return {
        pid: 900_001,
        kill,
        write,
        resize: vi.fn(),
        onData: () => ({ dispose: () => {} }),
        onExit: (listener: (event: { exitCode: number }) => void) => {
          listeners.push(() => listener({ exitCode: 0 }));
          return { dispose: () => {} };
        },
      } as unknown as ReturnType<PtySpawnFn>;
    });
    const hooks = {
      buildLaunchOpts: vi.fn(async () => ({
        mcpCredentialLaunch: {
          generation: authority.generation,
          credentialBearing: true,
        },
        initialPrompt: "never replay",
        rehydratedFrom: "parent",
      })),
      writeWorkspaceContext: vi.fn(async () => {}),
      ensureCanvasTemplate: vi.fn(async () => {}),
      loadSpawnPty: vi.fn(async () => spawnPty),
      onRuntimeEpochTransition: vi.fn(async () => {}),
      prepareProjectSession: vi.fn(async () => ({})),
      onProjectBootstrapSession: vi.fn(),
      writeSessionRegistry: vi.fn(async (file: string, text: string) => {
        await writeFile(file, text);
      }),
    };
    const spec = { command: "fake-terminal", args: [], env: {}, cwd: root };
    const adapter: HarnessAdapter = {
      id: "claude-code",
      eventSource: "hooks",
      doctor: vi.fn(async () => []),
      launch: vi.fn(() => spec),
      resume: vi.fn(() => spec),
      canResume: vi.fn(async () => true),
      listPastSessions: vi.fn(async () => []),
    };
    manager = new SessionManager({
      sessionsPath: path,
      ingestUrl: "http://127.0.0.1:4100",
      ingestCredentials: new IngestCredentialRegistry(() => "boot"),
      adapters: { "claude-code": adapter },
      resolveAgentMapIdentity: resolver,
      currentCredentialGeneration: () => authority.generation,
      isPidAlive: () => false,
      ...hooks,
    });
    await manager.init();
    const child = await manager.allocateDormant("parent", {
      childSessionId: "child",
      harness: "claude-code",
      expectedSource: {
        cwd: root,
        projectId: identity.projectId,
        userId: identity.userId,
      },
    });
    vi.clearAllMocks();
    return { child, adapter, hooks, resolver, spawnPty, authority, path };
  }

  it("coalesces the first start and preserves the child and Assistant association", async () => {
    const { child, adapter, hooks, spawnPty, path } = await fixture();
    const store = new AssistantSessionStore(root);
    const key = {
      harnessSessionId: child.id,
      contextAuthorityScope: "a".repeat(64),
      cwd: root,
    };
    const retained = await store.associate(
      key,
      "b".repeat(64),
      async () => "ses_child",
    );
    const held = gate();
    const initial = hooks.buildLaunchOpts.getMockImplementation()!;
    hooks.buildLaunchOpts.mockImplementationOnce(async () => {
      await held.wait();
      return initial();
    });
    const first = manager.activateDormant(child.id);
    expect(manager.activateDormant(child.id)).toBe(first);
    await held.entered;
    expect(child.terminalState).toBe("not-started");
    held.release();
    expect(await first).toBe(child);
    expect(await manager.activateDormant(child.id)).toBe(child);
    expect(spawnPty).toHaveBeenCalledOnce();
    expect(hooks.buildLaunchOpts).toHaveBeenCalledWith(
      child.id,
      { cwd: root, harness: "claude-code" },
      { agentMapIdentity: child.agentMapIdentity, resume: true },
    );
    expect(adapter.launch).toHaveBeenCalledWith({
      harnessSessionId: child.id,
      cwd: root,
    });
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(hooks.prepareProjectSession).not.toHaveBeenCalled();
    expect(hooks.onProjectBootstrapSession).not.toHaveBeenCalled();
    expect(spawns[0]!.write).not.toHaveBeenCalled();
    expect(child).toMatchObject({
      id: "child",
      status: "running",
      ready: false,
      agentSessionId: null,
    });
    expect(child.terminalState).toBeUndefined();
    expect(
      JSON.parse(await readFile(path, "utf8"))[1].terminalState,
    ).toBeUndefined();
    expect(await store.association(key)).toEqual(retained);
    manager.setReady(child.id, manager.getRuntimeEpoch(child.id)!);
    expect(child.ready).toBe(true);
  });

  it.each([
    "identity",
    "persist",
    "config",
    "workspace",
    "canvas",
    "loader",
    "epoch",
    "authority",
  ])("End fences activation paused in %s", async (stage) => {
    const { child, hooks, resolver, spawnPty } = await fixture();
    const held = gate();
    const stages = {
      persist: hooks.writeSessionRegistry,
      config: hooks.buildLaunchOpts,
      workspace: hooks.writeWorkspaceContext,
      canvas: hooks.ensureCanvasTemplate,
      loader: hooks.loadSpawnPty,
      epoch: hooks.onRuntimeEpochTransition,
    };
    if (stage === "identity" || stage === "authority") {
      const original = resolver.getMockImplementation()!;
      let calls = 0;
      resolver.mockImplementation(async (...args) => {
        if (++calls === (stage === "identity" ? 1 : 3)) await held.wait();
        return original(...args);
      });
    } else {
      const target = stages[stage as keyof typeof stages];
      const original = target.getMockImplementation()!;
      target.mockImplementationOnce((async (...args: never[]) => {
        await held.wait();
        return (original as (...args: never[]) => unknown)(...args);
      }) as never);
    }
    const activating = manager.activateDormant(child.id);
    await held.entered;
    await manager.close(child.id);
    held.release();
    await expect(activating).rejects.toMatchObject({
      code: "SESSION_PREPARATION_CANCELLED",
    });
    expect(child.terminalState).toBe("not-started");
    expect(spawnPty).not.toHaveBeenCalled();
    if (["identity", "persist", "config"].includes(stage))
      expect(hooks.writeWorkspaceContext).not.toHaveBeenCalled();
  });

  it.each([
    "persist",
    "config",
    "workspace",
    "canvas",
    "loader",
    "epoch",
    "spawn",
  ])("a %s failure keeps a retryable dormant record", async (stage) => {
    const { child, hooks, spawnPty } = await fixture();
    const lastActive = child.lastActiveAt;
    const stages = {
      persist: hooks.writeSessionRegistry,
      config: hooks.buildLaunchOpts,
      workspace: hooks.writeWorkspaceContext,
      canvas: hooks.ensureCanvasTemplate,
      loader: hooks.loadSpawnPty,
      epoch: hooks.onRuntimeEpochTransition,
      spawn: spawnPty,
    };
    stages[stage as keyof typeof stages].mockImplementationOnce(() => {
      throw new Error("activation fixture failure");
    });
    await expect(manager.activateDormant(child.id)).rejects.toThrow(
      "activation fixture failure",
    );
    expect(child).toMatchObject({
      terminalState: "not-started",
      status: "exited",
      lastActiveAt: lastActive,
    });
    expect(manager.list()).toHaveLength(2);
    await manager.activateDormant(child.id);
    expect(spawns).toHaveLength(1);
    expect(child.terminalState).toBeUndefined();
  });

  it("revalidates authority and credentials at the final PTY boundary", async () => {
    const { child, hooks, authority, spawnPty } = await fixture();
    authority.userId = "other-user";
    await expect(manager.activateDormant(child.id)).rejects.toBeInstanceOf(
      ProjectSessionScopeUnavailableError,
    );
    authority.userId = "user-1";
    const held = gate();
    hooks.onRuntimeEpochTransition.mockImplementationOnce(held.wait);
    const activating = manager.activateDormant(child.id);
    await held.entered;
    authority.generation = 2;
    held.release();
    await expect(activating).rejects.toMatchObject({
      code: "MCP_CREDENTIAL_GENERATION_CHANGED",
    });
    expect(spawnPty).not.toHaveBeenCalled();
    await manager.activateDormant(child.id);
    expect(child.mcpAuthState).toBe("current");
  });

  it("cleans up a real PTY when its running-state write fails without claiming it never started", async () => {
    const { child, hooks, spawnPty } = await fixture();
    const original = hooks.writeSessionRegistry.getMockImplementation()!;
    hooks.writeSessionRegistry.mockImplementation(async (file, text) => {
      if (
        JSON.parse(text).some(
          (row: HarnessSession) =>
            row.id === child.id && row.status === "running",
        )
      )
        throw new Error("running-state write failed");
      await original(file, text);
    });
    await expect(manager.activateDormant(child.id)).rejects.toThrow(
      "running-state write failed",
    );
    expect(child.terminalState).toBeUndefined();
    expect(child.status).toBe("exited");
    expect((await manager.closeWithResult(child.id)).state).toBe("confirmed");
    await expect(manager.activateDormant(child.id)).rejects.toMatchObject({
      code: "SESSION_NOT_DORMANT",
    });
    expect(spawnPty).toHaveBeenCalledOnce();
  });

  it("End observes the started PTY while its first running-state persistence is pending", async () => {
    const { child, hooks, spawnPty, path } = await fixture();
    const held = gate(),
      original = hooks.writeSessionRegistry.getMockImplementation()!;
    hooks.writeSessionRegistry.mockImplementation(async (file, text) => {
      if (
        JSON.parse(text).some(
          (row: HarnessSession) =>
            row.id === child.id && row.status === "running",
        )
      )
        await held.wait();
      await original(file, text);
    });
    const activating = manager.activateDormant(child.id);
    await held.entered;
    const epoch = manager.getRuntimeEpoch(child.id);
    expect(child.terminalState).toBeUndefined();
    expect(await manager.closeWithResult(child.id)).toEqual({
      state: "confirmed",
      runtimeEpoch: epoch,
    });
    held.release();
    await expect(activating).rejects.toMatchObject({
      code: "SESSION_PREPARATION_CANCELLED",
    });
    await manager.flush();
    expect(JSON.parse(await readFile(path, "utf8"))[1]).toMatchObject({
      id: child.id,
      status: "exited",
    });
    expect(spawnPty).toHaveBeenCalledOnce();
    await expect(manager.activateDormant(child.id)).rejects.toMatchObject({
      code: "SESSION_NOT_DORMANT",
    });
  });

  it.each(["principal", "project", "root"])(
    "rejects changed %s authority after epoch persistence",
    async (change) => {
      const { child, hooks, authority, spawnPty } = await fixture();
      const held = gate();
      hooks.onRuntimeEpochTransition.mockImplementationOnce(held.wait);
      const activating = manager.activateDormant(child.id);
      await held.entered;
      if (change === "principal") authority.userId = "other-user";
      if (change === "project") authority.projectId = "other-project";
      if (change === "root") child.cwd = join(root, "other-root");
      held.release();
      await expect(activating).rejects.toBeInstanceOf(
        ProjectSessionScopeUnavailableError,
      );
      expect(child.terminalState).toBe("not-started");
      expect(spawnPty).not.toHaveBeenCalled();
    },
  );

  it("rejects generic Resume and unallocated rows, and blocks activation after shutdown begins", async () => {
    const { child, hooks, spawnPty } = await fixture();
    await expect(manager.resume(child.id)).rejects.toMatchObject({
      code: "SESSION_NOT_RESUMEABLE",
    });
    manager.get("parent")!.terminalState = "not-started";
    await expect(manager.activateDormant("parent")).rejects.toMatchObject({
      code: "SESSION_NOT_DORMANT",
    });
    const held = gate(),
      original = hooks.buildLaunchOpts.getMockImplementation()!;
    hooks.buildLaunchOpts.mockImplementationOnce(async () => {
      await held.wait();
      return original();
    });
    const activating = manager.activateDormant(child.id);
    await held.entered;
    manager.beginShutdown();
    await expect(manager.activateDormant(child.id)).rejects.toMatchObject({
      code: "SESSION_MANAGER_CLOSING",
    });
    held.release();
    await expect(activating).rejects.toMatchObject({
      code: "SESSION_MANAGER_CLOSING",
    });
    expect(spawnPty).not.toHaveBeenCalled();
  });
});
