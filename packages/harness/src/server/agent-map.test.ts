import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { StudioWorkspacePreferenceStore } from "../core/studio-workspace-preferences.js";
import {
  PlannerGreetingRetryUnavailableError,
  type PlannerGreetingCoordinator,
} from "../core/planner-greeting.js";
import {
  PlanningSessionError,
  type PlanningSessionService,
} from "../core/planning-session.js";
import type { BuilderPlanningSessionService } from "../core/builder-planning-session.js";
import type { AgentMapWorkspaceResponse } from "../shared/agent-map.js";
import type { HarnessSession } from "../shared/types.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createAgentMapRouter } from "./agent-map.js";

describe("createAgentMapRouter", () => {
  const roots: string[] = [];
  let server: ReturnType<express.Express["listen"]> | undefined;

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function start(planner?: {
    planningSessions?: PlanningSessionService;
    plannerGreeting?: PlannerGreetingCoordinator;
    builderPlanningSessions?: BuilderPlanningSessionService;
  }) {
    const stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-map-router-"),
    );
    roots.push(stateRoot);
    const privateRoot = path.join(stateRoot, "private-market-research");
    await fs.mkdir(privateRoot);
    const scope = { workspaceKey: "workspace-private-alias", cwd: privateRoot };
    const scopes = [scope];
    const catalog = new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    );
    const project = (await catalog.reconcile([scope])).projects[0]!;
    const listWorkspaceScopes = vi.fn(async () => [...scopes]);
    const onEvent = vi.fn();
    let currentUserId = "user-test";
    const store = new AgentMapWorkspaceStore(
      path.join(stateRoot, "agent-map"),
      { onEvent },
    );
    const app = express();
    app.use(express.json());
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use("/api", express.json());
    app.use(
      "/api",
      createAgentMapRouter({
        catalog,
        store,
        preferences: new StudioWorkspacePreferenceStore(
          path.join(stateRoot, "studio-workspace-preferences.json"),
        ),
        currentUserId: () => currentUserId,
        listWorkflows: () => [
          {
            name: "Planner",
            path: path.join(privateRoot, "planner"),
            definitionId: null,
            definitionSlug: null,
            source: "scan" as const,
          },
        ],
        isWorkflowScanComplete: () => true,
        listWorkspaceScopes,
        ...planner,
      }),
    );
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      stateRoot,
      privateRoot,
      project,
      catalog,
      scopes,
      listWorkspaceScopes,
      onEvent,
      setCurrentUserId: (userId: string) => {
        currentUserId = userId;
      },
    };
  }

  it("is boot-token protected, lazy, idempotent, and path-free", async () => {
    const fixture = await start();
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/agent-map/workspace`;
    const workspacePath = path.join(
      fixture.stateRoot,
      "agent-map",
      "projects",
      fixture.project.projectId,
      "workspace.json",
    );

    expect((await fetch(route)).status).toBe(401);
    await expect(fs.stat(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const first = await fetch(route, {
      headers: { "X-Harness-Token": "test-token" },
    });
    const second = await fetch(route, {
      headers: { "X-Harness-Token": "test-token" },
    });
    const firstBody = (await first.json()) as AgentMapWorkspaceResponse;
    const secondBody = (await second.json()) as AgentMapWorkspaceResponse;

    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(secondBody).toEqual(firstBody);
    expect(firstBody.workspace).toMatchObject({
      projectId: fixture.project.projectId,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId: null,
      projectBuildPlanId: null,
    });
    const publicJson = JSON.stringify(firstBody);
    expect(publicJson).not.toContain(fixture.privateRoot);
    expect(publicJson).not.toContain("workspace-private-alias");
    expect(fixture.onEvent).toHaveBeenCalledTimes(1);
    expect(fixture.listWorkspaceScopes).toHaveBeenCalledTimes(2);
  });

  it("creates a zero-binding project without eagerly creating map state", async () => {
    const fixture = await start();
    const response = await fetch(`${fixture.baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ displayName: "Empty plan" }),
    });
    const project = (await response.json()) as {
      projectId: string;
      bindings: unknown[];
    };

    expect(response.status).toBe(201);
    expect(project.bindings).toEqual([]);
    await expect(
      fs.stat(
        path.join(
          fixture.stateRoot,
          "agent-map",
          "projects",
          project.projectId,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves identity when the authenticated boundary moves and adds root bindings", async () => {
    const fixture = await start();
    const movedRoot = path.join(fixture.stateRoot, "moved-market-research");
    const secondRoot = path.join(fixture.stateRoot, "publisher-repository");
    await Promise.all([fs.mkdir(movedRoot), fs.mkdir(secondRoot)]);
    fixture.scopes.splice(
      0,
      fixture.scopes.length,
      { workspaceKey: "workspace-moved", cwd: movedRoot },
      { workspaceKey: "workspace-publisher", cwd: secondRoot },
    );
    const headers = {
      "Content-Type": "application/json",
      "X-Harness-Token": "test-token",
    };

    const moved = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/root-bindings/${fixture.project.bindings[0]!.id}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ root: movedRoot }),
      },
    );
    const added = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/root-bindings`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ root: secondRoot }),
      },
    );
    const opened = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/agent-map/workspace`,
      { headers },
    );
    const movedBody = (await moved.json()) as Record<string, unknown>;
    const addedBody = (await added.json()) as Record<string, unknown>;
    const openedBody = (await opened.json()) as AgentMapWorkspaceResponse;

    expect(moved.status).toBe(200);
    expect(added.status).toBe(201);
    expect(opened.status).toBe(200);
    expect(movedBody.projectId).toBe(fixture.project.projectId);
    expect(addedBody.projectId).toBe(fixture.project.projectId);
    expect(openedBody.project.projectId).toBe(fixture.project.projectId);
    expect(openedBody.project.bindings).toHaveLength(2);
    for (const body of [movedBody, addedBody, openedBody]) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(movedRoot);
      expect(serialized).not.toContain(secondRoot);
      expect(serialized).not.toContain("workspace-moved");
      expect(serialized).not.toContain("repositoryId");
    }

    const restarted = await new StudioProjectCatalog(
      path.join(fixture.stateRoot, "studio-projects.json"),
    ).reconcile(fixture.scopes);
    expect(restarted.projects).toHaveLength(1);
    expect(restarted.projects[0]?.projectId).toBe(fixture.project.projectId);
    expect(restarted.projects[0]?.bindings).toHaveLength(2);
  });

  it("does not expose root association without the boot token or allow list", async () => {
    const fixture = await start();
    const unknownRoot = path.join(fixture.stateRoot, "not-opened");
    await fs.mkdir(unknownRoot);
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/root-bindings`;

    expect(
      (
        await fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: unknownRoot }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(route, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Harness-Token": "test-token",
          },
          body: JSON.stringify({ root: unknownRoot }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await fixture.catalog.resolve(fixture.project.projectId))?.bindings,
    ).toHaveLength(1);
  });

  it("defaults to Agent Map, persists a valid opaque agent, and repairs a foreign id", async () => {
    const fixture = await start();
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/current-workspace`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    const first = await fetch(route, { headers });
    const initial = (await first.json()) as {
      selection: { kind: string };
      agents: Array<{ agentId: string }>;
    };
    expect(initial.selection.kind).toBe("agent-map");
    expect(JSON.stringify(initial)).not.toContain(fixture.privateRoot);

    const selected = await fetch(route, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        selection: {
          kind: "agent",
          projectId: fixture.project.projectId,
          agentId: initial.agents[0]!.agentId,
        },
      }),
    });
    expect(await selected.json()).toMatchObject({
      repaired: false,
      selection: { kind: "agent", agentId: initial.agents[0]!.agentId },
    });

    const repaired = await fetch(route, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        selection: {
          kind: "agent",
          projectId: fixture.project.projectId,
          agentId: "agent_00000000-0000-4000-8000-999999999999",
        },
      }),
    });
    expect(await repaired.json()).toMatchObject({
      repaired: true,
      selection: { kind: "agent-map" },
    });
  });

  it("isolates durable selection when the trusted principal changes live", async () => {
    const fixture = await start();
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/current-workspace`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    const initial = (await (await fetch(route, { headers })).json()) as {
      agents: Array<{ agentId: string }>;
    };
    const agentId = initial.agents[0]!.agentId;
    const selected = await fetch(route, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        selection: {
          kind: "agent",
          projectId: fixture.project.projectId,
          agentId,
        },
      }),
    });
    expect(await selected.json()).toMatchObject({
      selection: { kind: "agent", agentId },
    });

    fixture.setCurrentUserId("user-other");
    expect(await (await fetch(route, { headers })).json()).toMatchObject({
      selection: { kind: "agent-map" },
    });

    fixture.setCurrentUserId("user-test");
    expect(await (await fetch(route, { headers })).json()).toMatchObject({
      selection: { kind: "agent", agentId },
    });
  });

  it("strictly rejects malformed or over-posted workspace selections", async () => {
    const fixture = await start();
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/current-workspace`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    const invalidBodies = [
      {
        selection: {
          kind: "agent",
          projectId: fixture.project.projectId,
          agentId: "agent_not-a-server-id",
        },
      },
      {
        selection: {
          kind: "agent-map",
          projectId: fixture.project.projectId,
          agentId: "agent_00000000-0000-4000-8000-000000000001",
        },
      },
      {
        selection: {
          kind: "agent-map",
          projectId: fixture.project.projectId,
        },
        privatePath: fixture.privateRoot,
      },
    ];

    for (const body of invalidBodies) {
      const response = await fetch(route, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "malformed_state",
        error: "Agent Map state is malformed",
      });
    }
  });

  it("returns a bounded 404 before touching workspace storage", async () => {
    const fixture = await start();
    const unknown = "project_00000000-0000-4000-8000-000000000099";
    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${unknown}/agent-map/workspace`,
      { headers: { "X-Harness-Token": "test-token" } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "project_not_found",
      error: "Studio project not found",
    });
    await expect(
      fs.stat(path.join(fixture.stateRoot, "agent-map", "projects", unknown)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.onEvent).not.toHaveBeenCalled();
  });

  it("bounds malformed persisted state and never repairs it", async () => {
    const fixture = await start();
    const workspacePath = path.join(
      fixture.stateRoot,
      "agent-map",
      "projects",
      fixture.project.projectId,
      "workspace.json",
    );
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.writeFile(workspacePath, "{bad-json");
    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/agent-map/workspace`,
      { headers: { "X-Harness-Token": "test-token" } },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "malformed_state",
      error: "Agent Map state is malformed",
    });
    expect(await fs.readFile(workspacePath, "utf8")).toBe("{bad-json");
  });

  it("protects planner routes and accepts only project-scoped intent", async () => {
    let fixtureProjectId = "";
    const plannerSession = {
      id: "planner-session-1",
      agentSessionId: null,
      harness: "codex",
      cwd: "/server/private/project",
      title: "project",
      status: "running",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastActiveAt: "2026-09-01T00:00:00.000Z",
      exitCode: null,
      boundWorkflowPath: null,
      ready: false,
    } as HarnessSession;
    const open = vi.fn(async () => ({
      session: plannerSession,
      resolution: "created" as const,
    }));
    const requireOwned = vi.fn(() => plannerSession);
    const enqueue = vi.fn(async () => ({
      identity: {
        projectId: fixtureProjectId,
        sessionId: plannerSession.id,
        userId: "user-1",
        role: "map-planner" as const,
      },
      greeting: { status: "pending" as const },
      queuedInputIds: ["input-1"],
    }));
    const retry = vi.fn(async () => {
      if (!plannerSession.planning) throw new Error("missing planner metadata");
      plannerSession.planning = {
        ...plannerSession.planning,
        greeting: { status: "generating", attemptId: "attempt-2" },
      };
    });
    const fixture = await start({
      planningSessions: {
        open,
        requireOwned,
      } as unknown as PlanningSessionService,
      plannerGreeting: {
        enqueue,
        retry,
      } as unknown as PlannerGreetingCoordinator,
    });
    fixtureProjectId = fixture.project.projectId;
    plannerSession.planning = {
      identity: {
        projectId: fixtureProjectId,
        sessionId: plannerSession.id,
        userId: "user-1",
        role: "map-planner",
      },
      greeting: {
        status: "failed",
        retryable: true,
        errorCode: "model_turn_failed",
      },
      queuedInputIds: [],
    };
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions`;

    expect(
      (
        await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "fresh" }),
        })
      ).status,
    ).toBe(401);
    const forged = await fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({
        mode: "fresh",
        role: "map-planner",
        projectId: fixture.project.projectId,
      }),
    });
    expect(forged.status).toBe(400);
    expect(open).not.toHaveBeenCalled();

    const valid = await fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ mode: "fresh", harness: "codex" }),
    });
    expect(valid.status).toBe(201);
    expect(open).toHaveBeenCalledWith(fixture.project.projectId, {
      mode: "fresh",
      harness: "codex",
    });

    const message = await fetch(`${route}/${plannerSession.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ text: "Build a support triage system" }),
    });
    expect(message.status).toBe(202);
    expect(await message.json()).toEqual({
      metadata: {
        identity: {
          projectId: fixture.project.projectId,
          sessionId: plannerSession.id,
          userId: "user-1",
          role: "map-planner",
        },
        greeting: { status: "pending" },
        queuedInputIds: ["input-1"],
      },
    });
    expect(requireOwned).toHaveBeenCalledWith(
      fixture.project.projectId,
      plannerSession.id,
    );
    expect(enqueue).toHaveBeenCalledWith(
      plannerSession.id,
      "Build a support triage system",
    );

    const retryResponse = await fetch(
      `${route}/${plannerSession.id}/greeting/retry`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: "{}",
      },
    );
    expect(retryResponse.status).toBe(202);
    expect(await retryResponse.json()).toEqual({
      metadata: {
        ...plannerSession.planning,
        greeting: { status: "generating", attemptId: "attempt-2" },
      },
    });
    expect(retry).toHaveBeenCalledWith(plannerSession.id);
  });

  it("rejects foreign planner messages and bounds unavailable retries", async () => {
    const requireOwned = vi.fn<() => Promise<HarnessSession>>(async () => {
      throw new PlanningSessionError("forbidden");
    });
    const enqueue = vi.fn(async () => ({}) as never);
    const retry = vi.fn(async () => {
      throw new PlannerGreetingRetryUnavailableError();
    });
    const fixture = await start({
      planningSessions: {
        open: vi.fn(),
        requireOwned,
      } as unknown as PlanningSessionService,
      plannerGreeting: {
        enqueue,
        retry,
      } as unknown as PlannerGreetingCoordinator,
    });
    const headers = {
      "content-type": "application/json",
      "X-Harness-Token": "test-token",
    };
    const message = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/foreign/messages`,
      { method: "POST", headers, body: JSON.stringify({ text: "hello" }) },
    );
    expect(message.status).toBe(403);
    expect(await message.json()).toMatchObject({ code: "forbidden" });
    expect(enqueue).not.toHaveBeenCalled();

    const forbiddenRetry = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/foreign/greeting/retry`,
      { method: "POST", headers, body: "{}" },
    );
    expect(forbiddenRetry.status).toBe(403);
    expect(await forbiddenRetry.json()).toMatchObject({ code: "forbidden" });
    expect(retry).not.toHaveBeenCalled();

    requireOwned.mockResolvedValue({ id: "owned" } as HarnessSession);
    const retryResponse = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/owned/greeting/retry`,
      { method: "POST", headers, body: "{}" },
    );
    expect(retryResponse.status).toBe(409);
    expect(await retryResponse.json()).toEqual({
      code: "greeting_retry_unavailable",
      error: "greeting retry is not available",
    });
  });

  it("mints exact fan-out approval only after boot auth and owned planner provenance", async () => {
    const plannerSession = {
      id: "planner-owned",
      planning: {
        identity: {
          projectId: "project-placeholder",
          sessionId: "planner-owned",
          userId: "user-test",
          role: "map-planner",
        },
      },
    } as unknown as HarnessSession;
    const approve = vi.fn(async () => ({
      approvalId: "fanout-approval_00000000-0000-7000-8000-000000000001",
    }));
    const open = vi.fn(async () => ({
      bindings: [] as unknown[],
      unreachableAssignmentIds: [] as string[],
    }));
    const preview = vi.fn(async () => ({ available: false, warnings: [] }));
    const builder = {
      approveFromAuthenticatedUiAction: approve,
      openOrReuse: open,
      preview,
    } as unknown as BuilderPlanningSessionService;
    const fixture = await start({
      planningSessions: {
        open: vi.fn(),
        requireOwned: vi.fn(async () => plannerSession),
      } as unknown as PlanningSessionService,
      plannerGreeting: {} as PlannerGreetingCoordinator,
      builderPlanningSessions: builder,
    });
    plannerSession.planning!.identity.projectId = fixture.project.projectId;
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/${plannerSession.id}/planning-fanout`;
    const body = {
      source: {
        kind: "proposal",
        proposalId: "proposal_00000000-0000-7000-8000-000000000001",
        version: 1,
        graphDigest: `sha256:${"1".repeat(64)}`,
      },
      plan: {
        planId: "build-plan_00000000-0000-7000-8000-000000000002",
        version: 1,
        semanticDigest: `sha256:${"2".repeat(64)}`,
      },
      assignmentIds: ["assignment_00000000-0000-7000-8000-000000000003"],
    };
    expect(
      (
        await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    const forged = await fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ ...body, approved: true, userInputId: "forged" }),
    });
    expect(forged.status).toBe(400);
    expect(approve).not.toHaveBeenCalled();

    const accepted = await fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(202);
    expect(approve).toHaveBeenCalledWith(
      plannerSession.planning!.identity,
      body,
      expect.stringMatching(/^user-action_[0-9a-f-]{36}$/u),
    );
    expect(open).toHaveBeenCalledWith(
      plannerSession.planning!.identity,
      expect.objectContaining({ ...body, approvalId: expect.any(String) }),
    );

    open.mockResolvedValueOnce({
      bindings: [],
      unreachableAssignmentIds: body.assignmentIds,
    });
    const unreachable = await fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify(body),
    });
    expect(unreachable.status).toBe(202);
    expect(await unreachable.json()).toMatchObject({
      bindings: [],
      unreachableAssignmentIds: body.assignmentIds,
    });
  });

  it("keeps planning preview side-effect free for unknown project ids", async () => {
    const preview = vi.fn(async () => ({ available: false, warnings: [] }));
    const fixture = await start({
      builderPlanningSessions: {
        preview,
      } as unknown as BuilderPlanningSessionService,
    });
    const response = await fetch(
      `${fixture.baseUrl}/api/projects/project_00000000-0000-4000-8000-000000009999/planning-fanout`,
      { headers: { "X-Harness-Token": "test-token" } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "project_not_found" });
    expect(preview).not.toHaveBeenCalled();
  });

  it("opens an additional builder tab only through the scoped project route", async () => {
    const additional = {
      id: "builder-additional",
      agentSessionId: null,
      harness: "codex",
      cwd: "/tmp/project",
      title: "Research",
      status: "starting",
      createdAt: "2026-09-03T12:00:00.000Z",
      lastActiveAt: "2026-09-03T12:00:00.000Z",
      boundWorkflowPath: null,
      ready: false,
      executionPolicy: "planning-readonly",
    } as const;
    const openAdditionalSession = vi.fn(async () => additional);
    const fixture = await start({
      builderPlanningSessions: {
        openAdditionalSession,
      } as unknown as BuilderPlanningSessionService,
    });
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/builder-planning-sessions/builder-primary/additional`;
    expect(
      (
        await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harness: "codex" }),
        })
      ).status,
    ).toBe(401);
    const response = await fetch(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ harness: "codex", theme: "dark" }),
    });
    expect(response.status).toBe(201);
    expect(openAdditionalSession).toHaveBeenCalledWith(
      fixture.project.projectId,
      "builder-primary",
      { harness: "codex", theme: "dark" },
    );
    expect(await response.json()).toMatchObject({
      id: "builder-additional",
      executionPolicy: "planning-readonly",
    });
  });
});
