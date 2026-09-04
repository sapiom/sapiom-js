import { describe, expect, it, vi } from "vitest";

import type { AgentMapWorkspaceState } from "../shared/agent-map.js";
import type {
  CreateSessionRequest,
  HarnessSession,
  SessionRecord,
} from "../shared/types.js";
import type { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import {
  buildFocusedPlannerContext,
  buildFocusedProjectContext,
  isCurrentProjectRoot,
  isPlannerDispatchAuthorized,
  isProjectSessionDispatchAuthorized,
  isWithinCurrentProject,
  localPlanningPrincipal,
  localProjectPrincipal,
  PlanningSessionService,
  ProjectSessionService,
  type ProjectSessionLifecycleEvent,
} from "./planning-session.js";
import type { SessionManager } from "./session-manager.js";
import type {
  StudioProjectCatalog,
  StudioProjectIdentity,
} from "./studio-project-catalog.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const projectRoot = "/Users/private/customer-secret-project";

const project: StudioProjectIdentity = {
  projectId,
  identityVersion: 1,
  displayName: "Private research",
  rootBindings: [
    {
      id: "root_00000000-0000-4000-8000-000000000001",
      repositoryId: "repo-private",
      localRootRef: projectRoot,
      status: "active",
    },
  ],
  legacyWorkspaceKeys: ["private-workspace-key"],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const workspace: AgentMapWorkspaceState = {
  projectId,
  schemaVersion: 1,
  recordVersion: 1,
  confirmedRevisionId: null,
  activeProposalId: null,
  projectBuildPlanId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function session(
  id: string,
  overrides: Partial<HarnessSession> = {},
): HarnessSession {
  return {
    id,
    agentSessionId: null,
    harness: "codex",
    cwd: projectRoot,
    title: "Ordinary session",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActiveAt: "2026-09-01T00:00:00.000Z",
    exitCode: null,
    boundWorkflowPath: null,
    ready: false,
    agentMapIdentity: { projectId, sessionId: id, userId: "user-1" },
    ...overrides,
  };
}

interface FixtureOptions {
  existing?: HarnessSession[];
  initialProject?: StudioProjectIdentity | null;
  stampCreatedIdentity?: boolean;
  createImpl?: (
    request: CreateSessionRequest,
    createdId: string,
  ) => Promise<HarnessSession>;
  resumeImpl?: (id: string) => Promise<HarnessSession>;
}

function fixture(options: FixtureOptions = {}) {
  const existing = options.existing ?? [];
  const created: HarnessSession[] = [];
  let next = 0;
  let resolvedProject =
    options.initialProject === undefined ? project : options.initialProject;
  let currentUserId: string | null = "user-1";
  const lifecycleEvents: ProjectSessionLifecycleEvent[] = [];
  const legacyRegistration = vi.fn();
  const legacyEvents = vi.fn();
  const create = vi.fn(async (request: CreateSessionRequest) => {
    const id = `new-${++next}`;
    const value = options.createImpl
      ? await options.createImpl(request, id)
      : session(id, {
          cwd: request.cwd,
          harness: request.harness,
          ...(request.theme ? { theme: request.theme } : {}),
          ...(options.stampCreatedIdentity === false
            ? { agentMapIdentity: undefined }
            : {
                agentMapIdentity: {
                  projectId,
                  sessionId: id,
                  userId: localProjectPrincipal(currentUserId, "machine-1"),
                },
              }),
        });
    created.push(value);
    return value;
  });
  const resume = vi.fn(async (id: string) => {
    if (options.resumeImpl) return options.resumeImpl(id);
    const value = [...existing, ...created].find(
      (candidate) => candidate.id === id,
    );
    if (!value) throw new Error("missing session");
    value.status = "running";
    return value;
  });
  const kill = vi.fn(async () => true);
  const manager = {
    create,
    resume,
    list: () => [...existing, ...created],
    isLive: (id: string) =>
      [...existing, ...created].some(
        (candidate) => candidate.id === id && candidate.status !== "exited",
      ),
    get: (id: string) =>
      [...existing, ...created].find((candidate) => candidate.id === id),
    kill,
  } as unknown as SessionManager;
  const service = new ProjectSessionService({
    catalog: {
      resolveIdentity: async (id: string) =>
        id === projectId ? resolvedProject : null,
    } as unknown as StudioProjectCatalog,
    workspaceStore: {
      readOrCreate: async () => workspace,
    } as unknown as AgentMapWorkspaceStore,
    sessionManager: manager,
    readRecord: async () => null,
    userId: "user-1",
    currentUserId: () => currentUserId,
    machineId: "machine-1",
    defaultHarness: "codex",
    onPlannerSession: legacyRegistration,
    onEvent: legacyEvents,
    onProjectSessionEvent: (event) => {
      lifecycleEvents.push(event);
    },
  });
  return {
    service,
    create,
    resume,
    kill,
    created,
    lifecycleEvents,
    legacyRegistration,
    legacyEvents,
    setProject: (value: StudioProjectIdentity | null) => {
      resolvedProject = value;
    },
    setUserId: (value: string | null) => {
      currentUserId = value;
    },
  };
}

describe("neutral project-session compatibility exports", () => {
  it("keeps planner-named APIs as aliases of the neutral implementation", () => {
    expect(PlanningSessionService).toBe(ProjectSessionService);
    expect(localPlanningPrincipal).toBe(localProjectPrincipal);
    expect(isPlannerDispatchAuthorized).toBe(
      isProjectSessionDispatchAuthorized,
    );
    expect(isCurrentProjectRoot).toBe(isWithinCurrentProject);
    expect(buildFocusedPlannerContext).toBe(buildFocusedProjectContext);
  });

  it("uses the authenticated user or a stable machine-local principal", () => {
    expect(localProjectPrincipal("user-1", "machine-1")).toBe("user-1");
    expect(localProjectPrincipal(null, "machine-1")).toBe("local:machine-1");
  });
});

describe("project root containment", () => {
  it("accepts the root and descendants of every active binding", () => {
    const multiRoot: StudioProjectIdentity = {
      ...project,
      rootBindings: [
        ...project.rootBindings,
        {
          id: "root_00000000-0000-4000-8000-000000000002",
          repositoryId: "repo-secondary",
          localRootRef: "/Users/private/secondary",
          status: "active",
        },
      ],
    };

    expect(isWithinCurrentProject(multiRoot, projectRoot)).toBe(true);
    expect(
      isWithinCurrentProject(multiRoot, `${projectRoot}/agents/research`),
    ).toBe(true);
    expect(
      isWithinCurrentProject(multiRoot, "/Users/private/secondary/packages/a"),
    ).toBe(true);
  });

  it("rejects prefix siblings, parents, inactive roots, and mixed path families", () => {
    const withInactive: StudioProjectIdentity = {
      ...project,
      rootBindings: [
        ...project.rootBindings,
        {
          id: "root_00000000-0000-4000-8000-000000000003",
          repositoryId: null,
          localRootRef: "/Users/private/inactive",
          status: "missing",
        },
      ],
    };

    expect(isWithinCurrentProject(withInactive, `${projectRoot}-old`)).toBe(
      false,
    );
    expect(isWithinCurrentProject(withInactive, "/Users/private")).toBe(false);
    expect(
      isWithinCurrentProject(withInactive, "/Users/private/inactive/agent"),
    ).toBe(false);
    expect(
      isWithinCurrentProject(withInactive, "C:\\Users\\private\\project"),
    ).toBe(false);
  });

  it("normalizes Windows separators and compares on segment boundaries", () => {
    const windowsProject: StudioProjectIdentity = {
      ...project,
      rootBindings: [
        {
          ...project.rootBindings[0]!,
          localRootRef: "C:\\Users\\private\\project",
        },
      ],
    };

    expect(
      isWithinCurrentProject(
        windowsProject,
        "C:/Users/private/project/agents/research",
      ),
    ).toBe(true);
    expect(
      isWithinCurrentProject(windowsProject, "C:\\Users\\private\\project-old"),
    ).toBe(false);
  });
});

describe("role-neutral dispatch authorization", () => {
  it("authorizes only the exact neutral principal inside its current project", async () => {
    const ordinary = session("ordinary", {
      cwd: `${projectRoot}/packages/research`,
    });

    await expect(
      isProjectSessionDispatchAuthorized({
        session: ordinary,
        currentPrincipal: () => "user-1",
        resolveProject: async () => project,
      }),
    ).resolves.toBe(true);
    await expect(
      isProjectSessionDispatchAuthorized({
        session: ordinary,
        currentPrincipal: () => "user-2",
        resolveProject: async () => project,
      }),
    ).resolves.toBe(false);
    await expect(
      isProjectSessionDispatchAuthorized({
        session: session("foreign", {
          agentMapIdentity: {
            projectId: "project_foreign",
            sessionId: "foreign",
            userId: "user-1",
          },
        }),
        currentPrincipal: () => "user-1",
        resolveProject: async () => null,
      }),
    ).resolves.toBe(false);
  });

  it("does not authorize planner-era metadata without a neutral identity", async () => {
    const legacy = session("legacy", {
      agentMapIdentity: undefined,
      planning: {
        identity: {
          projectId,
          sessionId: "legacy",
          userId: "user-1",
          role: "map-planner",
        },
        greeting: { status: "pending" },
        queuedInputIds: [],
      },
    });

    await expect(
      isProjectSessionDispatchAuthorized({
        session: legacy,
        currentPrincipal: () => "user-1",
        resolveProject: async () => project,
      }),
    ).resolves.toBe(false);
  });

  it("rechecks principal and session identity after the project lookup await", async () => {
    let userId = "user-1";
    const ordinary = session("dispatch-race");
    let resolveProject!: (value: StudioProjectIdentity | null) => void;
    const authorization = isProjectSessionDispatchAuthorized({
      session: ordinary,
      currentPrincipal: () => userId,
      resolveProject: () =>
        new Promise((resolve) => {
          resolveProject = resolve;
        }),
    });

    await Promise.resolve();
    userId = "user-2";
    ordinary.agentMapIdentity = {
      projectId,
      sessionId: ordinary.id,
      userId: "user-2",
    };
    resolveProject(project);

    await expect(authorization).resolves.toBe(false);
  });
});

describe("focused project context compatibility projection", () => {
  it("is role-neutral, path-free, bounded, and ignores planner onboarding", () => {
    const context = buildFocusedProjectContext({
      project,
      workspace,
      sessionId: "session-1",
      userId: "user-1",
      onboardOnFirstResponse: true,
      details: {
        warnings: Array.from(
          { length: 40 },
          (_, index) => `warning-${index}-${"w".repeat(400)}`,
        ),
      },
    });
    const parsed = JSON.parse(context.split("\n")[2]!) as {
      identity: Record<string, string>;
      project: { warnings: string[] };
    };

    expect(parsed.identity).toEqual({
      projectId,
      sessionId: "session-1",
      userId: "user-1",
    });
    expect(parsed.project.warnings).toHaveLength(16);
    expect(parsed.project.warnings[0]!.length).toBeLessThanOrEqual(256);
    expect(context).not.toContain('"role"');
    expect(context).not.toContain("map-planner");
    expect(context).not.toContain("planning agent");
    expect(context).not.toContain("first response");
    expect(context).not.toContain(projectRoot);
    expect(context).not.toContain("private-workspace-key");
    expect(context).not.toContain("localRootRef");
    expect(context.length).toBeLessThan(16_384);
  });
});

describe("ProjectSessionService", () => {
  it("creates through the ordinary SessionManager path with no trusted override", async () => {
    const {
      service,
      create,
      lifecycleEvents,
      legacyRegistration,
      legacyEvents,
    } = fixture();

    const result = await service.open(projectId, {
      mode: "fresh",
      harness: "claude-code",
      theme: "dark",
    });

    expect(result).toMatchObject({
      resolution: "created",
      session: {
        id: "new-1",
        agentMapIdentity: {
          projectId,
          sessionId: "new-1",
          userId: "user-1",
        },
      },
    });
    expect(result.session.planning).toBeUndefined();
    expect(create).toHaveBeenCalledWith({
      cwd: projectRoot,
      harness: "claude-code",
      theme: "dark",
    });
    expect(create.mock.calls[0]).toHaveLength(1);
    expect(legacyRegistration).not.toHaveBeenCalled();
    expect(legacyEvents).not.toHaveBeenCalled();
    expect(lifecycleEvents).toEqual([
      {
        name: "project_session.created",
        projectId,
        sessionId: "new-1",
        resolution: "created",
      },
    ]);
  });

  it("uses the same deterministic outer launch root for the rolling alias", async () => {
    const innerRoot = `${projectRoot}/packages/app`;
    const { service, create } = fixture({
      initialProject: {
        ...project,
        rootBindings: [
          {
            id: "root_00000000-0000-4000-8000-000000000099",
            repositoryId: "repo-inner",
            localRootRef: innerRoot,
            status: "active",
          },
          ...project.rootBindings,
        ],
      },
    });

    await service.open(projectId, { mode: "fresh" });

    expect(create).toHaveBeenCalledWith({
      cwd: projectRoot,
      harness: "codex",
    });
  });

  it("fails closed without restamping and stops the exact unclaimed session it created", async () => {
    const { service, created, kill } = fixture({
      stampCreatedIdentity: false,
    });

    await expect(
      service.open(projectId, { mode: "fresh" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(created).toHaveLength(1);
    expect(created[0]!.agentMapIdentity).toBeUndefined();
    expect(created[0]!.planning).toBeUndefined();
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("new-1");
  });

  it("serializes concurrent resume-or-create calls without duplicate creation", async () => {
    const { service, create } = fixture();

    const [first, second] = await Promise.all([
      service.open(projectId, { mode: "resume-or-create" }),
      service.open(projectId, { mode: "resume-or-create" }),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ resolution: "created" });
    expect(second).toMatchObject({
      resolution: "live",
      session: { id: first.session.id },
    });
  });

  it("returns the most recently active live ordinary session, including a descendant cwd", async () => {
    const older = session("older", {
      cwd: `${projectRoot}/packages/older`,
      lastActiveAt: "2026-09-01T01:00:00.000Z",
    });
    const latest = session("latest", {
      cwd: `${projectRoot}/packages/latest`,
      lastActiveAt: "2026-09-01T02:00:00.000Z",
    });
    const { service, create, resume } = fixture({
      existing: [older, latest],
    });

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).resolves.toMatchObject({
      resolution: "live",
      session: { id: "latest" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("never adopts or restamps a cwd-only manual or planner-era session", async () => {
    const manual = session("manual", { agentMapIdentity: undefined });
    const legacy = session("legacy", {
      agentMapIdentity: undefined,
      planning: {
        identity: {
          projectId,
          sessionId: "legacy",
          userId: "user-1",
          role: "map-planner",
        },
        greeting: { status: "delivered", messageId: "message-1" },
        queuedInputIds: [],
      },
    });
    const before = structuredClone([manual, legacy]);
    const { service, create, resume, kill } = fixture({
      existing: [manual, legacy],
    });

    const result = await service.open(projectId, {
      mode: "resume-or-create",
    });

    expect(result).toMatchObject({ resolution: "created" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect([manual, legacy]).toEqual(before);
  });

  it("resumes an exited session under the same harness ID without trusted metadata or rehydration", async () => {
    const prior = session("resume-me", {
      status: "exited",
      agentSessionId: "provider-session",
      cwd: `${projectRoot}/packages/research`,
      title: "User title",
      boundWorkflowPath: `${projectRoot}/agents/research`,
      rehydratedFrom: "older-session",
    });
    const { service, create, resume, kill } = fixture({ existing: [prior] });

    const result = await service.open(projectId, {
      mode: "resume-or-create",
    });

    expect(result).toEqual({ session: prior, resolution: "resumed" });
    expect(result.session).toMatchObject({
      id: "resume-me",
      agentSessionId: "provider-session",
      cwd: `${projectRoot}/packages/research`,
      title: "User title",
      boundWorkflowPath: `${projectRoot}/agents/research`,
      rehydratedFrom: "older-session",
    });
    expect(resume).toHaveBeenCalledWith("resume-me");
    expect(resume.mock.calls[0]).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("surfaces resume failure without creating a copied session", async () => {
    const prior = session("not-resumable", {
      status: "exited",
      agentSessionId: "provider-session",
    });
    const failure = new Error("provider cannot resume exact session");
    const { service, create, resume, kill } = fixture({
      existing: [prior],
      resumeImpl: async () => {
        throw failure;
      },
    });

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).rejects.toBe(failure);
    expect(resume).toHaveBeenCalledWith(prior.id);
    expect(create).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("deduplicates repeated projections of the same persisted session ID", async () => {
    const first = session("duplicate", {
      status: "exited",
      agentSessionId: "provider-session",
    });
    const repeated = structuredClone(first);
    const failure = new Error("not resumable");
    const { service, resume, create } = fixture({
      existing: [first, repeated],
      resumeImpl: async () => {
        throw failure;
      },
    });

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).rejects.toBe(failure);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a resume adapter returning a different harness ID without killing either session", async () => {
    const prior = session("expected", {
      status: "exited",
      agentSessionId: "provider-session",
    });
    const replacement = session("replacement");
    const { service, create, kill } = fixture({
      existing: [prior],
      resumeImpl: async () => replacement,
    });

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(create).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("revalidates scope after resume, stops that exact process, and never starts a second candidate", async () => {
    const newest = session("newest", {
      status: "exited",
      agentSessionId: "provider-newest",
      lastActiveAt: "2026-09-01T02:00:00.000Z",
    });
    const older = session("older", {
      status: "exited",
      agentSessionId: "provider-older",
      lastActiveAt: "2026-09-01T01:00:00.000Z",
    });
    const setup = fixture({
      existing: [older, newest],
      resumeImpl: async (id) => {
        setup.setProject({
          ...project,
          rootBindings: project.rootBindings.map((binding) => ({
            ...binding,
            localRootRef: "/Users/private/moved-during-resume",
          })),
        });
        const resumed = id === newest.id ? newest : older;
        resumed.status = "running";
        return resumed;
      },
    });

    await expect(
      setup.service.open(projectId, { mode: "resume-or-create" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(setup.resume).toHaveBeenCalledTimes(1);
    expect(setup.resume).toHaveBeenCalledWith(newest.id);
    expect(setup.create).not.toHaveBeenCalled();
    expect(setup.kill).toHaveBeenCalledOnce();
    expect(setup.kill).toHaveBeenCalledWith(newest.id);
  });

  it("stops the exact resumed process when the trusted principal changes during resume", async () => {
    const prior = session("prior", {
      status: "exited",
      agentSessionId: "provider-prior",
    });
    const setup = fixture({
      existing: [prior],
      resumeImpl: async () => {
        prior.status = "running";
        setup.setUserId("user-2");
        return prior;
      },
    });

    await expect(
      setup.service.open(projectId, { mode: "resume-or-create" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(setup.resume).toHaveBeenCalledOnce();
    expect(setup.kill).toHaveBeenCalledOnce();
    expect(setup.kill).toHaveBeenCalledWith(prior.id);
    expect(setup.create).not.toHaveBeenCalled();
  });

  it("does not copy a project-owned session whose cwd is outside current bindings", async () => {
    const stale = session("stale-root", {
      cwd: "/Users/private/old-project-root",
      status: "exited",
      agentSessionId: "provider-session",
    });
    const { service, create, resume, kill } = fixture({ existing: [stale] });

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("re-resolves current scope for every requireOwned call", async () => {
    const owned = session("owned", { cwd: `${projectRoot}/packages/a` });
    const { service, setProject } = fixture({ existing: [owned] });

    await expect(service.requireOwned(projectId, owned.id)).resolves.toBe(
      owned,
    );
    setProject({
      ...project,
      rootBindings: project.rootBindings.map((binding) => ({
        ...binding,
        localRootRef: "/Users/private/moved-project",
      })),
    });
    await expect(
      service.requireOwned(projectId, owned.id),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects malformed, foreign-project, and foreign-user principals", async () => {
    const malformed = session("malformed", {
      agentMapIdentity: {
        projectId,
        sessionId: "different-id",
        userId: "user-1",
      },
    });
    const foreignProject = session("foreign-project", {
      agentMapIdentity: {
        projectId: "project_foreign",
        sessionId: "foreign-project",
        userId: "user-1",
      },
    });
    const foreignUser = session("foreign-user", {
      agentMapIdentity: {
        projectId,
        sessionId: "foreign-user",
        userId: "user-2",
      },
    });
    const { service } = fixture({
      existing: [malformed, foreignProject, foreignUser],
    });

    await expect(
      service.requireOwned(projectId, malformed.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.requireOwned(projectId, foreignProject.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.requireOwned(projectId, foreignUser.id),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revalidates the principal after an awaited create and stops only that stale-principal session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let harnessSession!: HarnessSession;
    const setup = fixture({
      createImpl: async (request, id) => {
        await gate;
        harnessSession = session(id, {
          cwd: request.cwd,
          agentMapIdentity: {
            projectId,
            sessionId: id,
            userId: "user-1",
          },
        });
        return harnessSession;
      },
    });
    const opening = setup.service.open(projectId, { mode: "fresh" });

    await vi.waitFor(() => expect(setup.create).toHaveBeenCalledTimes(1));
    setup.setUserId("user-2");
    release();

    await expect(opening).rejects.toMatchObject({ code: "forbidden" });
    expect(harnessSession.agentMapIdentity?.userId).toBe("user-1");
    expect(setup.kill).toHaveBeenCalledOnce();
    expect(setup.kill).toHaveBeenCalledWith(harnessSession.id);
  });

  it("revalidates identity and project bindings after awaited creation and stops the created session", async () => {
    const setup = fixture({
      createImpl: async (request, id) => {
        setup.setProject({
          ...project,
          rootBindings: project.rootBindings.map((binding) => ({
            ...binding,
            localRootRef: "/Users/private/moved-during-create",
          })),
        });
        return session(id, { cwd: request.cwd });
      },
    });

    await expect(
      setup.service.open(projectId, { mode: "fresh" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(setup.created).toHaveLength(1);
    expect(setup.kill).toHaveBeenCalledOnce();
    expect(setup.kill).toHaveBeenCalledWith(setup.created[0]!.id);
  });

  it("fails with bounded errors for missing projects, roots, and sessions", async () => {
    const missingProject = fixture({ initialProject: null });
    await expect(
      missingProject.service.open(projectId, { mode: "fresh" }),
    ).rejects.toMatchObject({ code: "project_not_found" });

    const missingRoot = fixture({
      initialProject: {
        ...project,
        rootBindings: project.rootBindings.map((binding) => ({
          ...binding,
          status: "missing",
        })),
      },
    });
    await expect(
      missingRoot.service.open(projectId, { mode: "fresh" }),
    ).rejects.toMatchObject({ code: "project_launch_unavailable" });

    const ordinary = fixture();
    await expect(
      ordinary.service.requireOwned(projectId, "missing"),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("retains the deprecated constructor/API shape without reading legacy stores", async () => {
    const readRecord = vi.fn(async () => null as SessionRecord | null);
    const readWorkspace = vi.fn(async () => workspace);
    const manager = {
      create: vi.fn(async (request: CreateSessionRequest) =>
        session("created", { cwd: request.cwd }),
      ),
      resume: vi.fn(),
      list: () => [],
      isLive: () => false,
      get: () => undefined,
    } as unknown as SessionManager;
    const legacy = new PlanningSessionService({
      catalog: {
        resolveIdentity: async () => project,
      } as unknown as StudioProjectCatalog,
      workspaceStore: {
        readOrCreate: readWorkspace,
      } as unknown as AgentMapWorkspaceStore,
      sessionManager: manager,
      readRecord,
      userId: "user-1",
      machineId: "machine-1",
      defaultHarness: "codex",
    });

    await expect(
      legacy.open(projectId, { mode: "fresh" }),
    ).resolves.toMatchObject({ resolution: "created" });
    expect(readRecord).not.toHaveBeenCalled();
    expect(readWorkspace).not.toHaveBeenCalled();
  });
});
