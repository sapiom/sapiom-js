import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";

import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import type { AppState } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

it("publishes one project-owned scope for a symlink alias of its canonical root", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-workspace-alias-"));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  const alias = path.join(root, "project-alias");
  await fs.mkdir(stateRoot);
  await fs.mkdir(projectRoot);
  await fs.symlink(projectRoot, alias, "dir");
  const catalog = new StudioProjectCatalog(path.join(stateRoot, "studio-projects.json"));
  const project = (await catalog.reconcile([{ workspaceKey: "seed", cwd: projectRoot }])).projects[0]!;
  await fs.writeFile(path.join(stateRoot, "sessions.json"), JSON.stringify([{
    id: "retained-session", agentSessionId: null, harness: "claude-code",
    cwd: alias, title: "Retained conversation", status: "exited",
    createdAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-02T00:00:00.000Z",
    exitCode: 0, boundWorkflowPath: null, ready: false,
    agentMapIdentity: { projectId: project.projectId, userId: "local:machine-1", sessionId: "retained-session" },
  }]));
  await fs.writeFile(
    path.join(stateRoot, "settings.json"),
    JSON.stringify({ recentDirs: [projectRoot] }),
  );
  server = await startServer({
    port: 0,
    bootToken: "test-token",
    telemetryOptIn: false,
    machineId: "machine-1",
    adapters: {},
    stateRoot,
    launchDir: alias,
    autoCreateSession: false,
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/state`, {
    headers: { "X-Harness-Token": "test-token" },
  });
  expect(response.status).toBe(200);
  const state = await response.json() as AppState;
  const scopes = state.workspaceScopes ?? [];
  expect(state.studioProjects).toHaveLength(1);
  expect(new Set(scopes.map((scope) => scope.workspaceKey)).size).toBe(scopes.length);
  const roots = await Promise.all(scopes.map(async (scope) => ({
    scope, canonical: await fs.realpath(scope.cwd),
  })));
  const projectScopes = roots.filter(({ canonical }) => canonical === projectRoot);
  expect(projectScopes).toHaveLength(1);
  expect(projectScopes[0]?.scope.projectId).toBe(project.projectId);
});
