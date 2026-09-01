import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import type { AgentMapWorkspaceResponse } from "../shared/agent-map.js";
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

  async function start() {
    const stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-map-router-"),
    );
    roots.push(stateRoot);
    const privateRoot = path.join(stateRoot, "private-market-research");
    await fs.mkdir(privateRoot);
    const scope = { workspaceKey: "workspace-private-alias", cwd: privateRoot };
    const catalog = new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    );
    const project = (await catalog.reconcile([scope])).projects[0]!;
    const listWorkspaceScopes = vi.fn(async () => [scope]);
    const onEvent = vi.fn();
    const store = new AgentMapWorkspaceStore(
      path.join(stateRoot, "agent-map"),
      { onEvent },
    );
    const app = express();
    app.use("/api", createBootTokenMiddleware("test-token"));
    app.use(
      "/api",
      createAgentMapRouter({ catalog, store, listWorkspaceScopes }),
    );
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      stateRoot,
      privateRoot,
      project,
      listWorkspaceScopes,
      onEvent,
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
});
