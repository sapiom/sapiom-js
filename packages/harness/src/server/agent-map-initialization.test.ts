import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StudioProjectCatalog } from "../core/studio-project-catalog.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentMapWorkspaceStore } from "../core/agent-map-workspace-store.js";
import { startServer, type HarnessServer } from "./index.js";

let root: string | undefined;
let server: HarnessServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("discovers restored projects outside the desktop launch directory and initializes once without navigation", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "startup-map-projects-"));
  const stateRoot = path.join(root, "profile");
  const projectRoot = path.join(root, "existing-project");
  const agentRoot = path.join(projectRoot, "research");
  await fs.mkdir(stateRoot);
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
    path.join(stateRoot, "settings.json"),
    JSON.stringify({ recentDirs: [projectRoot] }),
  );
  const catalog = new StudioProjectCatalog(
    path.join(stateRoot, "studio-projects.json"),
  );
  const project = (
    await catalog.reconcile([{ workspaceKey: "existing", cwd: projectRoot }])
  ).projects[0]!;
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
  const boot = () =>
    startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      availableHarnesses: ["claude-code"],
      stateRoot,
      launchDir: stateRoot,
      projectRoot: path.join(stateRoot, "projects"),
      autoCreateSession: false,
      loadSystemPrompt: async () => "",
    });
  server = await boot();
  const store = new AgentMapWorkspaceStore(path.join(stateRoot, "agent-map"));
  await vi.waitFor(
    async () => {
      const map = await store.readSnapshot(project.projectId);
      expect(map.proposal?.nodes).toHaveLength(1);
    },
    { timeout: 10000 },
  );
  expect(infer).toHaveBeenCalledOnce();
  expect(server.sessionManager.list()).toHaveLength(0);
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
}, 20000);
