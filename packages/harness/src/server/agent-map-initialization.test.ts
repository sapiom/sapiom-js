import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { AgentMapProposalService } from "../core/agent-map-proposal-service.js";
import { importStudioComparisonProfile } from "../core/studio-comparison-profile.js";
import { SessionManager } from "../core/session-manager.js";
import {
  parseComparisonArgs,
  prepareComparisonProfile,
} from "../cli/elk-preview.js";
import { recordRecentDir } from "../cli/settings.js";
import type { AppState, HarnessKind } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function snapshot(directory: string) {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      result[path.relative(directory, file)] = (
        await fs.readFile(file)
      ).toString("base64");
    }
  }
  return result;
}

async function verifyInitialization(providerMissing: boolean) {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "startup-map-projects-")),
  );
  const stateRoot = path.join(root, "profile");
  const sourceStateRoot = path.join(root, "desktop");
  const projectRoot = path.join(root, "existing-project");
  const agentRoot = path.join(projectRoot, "research");
  await fs.mkdir(sourceStateRoot);
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "sapiom.json"),
    JSON.stringify({ definitionId: null }),
  );
  await fs.writeFile(
    path.join(agentRoot, "package.json"),
    JSON.stringify({ name: "research" }),
  );
  const source =
    'throw new Error("Never execute discovery evidence"); export const agent = defineAgent({ name: "research", description: "Research topics" });';
  await fs.writeFile(path.join(agentRoot, "index.ts"), source);
  await fs.writeFile(
    path.join(sourceStateRoot, "settings.json"),
    JSON.stringify({ recentDirs: [projectRoot] }),
  );
  const catalog = new StudioProjectCatalog(
    path.join(sourceStateRoot, "studio-projects.json"),
  );
  const savedRoots = [path.join(root, "saved"), path.join(root, "historical")];
  for (const cwd of savedRoots)
    await fs.cp(agentRoot, path.join(cwd, "research"), { recursive: true });
  const projects = (
    await catalog.reconcile(
      [projectRoot, ...savedRoots].map((cwd) => ({ workspaceKey: cwd, cwd })),
    )
  ).projects;
  const project = projects.find(
    (entry) => entry.displayName === "existing-project",
  )!;
  const sourceStore = new AgentMapWorkspaceStore(
    path.join(sourceStateRoot, "agent-map"),
  );
  const proposals = new AgentMapProposalService(sourceStore);
  for (const saved of projects.filter(
    (entry) => entry.projectId !== project.projectId,
  )) {
    const actor = {
      projectId: saved.projectId,
      userId: "author",
      sessionId: "source-session",
    };
    const first = await proposals.propose(actor, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "author",
      operations: [
        {
          kind: "add-node",
          draftRef: "authored",
          node: {
            kind: "agent",
            name: "Authored",
            purpose: "Preserve this map",
            ownerAgent: null,
            contractRefs: [],
          },
        },
      ],
    });
    if (saved.displayName === "historical")
      await proposals.propose(actor, {
        schemaVersion: 1,
        proposalId: first.proposalId,
        expectedVersion: 1,
        requestId: "delete",
        operations: [
          {
            kind: "remove-node",
            nodeId: Object.values(first.allocatedNodeIds)[0]!,
          },
        ],
      });
  }
  const before = await snapshot(sourceStateRoot);
  const sourceFiles = await snapshot(projectRoot);
  const manifest = await importStudioComparisonProfile({
    sourceStateRoot,
    destinationStateRoot: stateRoot,
    projectIds: projects.map((entry) => entry.projectId),
  });
  expect(manifest.published).toBe(true);
  const comparison = await prepareComparisonProfile(
    parseComparisonArgs(["--state-root", stateRoot]),
  );
  await recordRecentDir(
    comparison.launchDir,
    path.join(stateRoot, "settings.json"),
  );
  const createSession = vi.spyOn(SessionManager.prototype, "create");
  const infer = vi
    .spyOn(TaskManager.prototype, "runStructuredInference")
    .mockImplementation(async ({ prompt }) => {
      const evidence = JSON.parse(
        prompt.slice(prompt.lastIndexOf("\n\n") + 2),
      ) as Array<{ agentId: string; name: string }>;
      return {
        nodes: evidence.map((agent) => ({
          ref: agent.agentId,
          kind: "agent",
          agentId: agent.agentId,
          name: agent.name,
          purpose: "Research topics",
          ownerRef: null,
          contractRefs: [`studio-agent:${agent.agentId}`],
        })),
        relationships: [],
      };
    });
  const boot = (availableHarnesses: HarnessKind[] = ["claude-code"]) =>
    startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      availableHarnesses,
      stateRoot,
      launchDir: comparison.launchDir,
      autoCreateSession: false,
      loadSystemPrompt: async () => "",
    });
  const status = async () =>
    (
      await fetch(
        `http://127.0.0.1:${server!.port}/api/projects/${project.projectId}/agent-map/initialization`,
        { headers: { "X-Harness-Token": "test-token" } },
      )
    ).json();
  server = await boot(providerMissing ? [] : ["claude-code"]);
  const state = (await (
    await fetch(`http://127.0.0.1:${server.port}/api/state`, {
      headers: { "X-Harness-Token": "test-token" },
    })
  ).json()) as AppState;
  expect(state.studioProjects?.map((entry) => entry.projectId).sort()).toEqual(
    projects.map((entry) => entry.projectId).sort(),
  );
  if (providerMissing) {
    const session = await fetch(
      `http://127.0.0.1:${server.port}/api/sessions`,
      {
        method: "POST",
        headers: {
          "X-Harness-Token": "test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cwd: comparison.launchDir,
          harness: "claude-code",
        }),
      },
    );
    expect(session.status).toBe(503);
    expect(await session.json()).toMatchObject({
      code: "provider_unavailable",
      error: expect.stringContaining("Install and authenticate"),
    });
    await vi.waitFor(
      async () =>
        expect(await status()).toMatchObject({
          status: "failed",
          errorCode: "provider_unavailable",
          retryable: true,
        }),
      { timeout: 10000 },
    );
    expect(infer).not.toHaveBeenCalled();
    await server.close();
    server = await boot();
    expect(await status()).toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(infer).not.toHaveBeenCalled();
    const retry = await fetch(
      `http://127.0.0.1:${server.port}/api/projects/${project.projectId}/agent-map/initialization/retry`,
      { method: "POST", headers: { "X-Harness-Token": "test-token" } },
    );
    expect(retry.status).toBe(202);
  }
  const store = new AgentMapWorkspaceStore(path.join(stateRoot, "agent-map"));
  await vi.waitFor(
    async () => {
      const map = await store.readSnapshot(project.projectId);
      expect(map.proposal?.nodes).toHaveLength(1);
    },
    { timeout: 10000 },
  );
  expect(infer).toHaveBeenCalledOnce();
  expect(createSession).not.toHaveBeenCalled();
  expect(server.sessionManager.list()).toHaveLength(0);
  for (const saved of manifest.projects.filter(
    (entry) => entry.map?.authored,
  )) {
    const file = path.join(
      "agent-map",
      "projects",
      saved.projectId,
      "workspace.json",
    );
    expect(
      (await fs.readFile(path.join(stateRoot, file))).toString("base64"),
    ).toBe(before[file]);
  }
  expect(await snapshot(sourceStateRoot)).toEqual(before);
  expect(await snapshot(projectRoot)).toEqual(sourceFiles);
  expect(await fs.readFile(path.join(agentRoot, "index.ts"), "utf8")).toBe(
    source,
  );
  await server.close();
  server = await boot();
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/projects/${project.projectId}/agent-map/initialization`,
    {
      headers: { "X-Harness-Token": "test-token" },
    },
  );
  expect(await response.json()).toMatchObject({
    status: "completed",
    retryable: false,
  });
  await server.close();
  server = undefined;
  expect(infer).toHaveBeenCalledOnce();
  expect(createSession).not.toHaveBeenCalled();
}

it.each([false, true])(
  "preserves imported authored maps and initializes only mapless projects without sessions (provider missing: %s)",
  verifyInitialization,
  30000,
);
