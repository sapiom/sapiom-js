import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AGENT_MAP_PLANNER_SESSION_START_MESSAGE } from "../profiles/agent-map-planner.js";
import type { AgentMapWorkspaceState } from "../shared/agent-map.js";
import type { HarnessSession, SessionRecord } from "../shared/types.js";
import type { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import {
  buildFocusedPlannerContext,
  isPlannerDispatchAuthorized,
  localPlanningPrincipal,
  PlanningSessionError,
  PlanningSessionService,
} from "./planning-session.js";
import type { SessionManager } from "./session-manager.js";
import { PlannerGreetingCoordinator } from "./planner-greeting.js";
import type {
  StudioProjectCatalog,
  StudioProjectIdentity,
} from "./studio-project-catalog.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";

const project: StudioProjectIdentity = {
  projectId,
  identityVersion: 1,
  displayName: "Private research",
  rootBindings: [
    {
      id: "root_00000000-0000-4000-8000-000000000001",
      repositoryId: "repo-private",
      localRootRef: "/Users/private/customer-secret-project",
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
    cwd: project.rootBindings[0]!.localRootRef,
    title: "Private research",
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActiveAt: "2026-09-01T00:00:00.000Z",
    exitCode: null,
    boundWorkflowPath: null,
    ready: false,
    planning: {
      identity: {
        projectId,
        sessionId: id,
        userId: "user-1",
        role: "map-planner",
      },
      greeting: { status: "pending" },
      queuedInputIds: [],
    },
    ...overrides,
  };
}

function fixture(
  existing: HarnessSession[] = [],
  initialProject: StudioProjectIdentity = project,
  initialWorkspace: AgentMapWorkspaceState = workspace,
) {
  let next = 0;
  let resolvedProject = initialProject;
  let currentUserId: string | null = "user-1";
  const contexts: string[] = [];
  const sessionStartMessages: Array<string | null> = [];
  const created: HarnessSession[] = [];
  const create = vi.fn(async (request, trusted) => {
    const id = `new-${++next}`;
    contexts.push(trusted.promptAppendix(id));
    sessionStartMessages.push(trusted.sessionStartSystemMessage?.(id) ?? null);
    const value = session(id, {
      harness: request.harness,
      cwd: request.cwd,
      planning: trusted.planning(id),
      rehydratedFrom:
        trusted.handoffFromSessionId ?? request.rehydrateFrom ?? null,
    });
    created.push(value);
    return value;
  });
  const resume = vi.fn(async (id, trusted) => {
    const value = existing.find((candidate) => candidate.id === id)!;
    value.planning = structuredClone(trusted.planning);
    contexts.push(trusted.promptAppendix);
    return value;
  });
  const kill = vi.fn(async (id: string) => {
    const value = [...existing, ...created].find(
      (candidate) => candidate.id === id,
    );
    if (value) value.status = "exited";
    return Boolean(value);
  });
  const manager = {
    create,
    resume,
    list: () => [...existing, ...created],
    isLive: (id: string) =>
      [...existing, ...created].some(
        (candidate) => candidate.id === id && candidate.status === "running",
      ),
    get: (id: string) =>
      [...existing, ...created].find((candidate) => candidate.id === id),
    setPlanningMetadata: async (
      id: string,
      metadata: NonNullable<HarnessSession["planning"]>,
    ) => {
      const value = [...existing, ...created].find(
        (candidate) => candidate.id === id,
      );
      if (value) value.planning = structuredClone(metadata);
    },
    submitInput: vi.fn(async () => true),
    kill,
  } as unknown as SessionManager;
  const service = new PlanningSessionService({
    catalog: {
      resolveIdentity: async (id: string) =>
        id === projectId ? resolvedProject : null,
    } as unknown as StudioProjectCatalog,
    workspaceStore: {
      readOrCreate: async () => initialWorkspace,
    } as unknown as AgentMapWorkspaceStore,
    sessionManager: manager,
    readRecord: async () => null,
    userId: "user-1",
    currentUserId: () => currentUserId,
    machineId: "machine-1",
    defaultHarness: "codex",
  });
  return {
    service,
    create,
    resume,
    kill,
    contexts,
    sessionStartMessages,
    manager,
    created,
    setProject: (value: StudioProjectIdentity) => {
      resolvedProject = value;
    },
    setUserId: (value: string | null) => {
      currentUserId = value;
    },
  };
}

describe("planner session context and identity", () => {
  it("uses the authenticated user or a stable machine-local principal", () => {
    expect(localPlanningPrincipal("user-1", "machine-1")).toBe("user-1");
    expect(localPlanningPrincipal(null, "machine-1")).toBe("local:machine-1");
  });

  it("serializes only allowlisted focused context and never a local path", () => {
    const context = buildFocusedPlannerContext({
      project,
      workspace,
      sessionId: "session-1",
      userId: "user-1",
      onboardOnFirstResponse: true,
    });
    expect(context).toContain(projectId);
    expect(context).toContain(project.rootBindings[0]!.id);
    expect(context).toContain('"role":"map-planner"');
    expect(context).toContain('"empty":true');
    expect(context).toContain('"status":"not_created"');
    expect(context).toContain("build_plan_rebase");
    expect(context).toContain("fresh request ID");
    expect(context).toContain("In your first response, briefly explain");
    expect(context).not.toContain("/Users/private");
    expect(context).not.toContain("private-workspace-key");
    expect(context).not.toContain("localRootRef");
    expect(context).not.toContain("prompt");
    expect(context.length).toBeLessThan(16_384);
  });

  it("bounds revision summaries, proposal/build status, and warnings", () => {
    const populated: AgentMapWorkspaceState = {
      ...workspace,
      confirmedRevisionId: "revision-1",
      activeProposalId: "proposal-1",
      projectBuildPlanId: "build-plan-1",
    };
    const context = buildFocusedPlannerContext({
      project,
      workspace: populated,
      sessionId: "session-1",
      userId: "user-1",
      onboardOnFirstResponse: false,
      details: {
        architectureSource: {
          kind: "proposal",
          proposalId: "proposal_00000000-0000-7000-8000-000000000005",
          version: 3,
          graphDigest: `sha256:${"a".repeat(64)}`,
        } as never,
        confirmedRevision: {
          digest: "d".repeat(2_000),
          summaries: Array.from(
            { length: 80 },
            (_, index) => `node-${index}-${"s".repeat(400)}`,
          ),
        },
        activeProposal: { status: "draft", summary: "proposal summary" },
        projectBuildPlan: {
          status: "incomplete",
          summary: "build summary",
          version: 7,
          digest: "sha256:plan",
          source: { kind: "proposal", version: 3, graphDigest: "sha256:graph" },
          planningEligible: true,
          implementationEligible: false,
          assignmentCount: 5,
          briefCount: 4,
          staleBriefCount: 1,
          diagnostics: Array.from({ length: 20 }, (_, index) => ({
            code: `diagnostic-${index}`,
            severity: "warning",
            path: `assignments[${index}]`,
          })),
        },
        warnings: Array.from({ length: 40 }, (_, index) => `warning-${index}`),
      },
    });
    const parsed = JSON.parse(context.split("\n")[2]!) as {
      project: {
        architectureSource: {
          kind: string;
          proposalId: string;
          version: number;
          graphDigest: string;
        };
        confirmedRevision: { digest: string; summaries: string[] };
        activeProposal: { status: string };
        projectBuildPlan: {
          status: string;
          version: number;
          assignmentCount: number;
          diagnostics: unknown[];
        };
        warnings: string[];
      };
    };

    expect(parsed.project.confirmedRevision.digest).toHaveLength(512);
    expect(parsed.project.architectureSource).toMatchObject({
      kind: "proposal",
      proposalId: "proposal_00000000-0000-7000-8000-000000000005",
      version: 3,
      graphDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(parsed.project.confirmedRevision.summaries).toHaveLength(32);
    expect(
      parsed.project.confirmedRevision.summaries[0]!.length,
    ).toBeLessThanOrEqual(256);
    expect(parsed.project.activeProposal.status).toBe("draft");
    expect(parsed.project.projectBuildPlan).toMatchObject({
      status: "incomplete",
      version: 7,
      assignmentCount: 5,
    });
    expect(parsed.project.projectBuildPlan.diagnostics).toHaveLength(8);
    expect(parsed.project.warnings).toHaveLength(16);
    expect(context.length).toBeLessThan(16_384);
    expect(context).not.toContain(project.rootBindings[0]!.localRootRef);
  });

  it("represents a planless confirmed revision as explicitly unavailable", () => {
    const context = buildFocusedPlannerContext({
      project,
      workspace: {
        ...workspace,
        confirmedRevisionId:
          "revision_00000000-0000-7000-8000-000000000006",
      },
      sessionId: "session-1",
      userId: "user-1",
      onboardOnFirstResponse: false,
      details: {
        architectureSource: {
          status: "revision_source_unavailable",
          kind: "revision",
          revisionId: "revision_00000000-0000-7000-8000-000000000006",
        },
      },
    });
    expect(context).toContain('"status":"revision_source_unavailable"');
    expect(context).toContain(
      '"revisionId":"revision_00000000-0000-7000-8000-000000000006"',
    );
    expect(context).not.toContain('"architectureSource":null');
  });

  it("rechecks the live principal after an awaited dispatch binding lookup", async () => {
    let userId = "user-1";
    let resolveProject!: (value: StudioProjectIdentity | null) => void;
    const authorization = isPlannerDispatchAuthorized({
      session: session("planner-dispatch"),
      currentPrincipal: () => userId,
      resolveProject: () =>
        new Promise((resolve) => {
          resolveProject = resolve;
        }),
    });

    await Promise.resolve();
    userId = "user-b";
    resolveProject(project);

    await expect(authorization).resolves.toBe(false);
  });
});

describe("PlanningSessionService", () => {
  it("always creates a new, server-scoped planner for explicit fresh", async () => {
    const { service, create, contexts, sessionStartMessages } = fixture();
    const first = await service.open(projectId, { mode: "fresh" });
    const second = await service.open(projectId, { mode: "fresh" });

    expect(first.resolution).toBe("created");
    expect(second.session.id).not.toBe(first.session.id);
    expect(create).toHaveBeenCalledTimes(2);
    expect(first.session.planning).toEqual({
      identity: {
        projectId,
        sessionId: first.session.id,
        userId: "user-1",
        role: "map-planner",
      },
      greeting: { status: "skipped", reason: "user-proceeded" },
      queuedInputIds: [],
    });
    expect(
      contexts.every(
        (value) => !value.includes(project.rootBindings[0]!.localRootRef),
      ),
    ).toBe(true);
    expect(contexts).toEqual([
      expect.stringContaining(
        "Let the user's first real message be the first visible conversation turn",
      ),
      expect.stringContaining(
        "Let the user's first real message be the first visible conversation turn",
      ),
    ]);
    expect(contexts.join("\n")).not.toContain(
      "This is a private Agent Studio control turn",
    );
    expect(sessionStartMessages).toEqual([null, null]);
  });

  it("uses native Claude startup orientation without repeating it in turn one", async () => {
    const { service, contexts, sessionStartMessages } = fixture();

    await service.open(projectId, {
      mode: "fresh",
      harness: "claude-code",
    });

    expect(sessionStartMessages).toEqual([
      AGENT_MAP_PLANNER_SESSION_START_MESSAGE,
    ]);
    expect(contexts[0]).not.toContain(
      "In your first response, briefly explain",
    );
  });

  it("does not replay first-time onboarding for an already-planned project", async () => {
    const { service, contexts } = fixture([], project, {
      ...workspace,
      confirmedRevisionId: "revision-1",
    });

    await service.open(projectId, { mode: "fresh" });

    expect(contexts[0]).not.toContain(
      "In your first response, briefly explain",
    );
  });

  it("serializes concurrent resume-or-create so both callers resolve one planner", async () => {
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

  it("keeps the latest live owned session and rejects cross-project replay", async () => {
    const older = session("older", {
      lastActiveAt: "2026-09-01T01:00:00.000Z",
    });
    const latest = session("latest", {
      lastActiveAt: "2026-09-01T02:00:00.000Z",
    });
    const { service, create } = fixture([older, latest]);

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).resolves.toMatchObject({ resolution: "live", session: { id: "latest" } });
    expect(create).not.toHaveBeenCalled();
    await expect(
      service.requireOwned("other-project", latest.id),
    ).rejects.toThrow(PlanningSessionError);
  });

  it("accepts a planner on any current active root, not only the launch root", async () => {
    const multiRoot: StudioProjectIdentity = {
      ...project,
      rootBindings: [
        ...project.rootBindings,
        {
          id: "root_00000000-0000-4000-8000-000000000002",
          repositoryId: "repo-secondary",
          localRootRef: "/Users/private/secondary-root",
          status: "active",
        },
      ],
    };
    const secondary = session("secondary", {
      cwd: "/Users/private/secondary-root",
    });
    const { service, create } = fixture([secondary], multiRoot);

    await expect(
      service.open(projectId, { mode: "resume-or-create" }),
    ).resolves.toMatchObject({
      resolution: "live",
      session: { id: secondary.id },
    });
    await expect(service.requireOwned(projectId, secondary.id)).resolves.toBe(
      secondary,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("never returns or resumes a stale-root candidate after a move and rehydrates at the current root", async () => {
    const moved: StudioProjectIdentity = {
      ...project,
      rootBindings: project.rootBindings.map((binding) => ({
        ...binding,
        localRootRef: "/Users/private/moved-project",
      })),
    };
    const stale = session("stale-root", {
      cwd: project.rootBindings[0]!.localRootRef,
      status: "running",
      agentSessionId: "old-vendor",
    });
    const { service, resume, create } = fixture([stale], moved);
    (
      service as unknown as {
        options: { readRecord: () => Promise<SessionRecord> };
      }
    ).options.readRecord = async () => ({ turnCount: 1 }) as SessionRecord;

    const result = await service.open(projectId, {
      mode: "resume-or-create",
    });

    expect(result.resolution).toBe("rehydrated");
    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/Users/private/moved-project",
        rehydrateFrom: stale.id,
      }),
      expect.any(Object),
    );
  });

  it("re-resolves current bindings for every scoped operation", async () => {
    const owned = session("owned-root");
    const { service, setProject } = fixture([owned]);
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
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("isolates planners across authenticated, local, and replacement principals", async () => {
    const accountA = session("account-a");
    const { service, setUserId } = fixture([accountA]);
    await expect(service.requireOwned(projectId, accountA.id)).resolves.toBe(
      accountA,
    );

    setUserId(null);
    await expect(
      service.requireOwned(projectId, accountA.id),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    const local = await service.open(projectId, { mode: "fresh" });
    expect(local.session.planning?.identity.userId).toBe("local:machine-1");

    setUserId("user-b");
    await expect(
      service.requireOwned(projectId, local.session.id),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    const accountB = await service.open(projectId, { mode: "fresh" });
    expect(accountB.session.planning?.identity.userId).toBe("user-b");
  });

  it("kills a newly created planner if principal or binding changes mid-open", async () => {
    const principalSwitch = fixture();
    (
      principalSwitch.service as unknown as {
        options: { onPlannerSession: () => void };
      }
    ).options.onPlannerSession = () => principalSwitch.setUserId(null);
    await expect(
      principalSwitch.service.open(projectId, { mode: "fresh" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(principalSwitch.kill).toHaveBeenCalledWith("new-1");

    const bindingSwitch = fixture();
    (
      bindingSwitch.service as unknown as {
        options: { onPlannerSession: () => void };
      }
    ).options.onPlannerSession = () =>
      bindingSwitch.setProject({
        ...project,
        rootBindings: project.rootBindings.map((binding) => ({
          ...binding,
          localRootRef: "/Users/private/moved-during-open",
        })),
      });
    await expect(
      bindingSwitch.service.open(projectId, { mode: "fresh" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bindingSwitch.kill).toHaveBeenCalledWith("new-1");
  });

  it("reattaches focused context and suppresses onboarding on vendor resume", async () => {
    const prior = session("resume-me", {
      status: "exited",
      agentSessionId: "vendor-session",
    });
    const { service, resume, contexts } = fixture([prior]);

    const result = await service.open(projectId, { mode: "resume-or-create" });

    expect(result.resolution).toBe("resumed");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.session.planning?.greeting).toEqual({
      status: "skipped",
      reason: "user-proceeded",
    });
    expect(contexts[0]).toContain(projectId);
    expect(contexts[0]).toContain("build_plan_rebase");
    expect(contexts[0]).toContain('"status":"not_created"');
    expect(contexts[0]).not.toContain(
      "In your first response, briefly explain",
    );
    expect(contexts[0]).not.toContain(project.rootBindings[0]!.localRootRef);
  });

  it("rehydrates recorded history when vendor resume is unavailable", async () => {
    const prior = session("recorded", {
      status: "exited",
      agentSessionId: "stale-vendor-session",
    });
    const { service, resume, create, contexts, sessionStartMessages } = fixture(
      [prior],
    );
    resume.mockRejectedValueOnce(new Error("not resumable"));
    (
      service as unknown as {
        options: { readRecord: () => Promise<SessionRecord> };
      }
    ).options.readRecord = async () => ({ turnCount: 1 }) as SessionRecord;

    const result = await service.open(projectId, { mode: "resume-or-create" });

    expect(result.resolution).toBe("rehydrated");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ rehydrateFrom: prior.id }),
      expect.any(Object),
    );
    expect(result.session.planning?.greeting.status).toBe("skipped");
    expect(contexts[0]).not.toContain(
      "In your first response, briefly explain",
    );
    expect(sessionStartMessages).toEqual([null]);
  });

  it("hands a restarted pre-ready FIFO to a rehydrated planner exactly once and retires the old queue", async () => {
    const prior = session("queued-predecessor", {
      status: "exited",
      ready: false,
      agentSessionId: "missing-vendor-history",
    });
    const { service, resume, manager } = fixture([prior]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "planner-handoff-"));
    const beforeRestart = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    await beforeRestart.register(prior, {
      emptyProject: true,
      mode: "created",
    });
    await beforeRestart.enqueue(prior.id, "queued before readiness");

    // New coordinator instance is the process-restart boundary. Vendor resume
    // fails, so PlanningSessionService creates a replacement with
    // rehydratedFrom=prior.id and registration performs the durable handoff.
    const afterRestart = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    resume.mockRejectedValueOnce(new Error("vendor history unavailable"));
    const options = (
      service as unknown as {
        options: {
          readRecord: () => Promise<SessionRecord>;
          onPlannerSession: PlanningSessionService["options"]["onPlannerSession"];
        };
      }
    ).options;
    options.readRecord = async () => ({ turnCount: 1 }) as SessionRecord;
    options.onPlannerSession = (value, context) =>
      afterRestart.register(value, context);

    try {
      const result = await service.open(projectId, {
        mode: "resume-or-create",
      });
      expect(result.resolution).toBe("rehydrated");
      result.session.ready = true;
      await afterRestart.onSessionStatus(result.session);

      expect(manager.submitInput).toHaveBeenCalledTimes(1);
      expect(manager.submitInput).toHaveBeenCalledWith(
        result.session.id,
        "queued before readiness",
        true,
        expect.any(Function),
      );
      const replacementQueue = JSON.parse(
        await fs.readFile(
          path.join(root, result.session.id, "input-queue.json"),
          "utf8",
        ),
      ) as { inputs: unknown[] };
      await expect(
        fs.access(path.join(root, prior.id, "input-queue.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(replacementQueue.inputs).toEqual([]);

      // A full later boot registers the historical predecessor first, which
      // recreates its empty queue file. Registering the successor must detect
      // its already-committed target directory and never rename the recreated
      // source over it.
      const secondBoot = new PlannerGreetingCoordinator({
        root,
        sessionManager: manager,
        deliveryTimeoutMs: 60_000,
      });
      await secondBoot.register(prior, { emptyProject: true, mode: "boot" });
      await expect(
        secondBoot.register(result.session, {
          emptyProject: true,
          mode: "boot",
        }),
      ).resolves.toBeUndefined();
      await secondBoot.onSessionStatus(result.session);
      expect(manager.submitInput).toHaveBeenCalledTimes(1);
      const durableAfterSecondBoot = JSON.parse(
        await fs.readFile(
          path.join(root, result.session.id, "input-queue.json"),
          "utf8",
        ),
      ) as { inputs: unknown[] };
      expect(durableAfterSecondBoot.inputs).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["atomic-move", "canonical-rewrite"] as const)(
    "keeps exactly one FIFO successor when the %s boundary fails",
    async (failurePoint) => {
      const prior = session("handoff-fault-source", {
        status: "exited",
        ready: false,
        agentSessionId: "missing-vendor-history",
      });
      const { service, resume, manager } = fixture([prior]);
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "planner-handoff-fault-"),
      );
      const seed = new PlannerGreetingCoordinator({
        root,
        sessionManager: manager,
        deliveryTimeoutMs: 60_000,
      });
      await seed.register(prior, { emptyProject: true, mode: "created" });
      await seed.enqueue(prior.id, "survive handoff fault");

      let rejectMove = failurePoint === "atomic-move";
      const firstSuccessor = new PlannerGreetingCoordinator({
        root,
        sessionManager: manager,
        deliveryTimeoutMs: 60_000,
        moveStateDirectory: async (source, target) => {
          if (rejectMove) {
            rejectMove = false;
            throw new Error("injected atomic handoff failure");
          }
          await fs.rename(source, target);
        },
        ...(failurePoint === "canonical-rewrite"
          ? {
              writeState: async (file: string, value: unknown) => {
                if (file.includes(`${path.sep}new-1${path.sep}`)) {
                  throw new Error("injected canonical rewrite failure");
                }
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
              },
            }
          : {}),
      });
      resume.mockRejectedValue(new Error("vendor history unavailable"));
      const options = (
        service as unknown as {
          options: {
            readRecord: (id: string) => Promise<SessionRecord | null>;
            onPlannerSession: PlanningSessionService["options"]["onPlannerSession"];
          };
        }
      ).options;
      options.readRecord = async (id) =>
        id === prior.id ? ({ turnCount: 1 } as SessionRecord) : null;
      options.onPlannerSession = (value, context) =>
        firstSuccessor.register(value, context);

      try {
        if (failurePoint === "atomic-move") {
          await expect(
            service.open(projectId, { mode: "resume-or-create" }),
          ).rejects.toThrow("injected atomic handoff failure");
        } else {
          const first = await service.open(projectId, {
            mode: "resume-or-create",
          });
          // Exit before readiness. A same-process reopen must follow this exact
          // queue-owning successor, even though its canonical rewrite failed.
          await manager.kill(first.session.id);
        }

        const finalCoordinator = new PlannerGreetingCoordinator({
          root,
          sessionManager: manager,
          deliveryTimeoutMs: 60_000,
        });
        options.onPlannerSession = (value, context) =>
          finalCoordinator.register(value, context);
        const result = await service.open(projectId, {
          mode: "resume-or-create",
        });
        expect(result).toMatchObject({
          resolution: "rehydrated",
          session: {
            id: "new-2",
            rehydratedFrom:
              failurePoint === "canonical-rewrite" ? "new-1" : prior.id,
          },
        });
        expect(result.session.planning?.queuedInputIds).toHaveLength(1);
        result.session.ready = true;
        await finalCoordinator.onSessionStatus(result.session);

        expect(manager.submitInput).toHaveBeenCalledTimes(1);
        expect(manager.submitInput).toHaveBeenCalledWith(
          result.session.id,
          "survive handoff fault",
          true,
          expect.any(Function),
        );
        await expect(
          fs.access(path.join(root, prior.id, "input-queue.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          fs.access(path.join(root, "new-1", "input-queue.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const durable = JSON.parse(
          await fs.readFile(
            path.join(root, result.session.id, "input-queue.json"),
            "utf8",
          ),
        ) as { inputs: unknown[] };
        expect(durable.inputs).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rehydrates a delivered greeting-only record without generating a duplicate", async () => {
    const prior = session("greeting-only", {
      status: "exited",
      agentSessionId: "missing-vendor-history",
    });
    prior.planning!.greeting = {
      status: "delivered",
      messageId: "greeting-message",
    };
    const { service, resume, manager } = fixture([prior]);
    resume.mockRejectedValueOnce(new Error("vendor history unavailable"));
    const record: SessionRecord = {
      harnessSessionId: prior.id,
      mergedSessionIds: [prior.id],
      agentSessionId: prior.agentSessionId,
      harness: prior.harness,
      cwd: null,
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:01:00.000Z",
      turns: [
        {
          index: 1,
          prompt: null,
          promptAt: null,
          toolCalls: [],
          assistantText: "What system should we plan together?",
          model: null,
          usage: null,
          completedAt: "2026-09-01T00:00:30.000Z",
          incomplete: false,
        },
      ],
      turnCount: 0,
      eventCount: 2,
      reconstructed: true,
      archivedAt: null,
      limitations: [],
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "planner-wired-"));
    const coordinator = new PlannerGreetingCoordinator({
      root,
      sessionManager: manager,
      deliveryTimeoutMs: 60_000,
    });
    const options = (
      service as unknown as {
        options: {
          readRecord: () => Promise<SessionRecord>;
          onPlannerSession: PlanningSessionService["options"]["onPlannerSession"];
        };
      }
    ).options;
    options.readRecord = async () => record;
    options.onPlannerSession = (value, context) =>
      coordinator.register(value, context);

    try {
      const result = await service.open(projectId, {
        mode: "resume-or-create",
      });
      expect(result.resolution).toBe("rehydrated");
      expect(result.session.planning?.greeting).toEqual({
        status: "delivered",
        messageId: "greeting-message",
      });
      expect(manager.submitInput).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
