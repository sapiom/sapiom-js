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
  ProjectBootstrapInputCapacityError,
  ProjectBootstrapRequestIdConflictError,
  ProjectBootstrapRetryUnavailableError,
  type ProjectBootstrapCoordinator,
} from "../core/planner-greeting.js";
import {
  ProjectSessionScopeUnavailableError,
  SessionBackgroundInputPreemptedError,
  SessionNotReadyError,
} from "../core/session-manager.js";
import {
  ProjectSessionError,
  type ProjectSessionService,
} from "../core/planning-session.js";
import type {
  AgentMapWorkspaceResponse,
  StudioProjectSummary,
} from "../shared/agent-map.js";
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

  async function start(projectLifecycle?: {
    projectSessions?: ProjectSessionService;
    projectBootstrap?: ProjectBootstrapCoordinator;
    submitSessionInput?: (
      sessionId: string,
      text: string,
      submit: boolean,
      requestId?: string,
    ) => Promise<
      | boolean
      | {
          ok: boolean;
          receipt?: {
            requestId: string | null;
            inputId: string;
            status: "queued" | "submitted" | "uncertain" | "completed";
            acceptedAt: string;
          };
        }
    >;
    onProjectCreated?: (project: StudioProjectSummary) => Promise<void> | void;
    onRootBound?: (
      project: StudioProjectSummary,
      root: string,
    ) => Promise<void> | void;
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
        ...projectLifecycle,
        ...(projectLifecycle && !projectLifecycle.submitSessionInput
          ? { submitSessionInput: async () => true }
          : {}),
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
    // Rendering durable map state is not a project-discovery boundary and
    // therefore cannot create/schedule another project lifecycle.
    expect(fixture.listWorkspaceScopes).not.toHaveBeenCalled();
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

  it("acknowledges a committed project identity when lifecycle scheduling must retry", async () => {
    const onProjectCreated = vi.fn(async () => {
      throw new Error("transient coordinator failure");
    });
    const fixture = await start({ onProjectCreated });

    const response = await fetch(`${fixture.baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ displayName: "Durably created" }),
    });
    const created = (await response.json()) as StudioProjectSummary;

    expect(response.status).toBe(202);
    expect(response.headers.get("X-Sapiom-Project-Initialization")).toBe(
      "pending",
    );
    expect(created.displayName).toBe("Durably created");
    expect(onProjectCreated).toHaveBeenCalledOnce();
    expect(
      (await fixture.catalog.list()).filter(
        (project) => project.projectId === created.projectId,
      ),
    ).toHaveLength(1);
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

  it("matches a Windows allowlisted root across drive, case, and separator variants", async () => {
    const fixture = await start();
    fixture.scopes.splice(0, fixture.scopes.length, {
      workspaceKey: "workspace-windows-project",
      cwd: "C:\\Users\\Alice\\Project",
    });

    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/root-bindings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({ root: "c:/users/alice/project/" }),
      },
    );

    expect(response.status).toBe(201);
    expect((await response.json()).projectId).toBe(fixture.project.projectId);
  });

  it("acknowledges durable root mutations and converges lifecycle retries without duplicate bindings", async () => {
    const onRootBound = vi
      .fn<(project: StudioProjectSummary, root: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient add failure"))
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("transient move failure"))
      .mockResolvedValueOnce();
    const fixture = await start({ onRootBound });
    const addedRoot = path.join(fixture.stateRoot, "publisher-repository");
    const movedRoot = path.join(fixture.stateRoot, "moved-market-research");
    await Promise.all([fs.mkdir(addedRoot), fs.mkdir(movedRoot)]);
    fixture.scopes.splice(
      0,
      fixture.scopes.length,
      { workspaceKey: "workspace-publisher", cwd: addedRoot },
      { workspaceKey: "workspace-moved", cwd: movedRoot },
    );
    const headers = {
      "Content-Type": "application/json",
      "X-Harness-Token": "test-token",
    };
    const addRoute = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/root-bindings`;
    const add = () =>
      fetch(addRoute, {
        method: "POST",
        headers,
        body: JSON.stringify({ root: addedRoot }),
      });

    const pendingAdd = await add();
    expect(pendingAdd.status).toBe(202);
    expect(pendingAdd.headers.get("X-Sapiom-Project-Initialization")).toBe(
      "pending",
    );
    expect((await add()).status).toBe(201);

    const moveRoute = `${addRoute}/${fixture.project.bindings[0]!.id}`;
    const move = () =>
      fetch(moveRoute, {
        method: "PUT",
        headers,
        body: JSON.stringify({ root: movedRoot }),
      });
    const pendingMove = await move();
    expect(pendingMove.status).toBe(202);
    expect(pendingMove.headers.get("X-Sapiom-Project-Initialization")).toBe(
      "pending",
    );
    expect((await move()).status).toBe(200);

    expect(onRootBound).toHaveBeenCalledTimes(4);
    const persisted = await fixture.catalog.resolve(fixture.project.projectId);
    expect(persisted?.bindings).toHaveLength(2);
    expect(JSON.stringify(persisted)).not.toContain(addedRoot);
    expect(JSON.stringify(persisted)).not.toContain(movedRoot);
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

  it("keeps legacy planner routes as project-scoped aliases to neutral services", async () => {
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
    const enqueue = vi.fn(async (_sessionId: string, _text: string) => {
      const metadata = {
        projectId: fixtureProjectId,
        userId: "user-1",
        targetSessionId: plannerSession.id,
        bootstrap: {
          status: "skipped" as const,
          reason: "user-proceeded" as const,
        },
        queuedInputIds: ["input-1"],
      };
      plannerSession.projectBootstrap = metadata;
      return metadata;
    });
    const retry = vi.fn(async () => {
      if (!plannerSession.projectBootstrap) {
        throw new Error("missing project bootstrap metadata");
      }
      plannerSession.projectBootstrap = {
        ...plannerSession.projectBootstrap,
        bootstrap: { status: "generating", attemptId: "attempt-2" },
      };
    });
    // This is the one canonical ordinary-session input authority shared with
    // POST /sessions/:id/input. The compatibility route must call it even
    // while bootstrap owns the durable FIFO; it may not enqueue independently.
    const submitSessionInput = vi.fn(
      async (
        sessionId: string,
        text: string,
        _submit: boolean,
        requestId?: string,
      ) => {
        await enqueue(sessionId, text);
        return requestId
          ? {
              ok: true as const,
              receipt: {
                requestId,
                inputId: "input-1",
                status: "queued" as const,
                acceptedAt: "2026-09-04T00:00:00.000Z",
              },
            }
          : true;
      },
    );
    const fixture = await start({
      projectSessions: {
        open,
        requireOwned,
      } as unknown as ProjectSessionService,
      projectBootstrap: {
        enqueue,
        retry,
      } as unknown as ProjectBootstrapCoordinator,
      submitSessionInput,
    });
    fixtureProjectId = fixture.project.projectId;
    plannerSession.agentMapIdentity = {
      projectId: fixtureProjectId,
      sessionId: plannerSession.id,
      userId: "user-1",
    };
    plannerSession.projectBootstrap = {
      projectId: fixtureProjectId,
      targetSessionId: plannerSession.id,
      userId: "user-1",
      bootstrap: {
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
      body: JSON.stringify({
        text: "Build a support triage system",
        requestId: "request-build-support",
      }),
    });
    expect(message.status).toBe(202);
    expect(await message.json()).toEqual({
      metadata: {
        projectId: fixture.project.projectId,
        targetSessionId: plannerSession.id,
        userId: "user-1",
        bootstrap: { status: "skipped", reason: "user-proceeded" },
        queuedInputIds: ["input-1"],
      },
      receipt: {
        requestId: "request-build-support",
        inputId: "input-1",
        status: "queued",
        acceptedAt: "2026-09-04T00:00:00.000Z",
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
    expect(submitSessionInput).toHaveBeenCalledWith(
      plannerSession.id,
      "Build a support triage system",
      true,
      "request-build-support",
    );

    const followUp = await fetch(`${route}/${plannerSession.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ text: "Keep this behind the durable FIFO" }),
    });
    expect(followUp.status).toBe(202);
    expect(enqueue).toHaveBeenLastCalledWith(
      plannerSession.id,
      "Keep this behind the durable FIFO",
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(submitSessionInput).toHaveBeenCalledTimes(2);

    plannerSession.projectBootstrap = {
      ...plannerSession.projectBootstrap!,
      bootstrap: {
        status: "failed",
        retryable: true,
        errorCode: "model_turn_failed",
      },
      queuedInputIds: [],
    };

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
        ...plannerSession.projectBootstrap,
        bootstrap: { status: "generating", attemptId: "attempt-2" },
      },
    });
    expect(retry).toHaveBeenCalledWith(plannerSession.id);
  });

  it("lets an ordinary project session use the legacy message alias without bootstrap metadata", async () => {
    const ordinarySession = {
      id: "ordinary-session-1",
      agentSessionId: "provider-session-1",
      harness: "codex",
      cwd: "/server/private/project",
      title: "Implementation",
      status: "running",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastActiveAt: "2026-09-01T00:00:00.000Z",
      exitCode: null,
      boundWorkflowPath: null,
      ready: true,
    } as HarnessSession;
    const requireOwned = vi.fn(async () => ordinarySession);
    const submitSessionInput = vi.fn(async () => true);
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned,
      } as unknown as ProjectSessionService,
      submitSessionInput,
    });
    ordinarySession.agentMapIdentity = {
      projectId: fixture.project.projectId,
      sessionId: ordinarySession.id,
      userId: "user-1",
    };

    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/${ordinarySession.id}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({ text: "Continue the implementation" }),
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ metadata: null });
    expect(requireOwned).toHaveBeenCalledWith(
      fixture.project.projectId,
      ordinarySession.id,
    );
    expect(submitSessionInput).toHaveBeenCalledTimes(1);
    expect(submitSessionInput).toHaveBeenCalledWith(
      ordinarySession.id,
      "Continue the implementation",
      true,
      undefined,
    );
  });

  it("dispatches each compatibility request once through the canonical authority", async () => {
    const ordinarySession = {
      id: "ordinary-session-1",
      agentSessionId: "provider-session-1",
      harness: "codex",
      cwd: "/server/private/project",
      title: "Implementation",
      status: "running",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastActiveAt: "2026-09-01T00:00:00.000Z",
      exitCode: null,
      boundWorkflowPath: null,
      ready: true,
    } as HarnessSession;
    const submitSessionInput = vi.fn(async () => true);
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned: vi.fn(async () => ordinarySession),
      } as unknown as ProjectSessionService,
      submitSessionInput,
    });
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/${ordinarySession.id}/messages`;
    const request = () =>
      fetch(route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({ text: "same visible text" }),
      });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(submitSessionInput).toHaveBeenCalledTimes(2);
    for (const call of submitSessionInput.mock.calls) {
      expect(call).toEqual([
        ordinarySession.id,
        "same visible text",
        true,
        undefined,
      ]);
    }
  });

  it("forwards request IDs and returns the same durable conflict semantics through the compatibility alias", async () => {
    const ordinarySession = {
      id: "bootstrap-session-1",
      status: "running",
    } as HarnessSession;
    const submitSessionInput = vi.fn(async () => {
      throw new ProjectBootstrapRequestIdConflictError();
    });
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned: vi.fn(async () => ordinarySession),
      } as unknown as ProjectSessionService,
      submitSessionInput,
    });

    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/${ordinarySession.id}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({
          text: "changed payload",
          requestId: "request-reused",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "project_bootstrap_request_id_reused",
      error: "project bootstrap request id was reused with different input",
    });
    expect(submitSessionInput).toHaveBeenCalledWith(
      ordinarySession.id,
      "changed payload",
      true,
      "request-reused",
    );
  });

  it("returns bounded durable-input capacity through the compatibility alias", async () => {
    const ordinarySession = {
      id: "bootstrap-session-capacity",
      status: "running",
    } as HarnessSession;
    const submitSessionInput = vi.fn(async () => {
      throw new ProjectBootstrapInputCapacityError();
    });
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned: vi.fn(async () => ordinarySession),
      } as unknown as ProjectSessionService,
      submitSessionInput,
    });

    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/${ordinarySession.id}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({
          text: "new logical request",
          requestId: "request-at-capacity",
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "project_bootstrap_input_capacity",
      error: "project bootstrap input receipt capacity is temporarily full",
    });
    expect(submitSessionInput).toHaveBeenCalledWith(
      ordinarySession.id,
      "new logical request",
      true,
      "request-at-capacity",
    );
  });

  it("maps canonical input rejection without retrying compatibility dispatch", async () => {
    const ordinarySession = {
      id: "ordinary-session-1",
      status: "running",
    } as HarnessSession;
    const submitSessionInput = vi
      .fn<
        (sessionId: string, text: string, submit: boolean) => Promise<boolean>
      >()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new SessionNotReadyError(ordinarySession.id))
      .mockRejectedValueOnce(new SessionBackgroundInputPreemptedError(false));
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned: vi.fn(async () => ordinarySession),
      } as unknown as ProjectSessionService,
      submitSessionInput,
    });
    const route = `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/${ordinarySession.id}/messages`;
    const request = () =>
      fetch(route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({ text: "one dispatch" }),
      });

    const missing = await request();
    const unready = await request();
    const concurrent = await request();

    expect(missing.status).toBe(404);
    expect(unready.status).toBe(409);
    expect(await unready.json()).toMatchObject({ code: "SESSION_NOT_READY" });
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({
      code: "SESSION_BACKGROUND_INPUT_PREEMPTED",
      error: "background session input was preempted by user input",
    });
    expect(submitSessionInput).toHaveBeenCalledTimes(3);
  });

  it("rejects foreign planner messages and bounds unavailable retries", async () => {
    const requireOwned = vi.fn<() => Promise<HarnessSession>>(async () => {
      throw new ProjectSessionError("forbidden");
    });
    const enqueue = vi.fn(async () => ({}) as never);
    const retry = vi.fn(async () => {
      throw new ProjectBootstrapRetryUnavailableError();
    });
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned,
      } as unknown as ProjectSessionService,
      projectBootstrap: {
        enqueue,
        retry,
      } as unknown as ProjectBootstrapCoordinator,
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
      code: "project_bootstrap_retry_unavailable",
      error: "project bootstrap retry is not available",
    });
  });

  it("returns a bounded compatibility error when project scope cannot be revalidated", async () => {
    const requireOwned = vi.fn(async () => {
      throw new ProjectSessionScopeUnavailableError("ordinary-session");
    });
    const fixture = await start({
      projectSessions: {
        open: vi.fn(),
        requireOwned,
      } as unknown as ProjectSessionService,
      projectBootstrap: {
        enqueue: vi.fn(),
        retry: vi.fn(),
      } as unknown as ProjectBootstrapCoordinator,
    });
    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/planner-sessions/ordinary-session/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({ text: "continue" }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "PROJECT_SESSION_SCOPE_UNAVAILABLE",
      error: "the session's Studio project scope could not be revalidated",
    });
  });
});
