import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter, HarnessSession } from "../shared/types.js";
import { IngestCredentialRegistry } from "./ingest-credentials.js";
import {
  SessionManager,
  ProjectSessionScopeUnavailableError,
  type DormantSessionAllocationOptions,
  type PtySpawnFn,
  type SessionManagerOptions,
} from "./session-manager.js";
import { StudioProjectCatalog } from "./studio-project-catalog.js";

function gate() {
  let enter!: () => void;
  let release!: () => void;
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

describe("dormant Studio allocation", () => {
  let root: string;
  let sessionsPath: string;
  let source: HarnessSession;
  let allocation: DormantSessionAllocationOptions;
  let catalog: StudioProjectCatalog;
  let principal: string;
  let managers: SessionManager[];
  let exits: (() => void)[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dormant-studio-"));
    sessionsPath = join(root, "sessions.json");
    const cwd = join(root, "project");
    await mkdir(cwd);
    catalog = new StudioProjectCatalog(join(root, "projects.json"));
    const reconciled = await catalog.reconcile([
      { workspaceKey: "workspace-1", cwd },
    ]);
    const projectId = reconciled.projects[0]!.projectId;
    principal = "user-1";
    source = {
      id: "source-session",
      cwd,
      harness: "claude-code",
      title: "Parent title",
      agentSessionId: "parent-vendor",
      status: "exited",
      ready: false,
      createdAt: "2020-01-01T00:00:00.000Z",
      lastActiveAt: "2020-01-01T00:00:00.000Z",
      theme: "dark",
      boundWorkflowPath: join(cwd, "parent-workflow.ts"),
      rehydratedFrom: "grandparent",
      agentMapIdentity: {
        projectId,
        userId: principal,
        sessionId: "source-session",
      },
      projectBootstrap: {
        projectId,
        userId: principal,
        targetSessionId: "source-session",
        bootstrap: { status: "delivered", messageId: "parent-bootstrap" },
        queuedInputIds: ["parent-input"],
      },
    };
    allocation = {
      childSessionId: "reserved-child",
      harness: "claude-code",
      expectedSource: { cwd, projectId, userId: principal },
    };
    await writeFile(sessionsPath, JSON.stringify([source]));
    managers = [];
    exits = [];
  });

  afterEach(async () => {
    exits.forEach((exit) => exit());
    await Promise.all(managers.map((manager) => manager.flush()));
    await rm(root, { recursive: true, force: true });
  });

  async function make(options: Partial<SessionManagerOptions> = {}) {
    const spec = {
      command: "fake-terminal",
      args: [],
      env: {},
      cwd: source.cwd,
    };
    const adapter: HarnessAdapter = {
      id: "claude-code",
      eventSource: "hooks",
      doctor: vi.fn(async () => []),
      launch: vi.fn(() => spec),
      resume: vi.fn(() => spec),
      canResume: vi.fn(async () => true),
      listPastSessions: vi.fn(async () => []),
    };
    const spawnPty = vi.fn(() => ({
      pid: 999_998,
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      onData: () => ({ dispose: () => {} }),
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exits.push(() => listener({ exitCode: 0 }));
        return { dispose: () => {} };
      },
    })) as unknown as PtySpawnFn;
    const hooks = {
      buildLaunchOpts: vi.fn(async () => ({})),
      prepareProjectSession: vi.fn(async () => ({})),
      onProjectBootstrapSession: vi.fn(),
      onRuntimeEpochTransition: vi.fn(),
      writeWorkspaceContext: vi.fn(async () => {}),
      prepareWorkspaceContext: vi.fn(async () => {}),
      ensureCanvasTemplate: vi.fn(async () => {}),
    };
    const resolveAgentMapIdentity: NonNullable<
      SessionManagerOptions["resolveAgentMapIdentity"]
    > = async (sessionId, cwd, persisted) => {
      const project = await catalog.resolveIdentityForPath(cwd);
      if (
        !project ||
        (persisted &&
          (persisted.userId !== principal ||
            persisted.projectId !== project.projectId ||
            persisted.sessionId !== sessionId))
      )
        throw new ProjectSessionScopeUnavailableError(sessionId);
      return { userId: principal, sessionId, projectId: project.projectId };
    };
    const manager = new SessionManager({
      adapters: { "claude-code": adapter },
      sessionsPath,
      ingestUrl: "http://127.0.0.1:4100",
      ingestCredentials: new IngestCredentialRegistry(() => "boot"),
      spawnPty,
      isPidAlive: () => false,
      resolveAgentMapIdentity,
      ...hooks,
      ...options,
    });
    managers.push(manager);
    await manager.init();
    return { manager, adapter, spawnPty, hooks, resolveAgentMapIdentity };
  }

  it("persists one distinct inert child without invoking Terminal preparation or inheriting parent execution state", async () => {
    const { manager, spawnPty, adapter, hooks } = await make();
    const [child, duplicate] = await Promise.all([
      manager.allocateDormant(source.id, allocation),
      manager.allocateDormant(source.id, allocation),
    ]);
    expect(duplicate).toBe(child);
    expect(child).toEqual({
      id: allocation.childSessionId,
      harness: "claude-code",
      cwd: source.cwd,
      title: "project",
      status: "exited",
      terminalState: "not-started",
      ready: false,
      agentSessionId: null,
      exitCode: null,
      boundWorkflowPath: null,
      rehydratedFrom: null,
      createdAt: expect.any(String),
      lastActiveAt: expect.any(String),
      agentMapIdentity: {
        ...source.agentMapIdentity,
        sessionId: allocation.childSessionId,
      },
    });
    expect(child.createdAt).not.toBe(source.createdAt);
    expect(manager.get(source.id)).toEqual(source);
    expect(JSON.parse(await readFile(sessionsPath, "utf8"))).toEqual([
      source,
      child,
    ]);
    expect(await manager.canResumeSession(child.id)).toBe(false);
    expect(manager.getRuntimeEpoch(child.id)).toBeNull();
    expect(spawnPty).not.toHaveBeenCalled();
    Object.values(hooks).forEach((hook) => expect(hook).not.toHaveBeenCalled());
    Object.values(adapter)
      .filter((value) => typeof value === "function")
      .forEach((hook) => expect(hook).not.toHaveBeenCalled());
  });

  it("keeps exact retries stable after reload and rejects a different same-folder parent", async () => {
    const other = {
      ...source,
      id: "other-source",
      agentSessionId: "other-vendor",
      projectBootstrap: undefined,
      agentMapIdentity: {
        ...source.agentMapIdentity!,
        sessionId: "other-source",
      },
    };
    await writeFile(sessionsPath, JSON.stringify([source, other]));
    const { manager } = await make();
    const child = await manager.allocateDormant(source.id, allocation);
    const { manager: restarted, spawnPty } = await make();
    expect(await restarted.allocateDormant(source.id, allocation)).toEqual(
      child,
    );
    await expect(
      restarted.allocateDormant(other.id, allocation),
    ).rejects.toMatchObject({ code: "DORMANT_SESSION_ALLOCATION_MISMATCH" });
    expect(restarted.list()).toHaveLength(3);
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("does not adopt a matching public dormant row without private allocation proof", async () => {
    const foreign = {
      ...source,
      id: allocation.childSessionId,
      agentSessionId: null,
      terminalState: "not-started",
      projectBootstrap: undefined,
      agentMapIdentity: {
        ...source.agentMapIdentity!,
        sessionId: allocation.childSessionId,
      },
    };
    await writeFile(sessionsPath, JSON.stringify([source, foreign]));
    const { manager } = await make();
    await expect(
      manager.allocateDormant(source.id, allocation),
    ).rejects.toMatchObject({ code: "DORMANT_SESSION_ALLOCATION_MISMATCH" });
    expect(manager.get(foreign.id)).toEqual(foreign);
  });

  it.each([
    "principal",
    "root",
    "snapshot",
    "missing-identity",
    "missing-resolver",
  ])("rejects unavailable or changed %s without allocating", async (reason) => {
    const { manager, spawnPty } = await make(
      reason === "missing-resolver"
        ? { resolveAgentMapIdentity: undefined }
        : {},
    );
    if (reason === "principal") principal = "another-user";
    if (reason === "root") await catalog.reconcile([]);
    if (reason === "snapshot")
      allocation.expectedSource = {
        ...allocation.expectedSource,
        projectId: "foreign-project",
      };
    if (reason === "missing-identity")
      delete manager.get(source.id)!.agentMapIdentity;
    await expect(
      manager.allocateDormant(source.id, allocation),
    ).rejects.toBeInstanceOf(ProjectSessionScopeUnavailableError);
    expect(manager.get(allocation.childSessionId)).toBeUndefined();
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it.each(["child-end", "source-end", "shutdown"])(
    "does not publish after %s during authority validation",
    async (reason) => {
      const held = gate();
      const { manager } = await make({
        resolveAgentMapIdentity: async (sessionId, _cwd, persisted) => {
          await held.wait();
          return { ...persisted!, sessionId };
        },
      });
      const allocating = manager.allocateDormant(source.id, allocation);
      await held.entered;
      if (reason === "shutdown") manager.beginShutdown();
      else
        await manager.close(
          reason === "child-end" ? allocation.childSessionId : source.id,
        );
      held.release();
      await expect(allocating).rejects.toMatchObject({
        code:
          reason === "shutdown"
            ? "SESSION_MANAGER_CLOSING"
            : "SESSION_PREPARATION_CANCELLED",
      });
      expect(manager.get(allocation.childSessionId)).toBeUndefined();
    },
  );

  it("repairs a failed candidate write and lets only the same reserved operation retry after restart", async () => {
    let fail = true;
    const { manager } = await make({
      generateId: () => allocation.childSessionId,
      writeSessionRegistry: async (file, text) => {
        await writeFile(file, text);
        if (fail && text.includes(allocation.childSessionId)) {
          fail = false;
          throw new Error("lost registry acknowledgement");
        }
      },
    });
    await expect(
      manager.allocateDormant(source.id, allocation),
    ).rejects.toThrow("lost registry acknowledgement");
    expect(manager.get(allocation.childSessionId)).toBeUndefined();
    expect(JSON.parse(await readFile(sessionsPath, "utf8"))).toEqual([source]);
    await expect(
      manager.create({ cwd: source.cwd, harness: "claude-code" }),
    ).rejects.toMatchObject({ code: "DORMANT_SESSION_ALLOCATION_MISMATCH" });
    const { manager: restarted } = await make();
    expect((await restarted.allocateDormant(source.id, allocation)).id).toBe(
      allocation.childSessionId,
    );
  });

  it("revalidates after disk publication and releases its fence before repairing queued writes", async () => {
    const held = gate();
    const { manager } = await make({
      writeSessionRegistry: async (file, text) => {
        await writeFile(file, text);
        if (text.includes(allocation.childSessionId)) await held.wait();
      },
    });
    const allocating = manager.allocateDormant(source.id, allocation);
    await held.entered;
    expect(manager.get(allocation.childSessionId)).toBeUndefined();
    manager.setTitle(source.id, "Updated while waiting");
    principal = "another-user";
    held.release();
    await expect(allocating).rejects.toBeInstanceOf(
      ProjectSessionScopeUnavailableError,
    );
    await manager.flush();
    const persisted = JSON.parse(
      await readFile(sessionsPath, "utf8"),
    ) as HarnessSession[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.title).toBe("Updated while waiting");
  });

  it("fails closed on malformed private allocation proof", async () => {
    await writeFile(
      `${sessionsPath}.dormant-allocations.json`,
      JSON.stringify({ version: 1, allocations: { child: "bad-digest" } }),
    );
    await expect(make()).rejects.toMatchObject({
      code: "DORMANT_SESSION_ALLOCATION_MISMATCH",
    });
  });

  it("does not publish a child when private reservation persistence fails", async () => {
    const { manager } = await make();
    const proof = `${sessionsPath}.dormant-allocations.json`;
    await mkdir(proof);
    await expect(
      manager.allocateDormant(source.id, allocation),
    ).rejects.toThrow();
    expect(manager.get(allocation.childSessionId)).toBeUndefined();
    expect(JSON.parse(await readFile(sessionsPath, "utf8"))).toEqual([source]);
    await rm(proof, { recursive: true });
    expect((await manager.allocateDormant(source.id, allocation)).id).toBe(
      allocation.childSessionId,
    );
  });

  it.each(["source-session", "../foreign", ""])(
    "rejects invalid or non-distinct reserved ID %s",
    async (childSessionId) => {
      const { manager } = await make();
      await expect(
        manager.allocateDormant(source.id, { ...allocation, childSessionId }),
      ).rejects.toMatchObject({ code: "DORMANT_SESSION_ALLOCATION_MISMATCH" });
      expect(manager.list()).toEqual([source]);
    },
  );

  it("preserves normal Terminal creation", async () => {
    const { manager, spawnPty, hooks } = await make();
    const created = await manager.create({
      cwd: source.cwd,
      harness: "claude-code",
    });
    expect(created.status).toBe("running");
    expect(created.terminalState).toBeUndefined();
    expect(spawnPty).toHaveBeenCalledOnce();
    expect(hooks.buildLaunchOpts).toHaveBeenCalledOnce();
    expect(hooks.prepareProjectSession).toHaveBeenCalledOnce();
  });
});
