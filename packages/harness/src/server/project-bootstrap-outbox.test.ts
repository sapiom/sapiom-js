import { createServer as createHttpServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

describe("new-project bootstrap outbox recovery", () => {
  let stateRoot: string;
  let existingRoot: string;
  let newRoot: string;
  let webDir: string;
  let existingProjectId: string;
  let server: HarnessServer | undefined;
  let launches: LaunchOpts[];

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-bootstrap-server-outbox-"),
    );
    existingRoot = path.join(stateRoot, "existing-project");
    newRoot = path.join(stateRoot, "new-project");
    webDir = path.join(stateRoot, "web");
    await Promise.all([
      fs.mkdir(existingRoot),
      fs.mkdir(newRoot),
      fs.mkdir(webDir),
    ]);
    await fs.writeFile(path.join(webDir, "index.html"), "<html></html>");
    const reconciled = await new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    ).reconcile([{ workspaceKey: "existing", cwd: existingRoot }]);
    existingProjectId = reconciled.projects[0]!.projectId;
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [existingRoot] }),
    );
    launches = [];
  });

  afterEach(async () => {
    await server?.close();
    vi.restoreAllMocks();
    await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  const markerFile = (projectId: string) =>
    path.join(
      stateRoot,
      "agent-map",
      "project-bootstrap",
      "project-outbox",
      `${projectId}.json`,
    );

  const intentFile = (projectId: string) =>
    path.join(
      stateRoot,
      "agent-map",
      "project-bootstrap",
      "projects",
      `${projectId}.json`,
    );

  async function exists(file: string): Promise<boolean> {
    try {
      await fs.stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  function adapter(): HarnessAdapter {
    const launch = (options: LaunchOpts): SpawnSpec => {
      launches.push(options);
      return { command: "bash", args: [], env: {}, cwd: options.cwd };
    };
    return {
      id: "claude-code",
      eventSource: "hooks",
      doctor: async () => [],
      launch,
      resume: (_agentSessionId, options) => launch(options),
      listPastSessions: async () => [],
      canResume: async () => true,
    };
  }

  async function boot(failBeforeSchedule = false): Promise<HarnessServer> {
    return startServer({
      port: 0,
      bootToken: "boot-token",
      telemetryOptIn: false,
      identity: null,
      machineId: "machine-1",
      adapters: { "claude-code": adapter() },
      stateRoot,
      launchDir: existingRoot,
      webDir,
      autoCreateSession: false,
      loadSystemPrompt: async () => "ordinary coding prompt",
      ...(failBeforeSchedule
        ? {
            projectBootstrapTestHooks: {
              beforeSchedule: async () => {
                throw new Error("simulated crash before intent commit");
              },
            },
          }
        : {}),
    });
  }

  async function request(
    active: HarnessServer,
    pathname: string,
    init: RequestInit,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${active.port}/api${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-harness-token": "boot-token",
        ...init.headers,
      },
    });
  }

  it("recovers an explicit project committed before its bootstrap intent", async () => {
    server = await boot(true);
    const response = await request(server, "/projects", {
      method: "POST",
      body: JSON.stringify({ displayName: "Explicit project" }),
    });
    expect(response.status).toBe(202);
    const project = (await response.json()) as { projectId: string };
    expect(await exists(markerFile(project.projectId))).toBe(true);
    expect(await exists(intentFile(project.projectId))).toBe(false);

    await server.close();
    server = undefined;
    await new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    ).addRootBinding(project.projectId, newRoot, {
      legacyWorkspaceKey: "explicit-project-root",
    });

    server = await boot();

    expect(launches).toHaveLength(1);
    expect(server.sessionManager.list()).toEqual([
      expect.objectContaining({
        title: "Plan Agents",
        cwd: newRoot,
        agentMapIdentity: expect.objectContaining({
          projectId: project.projectId,
          userId: "local:machine-1",
        }),
        projectBootstrap: expect.objectContaining({
          projectId: project.projectId,
          userId: "local:machine-1",
        }),
      }),
    ]);
    expect(await exists(markerFile(project.projectId))).toBe(false);
    expect(await exists(intentFile(project.projectId))).toBe(true);
    expect(
      server.sessionManager
        .list()
        .some(
          (session) =>
            session.agentMapIdentity?.projectId === existingProjectId,
        ),
    ).toBe(false);
  });

  it("recovers a reconcile-created project without enrolling an older project", async () => {
    server = await boot(true);
    await request(server, "/settings", {
      method: "PATCH",
      body: JSON.stringify({ recentDirs: [newRoot, existingRoot] }),
    });
    const catalog = new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    );
    const created = await catalog.resolveIdentityForPath(newRoot);
    expect(created).not.toBeNull();
    expect(created!.projectId).not.toBe(existingProjectId);
    expect(await exists(markerFile(created!.projectId))).toBe(true);
    expect(await exists(intentFile(created!.projectId))).toBe(false);

    await server.close();
    server = undefined;
    server = await boot();

    expect(launches).toHaveLength(1);
    const sessions = server.sessionManager.list();
    expect(sessions).toEqual([
      expect.objectContaining({
        title: "Plan Agents",
        cwd: newRoot,
        agentMapIdentity: expect.objectContaining({
          projectId: created!.projectId,
          userId: "local:machine-1",
        }),
        projectBootstrap: expect.objectContaining({
          projectId: created!.projectId,
        }),
      }),
    ]);
    expect(
      sessions.some(
        (session) => session.agentMapIdentity?.projectId === existingProjectId,
      ),
    ).toBe(false);
    expect(await exists(markerFile(created!.projectId))).toBe(false);
    expect(await exists(intentFile(created!.projectId))).toBe(true);
  });

  it("converges a project created by an unowned reconciliation without a restart", async () => {
    server = await boot();
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [newRoot, existingRoot] }),
    );

    const mapRead = await request(
      server,
      `/projects/${existingProjectId}/agent-map/workspace`,
      { method: "GET" },
    );
    expect(mapRead.status).toBe(200);
    expect(server.sessionManager.list()).toEqual([]);
    expect(launches).toEqual([]);
    await expect(
      new StudioProjectCatalog(
        path.join(stateRoot, "studio-projects.json"),
      ).resolveIdentityForPath(newRoot),
    ).resolves.toBeNull();

    const state = await request(server, "/state", { method: "GET" });
    expect(state.status).toBe(200);
    const created = await new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    ).resolveIdentityForPath(newRoot);
    expect(created).not.toBeNull();
    expect(launches).toHaveLength(1);
    expect(server.sessionManager.list()).toEqual([
      expect.objectContaining({
        title: "Plan Agents",
        cwd: newRoot,
        agentMapIdentity: expect.objectContaining({
          projectId: created!.projectId,
        }),
        projectBootstrap: expect.objectContaining({
          projectId: created!.projectId,
        }),
      }),
    ]);
    expect(await exists(markerFile(created!.projectId))).toBe(false);
    expect(await exists(intentFile(created!.projectId))).toBe(true);
  });

  it("defers automatic first-session creation until a local adapter is available", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    server = await startServer({
      port: 0,
      bootToken: "boot-token",
      telemetryOptIn: false,
      identity: null,
      machineId: "machine-1",
      adapters: {},
      stateRoot,
      launchDir: existingRoot,
      webDir,
      autoCreateSession: false,
      loadSystemPrompt: async () => "ordinary coding prompt",
    });

    const response = await request(server, "/settings", {
      method: "PATCH",
      body: JSON.stringify({ recentDirs: [newRoot, existingRoot] }),
    });
    expect(response.status).toBe(200);
    const created = await new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    ).resolveIdentityForPath(newRoot);
    expect(created).not.toBeNull();
    expect(server.sessionManager.list()).toEqual([]);
    expect(await exists(intentFile(created!.projectId))).toBe(true);
    expect(error).toHaveBeenCalledWith(
      "[harness] project bootstrap session start deferred: adapter_unavailable",
    );

    await server.close();
    server = undefined;
    error.mockRestore();
    server = await boot();

    expect(launches).toHaveLength(1);
    expect(server.sessionManager.list()).toEqual([
      expect.objectContaining({
        title: "Plan Agents",
        cwd: newRoot,
        agentMapIdentity: expect.objectContaining({
          projectId: created!.projectId,
        }),
        projectBootstrap: expect.objectContaining({
          projectId: created!.projectId,
        }),
      }),
    ]);
  });

  it("fully closes a post-listen startup failure before rejecting", async () => {
    await fs.mkdir(path.dirname(intentFile(existingProjectId)), {
      recursive: true,
    });
    await fs.writeFile(
      intentFile(existingProjectId),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: existingProjectId,
        userId: "local:machine-1",
        targetSessionId: null,
        status: "scheduled",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      })}\n`,
    );
    let rejectedPort = 0;

    await expect(
      startServer({
        port: 0,
        bootToken: "boot-token",
        telemetryOptIn: false,
        identity: null,
        machineId: "machine-1",
        adapters: { "claude-code": adapter() },
        stateRoot,
        launchDir: existingRoot,
        webDir,
        autoCreateSession: false,
        loadSystemPrompt: async () => "ordinary coding prompt",
        projectBootstrapTestHooks: {
          afterListenBeforeRecovery: (port) => {
            rejectedPort = port;
            throw new Error("simulated post-listen recovery failure");
          },
        },
      }),
    ).rejects.toThrow("simulated post-listen recovery failure");

    expect(rejectedPort).toBeGreaterThan(0);
    const rebound = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(rejectedPort, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      rebound.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(launches).toEqual([]);
    await expect(
      fs.readFile(intentFile(existingProjectId), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ status: "scheduled", targetSessionId: null });
  });

  it("makes concurrent server close calls share one complete teardown", async () => {
    server = await boot();
    const port = server.port;

    await Promise.all([server.close(), server.close(), server.close()]);
    server = undefined;

    const rebound = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      rebound.close((error) => (error ? reject(error) : resolve()));
    });
    expect(launches).toEqual([]);
  });
});
