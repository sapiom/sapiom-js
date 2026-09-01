import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  StudioCurrentWorkspaceResponse,
  StudioProjectSummary,
} from "../shared/agent-map.js";
import type { AppState } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

describe("real Studio workspace wiring", () => {
  let root: string | undefined;
  let server: HarnessServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("publishes opaque AppState bindings and restores one across a null-definition move and restart", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-workspace-wiring-"));
    const stateRoot = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    const originalAgent = path.join(projectRoot, "agents", "planner");
    const movedAgent = path.join(projectRoot, "planner");
    await fs.mkdir(originalAgent, { recursive: true });
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(
      path.join(originalAgent, "sapiom.json"),
      JSON.stringify({ definitionId: null }),
    );
    await fs.writeFile(
      path.join(originalAgent, "package.json"),
      JSON.stringify({ name: "planner" }),
    );
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [projectRoot] }),
    );

    const start = async (): Promise<HarnessServer> =>
      startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: {},
        stateRoot,
        launchDir: projectRoot,
        autoCreateSession: false,
      });
    const headers = {
      "Content-Type": "application/json",
      "X-Harness-Token": "test-token",
    };
    server = await start();
    let baseUrl = `http://127.0.0.1:${server.port}`;
    expect(
      (
        await fetch(`${baseUrl}/api/workflows/scan`, {
          method: "POST",
          headers,
          body: JSON.stringify({ root: projectRoot }),
        })
      ).status,
    ).toBe(200);

    const state = (await (
      await fetch(`${baseUrl}/api/state`, { headers })
    ).json()) as AppState;
    const project = state.studioProjects?.[0] as
      | StudioProjectSummary
      | undefined;
    const workflow = state.workflows.find(
      (candidate) => candidate.path === originalAgent,
    );
    const binding = workflow?.studioBindings?.find(
      (candidate) => candidate.projectId === project?.projectId,
    );
    expect(project).toBeDefined();
    expect(binding?.agentId).toMatch(/^agent_/);
    expect(JSON.stringify(workflow?.studioBindings)).not.toContain(projectRoot);

    const route = `${baseUrl}/api/projects/${project!.projectId}/current-workspace`;
    const selected = (await (
      await fetch(route, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          selection: {
            kind: "agent",
            projectId: project!.projectId,
            agentId: binding!.agentId,
          },
        }),
      })
    ).json()) as StudioCurrentWorkspaceResponse;
    expect(selected.selection).toMatchObject({
      kind: "agent",
      agentId: binding!.agentId,
    });

    const move = await fetch(`${baseUrl}/api/agents/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: originalAgent, to: movedAgent }),
    });
    expect(move.status).toBe(200);
    const movedState = (await (
      await fetch(`${baseUrl}/api/state`, { headers })
    ).json()) as AppState;
    expect(
      movedState.workflows
        .find((candidate) => candidate.path === movedAgent)
        ?.studioBindings?.find(
          (candidate) => candidate.projectId === project!.projectId,
        )?.agentId,
    ).toBe(binding!.agentId);

    await server.close();
    server = await start();
    baseUrl = `http://127.0.0.1:${server.port}`;
    const restored = (await (
      await fetch(
        `${baseUrl}/api/projects/${project!.projectId}/current-workspace`,
        { headers },
      )
    ).json()) as StudioCurrentWorkspaceResponse;
    expect(restored.selection).toEqual({
      kind: "agent",
      projectId: project!.projectId,
      agentId: binding!.agentId,
    });
  });
});
