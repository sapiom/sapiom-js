import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioProjectCatalog } from "@sapiom/agent-map/node/studio-project-catalog";
import { StudioWorkspacePreferenceStore } from "../core/studio-workspace-preferences.js";
import { createBootTokenMiddleware } from "./auth.js";
import { createStudioProjectsRouter } from "./studio-projects.js";
import type { WorkflowInfo } from "../shared/types.js";

describe("createStudioProjectsRouter", () => {
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

  async function start() {
    // Resolve the macOS /var -> /private/var alias: the catalog stores canonical roots.
    const stateRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "studio-projects-router-")),
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
    let currentUserId = "user-test";
    const app = express();
    const workflows: WorkflowInfo[] = [{ name: "Planner", path: path.join(privateRoot, "planner"),
      definitionId: null, definitionSlug: null, source: "scan" }];
    app.use(express.json());
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use("/api", express.json());
    app.use(
      "/api",
      createStudioProjectsRouter({
        catalog,
        listWorkspaceScopes,
        preferences: new StudioWorkspacePreferenceStore(
          path.join(stateRoot, "studio-workspace-preferences.json"),
        ),
        listWorkflows: () => workflows,
        isWorkflowScanComplete: () => true,
        currentUserId: () => currentUserId,
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
      workflows,
      setCurrentUserId: (userId: string) => {
        currentUserId = userId;
      },
    };
  }

  it("creates a zero-binding project", async () => {
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
    const movedBody = (await moved.json()) as Record<string, unknown>;
    const addedBody = (await added.json()) as Record<string, unknown>;
    const opened = await fixture.catalog.resolve(fixture.project.projectId);

    expect(moved.status).toBe(200);
    expect(added.status).toBe(201);
    expect(movedBody.projectId).toBe(fixture.project.projectId);
    expect(addedBody.projectId).toBe(fixture.project.projectId);
    expect(opened?.projectId).toBe(fixture.project.projectId);
    expect(opened?.bindings).toHaveLength(2);
    for (const body of [movedBody, addedBody, opened]) {
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

  it("defaults to the agent map, persists a valid opaque agent, and repairs a foreign id", async () => {
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

  it("shares durable selection when the trusted principal changes live", async () => {
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
      selection: { kind: "agent", agentId },
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
        error: "Studio project state is malformed",
      });
    }
  });

  it("returns a bounded 404 for an unknown project", async () => {
    const fixture = await start();
    const unknown = "project_00000000-0000-4000-8000-000000000099";
    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${unknown}/current-workspace`,
      { headers: { "X-Harness-Token": "test-token" } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "project_not_found",
      error: "Studio project not found",
    });
  });

  it("bounds malformed persisted state and never repairs it", async () => {
    const fixture = await start();
    const preferencesPath = path.join(
      fixture.stateRoot,
      "studio-workspace-preferences.json",
    );
    await fs.writeFile(preferencesPath, "{bad-json");
    const response = await fetch(
      `${fixture.baseUrl}/api/projects/${fixture.project.projectId}/current-workspace`,
      { headers: { "X-Harness-Token": "test-token" } },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "malformed_state",
      error: "Studio project state is malformed",
    });
    expect(await fs.readFile(preferencesPath, "utf8")).toBe("{bad-json");
  });
});
