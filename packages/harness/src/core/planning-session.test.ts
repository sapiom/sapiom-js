import { describe, expect, it, vi } from "vitest";

import type { AgentMapWorkspaceState } from "../shared/agent-map.js";
import type { HarnessSession, SessionRecord } from "../shared/types.js";
import type { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import {
  buildFocusedPlannerContext,
  localPlanningPrincipal,
  PlanningSessionError,
  PlanningSessionService,
} from "./planning-session.js";
import type { SessionManager } from "./session-manager.js";
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
      identity: { projectId, sessionId: id, userId: "user-1", role: "map-planner" },
      greeting: { status: "pending" },
      queuedInputIds: [],
    },
    ...overrides,
  };
}

function fixture(existing: HarnessSession[] = []) {
  let next = 0;
  const contexts: string[] = [];
  const created: HarnessSession[] = [];
  const create = vi.fn(async (request, trusted) => {
    const id = `new-${++next}`;
    contexts.push(trusted.promptAppendix(id));
    const value = session(id, {
      harness: request.harness,
      cwd: request.cwd,
      planning: trusted.planning(id),
      rehydratedFrom: request.rehydrateFrom ?? null,
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
  const manager = {
    create,
    resume,
    list: () => existing,
    isLive: (id: string) =>
      existing.some((candidate) => candidate.id === id && candidate.status === "running"),
    get: (id: string) => [...existing, ...created].find((candidate) => candidate.id === id),
  } as unknown as SessionManager;
  const service = new PlanningSessionService({
    catalog: {
      resolveIdentity: async (id: string) => (id === projectId ? project : null),
    } as unknown as StudioProjectCatalog,
    workspaceStore: {
      readOrCreate: async () => workspace,
    } as unknown as AgentMapWorkspaceStore,
    sessionManager: manager,
    readRecord: async () => null,
    userId: "user-1",
    machineId: "machine-1",
    defaultHarness: "codex",
  });
  return { service, create, resume, contexts };
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
    });
    expect(context).toContain(projectId);
    expect(context).toContain(project.rootBindings[0]!.id);
    expect(context).toContain('"role":"map-planner"');
    expect(context).toContain('"empty":true');
    expect(context).not.toContain("/Users/private");
    expect(context).not.toContain("private-workspace-key");
    expect(context).not.toContain("localRootRef");
    expect(context).not.toContain("prompt");
    expect(context.length).toBeLessThan(16_384);
  });
});

describe("PlanningSessionService", () => {
  it("always creates a new, server-scoped planner for explicit fresh", async () => {
    const { service, create, contexts } = fixture();
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
      greeting: { status: "pending" },
      queuedInputIds: [],
    });
    expect(contexts.every((value) => !value.includes(project.rootBindings[0]!.localRootRef))).toBe(true);
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
    expect(() => service.requireOwned("other-project", latest.id)).toThrow(
      PlanningSessionError,
    );
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
    expect(contexts[0]).not.toContain(project.rootBindings[0]!.localRootRef);
  });

  it("rehydrates recorded history when vendor resume is unavailable", async () => {
    const prior = session("recorded", {
      status: "exited",
      agentSessionId: "stale-vendor-session",
    });
    const { service, resume, create } = fixture([prior]);
    resume.mockRejectedValueOnce(new Error("not resumable"));
    (service as unknown as { options: { readRecord: () => Promise<SessionRecord> } }).options.readRecord =
      async () => ({ turnCount: 1 } as SessionRecord);

    const result = await service.open(projectId, { mode: "resume-or-create" });

    expect(result.resolution).toBe("rehydrated");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ rehydrateFrom: prior.id }),
      expect.any(Object),
    );
    expect(result.session.planning?.greeting.status).toBe("skipped");
  });
});
