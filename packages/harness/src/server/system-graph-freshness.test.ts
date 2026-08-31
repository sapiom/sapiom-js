import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { AppState, BusMessage, WorkflowInfo } from "../shared/types.js";
import type { SystemGraphSnapshot } from "../shared/system-graph.js";
import { startServer, type HarnessServer } from "./index.js";

async function scaffoldAgent(
  workspaceRoot: string,
  name: string,
  source = "export {};\n",
): Promise<string> {
  const agentRoot = path.join(workspaceRoot, name);
  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, "sapiom.json"),
    JSON.stringify({ name, definitionId: null }),
  );
  await fs.writeFile(path.join(agentRoot, "index.ts"), source);
  return agentRoot;
}

function installedAgentSource(name: string, target?: string): string {
  const invocation = target
    ? `await ctx.sapiom.agents.run({ definition: ${JSON.stringify(target)} });`
    : "";
  return `import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const run = defineStep({
  name: "run",
  next: [],
  terminal: true,
  async run(input, ctx) {
    ${invocation}
    return terminate({});
  },
});

export default defineAgent({ name: ${JSON.stringify(name)}, entry: "run", steps: { run } });
`;
}

describe("workspace graph freshness wiring", () => {
  let tempRoot: string;
  let stateRoot: string;
  let workspaceRoot: string;
  let server: HarnessServer | undefined;
  let socket: WebSocket | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "system-graph-freshness-"),
    );
    stateRoot = path.join(tempRoot, "state");
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [workspaceRoot] }),
    );
  });

  afterEach(async () => {
    socket?.close();
    await server?.close();
    server = undefined;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it(
    "refreshes source relationships and agent inventory without a session",
    { retry: 1, timeout: 30_000 },
    async () => {
      const researchRoot = await scaffoldAgent(workspaceRoot, "research");
      await scaffoldAgent(workspaceRoot, "growth");
      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: {},
        stateRoot,
        launchDir: workspaceRoot,
        autoCreateSession: false,
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = { "X-Harness-Token": "test-token" };

      await vi.waitFor(
        async () => {
          const response = await fetch(`${baseUrl}/api/workflows`, { headers });
          const workflows = (await response.json()) as WorkflowInfo[];
          expect(
            workflows.map((workflow) => workflow.definitionSlug).sort(),
          ).toEqual(["growth", "research"]);
        },
        { timeout: 8_000, interval: 150 },
      );

      const stateResponse = await fetch(`${baseUrl}/api/state`, { headers });
      const state = (await stateResponse.json()) as AppState;
      const workspaceKey = state.workspaceScopes?.find(
        (scope) => scope.cwd === workspaceRoot,
      )?.workspaceKey;
      expect(workspaceKey).toBeTruthy();
      const graphUrl = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;

      const graphEvents: Array<
        Extract<BusMessage, { type: "system-graph.changed" }>
      > = [];
      socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/events?token=test-token`,
      );
      await new Promise<void>((resolve, reject) => {
        socket!.once("open", resolve);
        socket!.once("error", reject);
      });
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as BusMessage;
        if (message.type === "system-graph.changed") graphEvents.push(message);
      });

      const readGraph = async (): Promise<SystemGraphSnapshot> => {
        const response = await fetch(graphUrl, { headers });
        expect(response.status).toBe(200);
        const raw = await response.text();
        expect(raw).not.toContain(workspaceRoot);
        return JSON.parse(raw) as SystemGraphSnapshot;
      };
      const initial = await readGraph();
      // These fixtures intentionally have no defineAgent export. The graph is
      // useful immediately through their marker identities while background
      // source inspection honestly leaves the inventory degraded.
      expect(initial).toMatchObject({ state: "degraded" });
      expect(initial.graph?.edges).toEqual([]);
      let absentSettled!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          absentSettled = await readGraph();
          expect(absentSettled.revision).toBeGreaterThan(initial.revision);
          expect(
            absentSettled.graph?.warnings.some(
              (warning) => warning.code === "inventory-extraction-failed",
            ),
          ).toBe(false);
        },
        { timeout: 8_000, interval: 150 },
      );
      graphEvents.length = 0;

      await fs.writeFile(
        path.join(researchRoot, "index.ts"),
        'ctx.sapiom.agents.run({ definition: "growth" });\n',
      );
      let sourceRefresh!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          sourceRefresh = await readGraph();
          expect(sourceRefresh.revision).toBeGreaterThan(initial.revision);
          expect(sourceRefresh.state).toBe("degraded");
          expect(sourceRefresh.graph?.edges).toEqual([
            expect.objectContaining({
              from: "agent:research",
              to: "agent:growth",
              mode: "blocking",
            }),
          ]);
        },
        { timeout: 8_000, interval: 150 },
      );
      expect(graphEvents.some((event) => event.state === "stale")).toBe(true);
      expect(graphEvents.some((event) => event.state === "degraded")).toBe(
        true,
      );

      await fs.writeFile(path.join(researchRoot, "index.ts"), "export {};\n");
      let sourceRemoved!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          sourceRemoved = await readGraph();
          expect(sourceRemoved.revision).toBeGreaterThan(
            sourceRefresh.revision,
          );
          expect(sourceRemoved.graph?.edges).toEqual([]);
        },
        { timeout: 8_000, interval: 150 },
      );

      const reportingRoot = await scaffoldAgent(workspaceRoot, "reporting");
      let added!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          added = await readGraph();
          expect(added.revision).toBeGreaterThan(sourceRemoved.revision);
          expect(
            added.graph?.nodes.some((node) => node.agentKey === "reporting"),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 150 },
      );

      const insightsRoot = path.join(workspaceRoot, "insights");
      await fs.rename(reportingRoot, insightsRoot);
      await fs.writeFile(
        path.join(insightsRoot, "sapiom.json"),
        JSON.stringify({ name: "insights", definitionId: null }),
      );
      await fs.writeFile(
        path.join(insightsRoot, "index.ts"),
        'ctx.sapiom.agents.run({ definition: "growth" });\n',
      );
      let renamed!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          renamed = await readGraph();
          expect(renamed.revision).toBeGreaterThan(added.revision);
          expect(
            renamed.graph?.nodes.some((node) => node.agentKey === "reporting"),
          ).toBe(false);
          expect(
            renamed.graph?.edges.some(
              (edge) =>
                edge.from === "agent:insights" && edge.to === "agent:growth",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 150 },
      );

      await fs.writeFile(
        path.join(insightsRoot, "sapiom.json"),
        JSON.stringify({ name: "insights-v2", definitionId: null }),
      );
      let renamedSlug!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          renamedSlug = await readGraph();
          expect(renamedSlug.revision).toBeGreaterThan(renamed.revision);
          expect(
            renamedSlug.graph?.edges.some(
              (edge) =>
                edge.from === "agent:insights-v2" && edge.to === "agent:growth",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 150 },
      );

      await fs.rm(insightsRoot, { recursive: true, force: true });
      await vi.waitFor(
        async () => {
          const removed = await readGraph();
          expect(removed.revision).toBeGreaterThan(renamedSlug.revision);
          expect(
            removed.graph?.nodes.some(
              (node) => node.agentKey === "insights-v2",
            ),
          ).toBe(false);
        },
        { timeout: 8_000, interval: 150 },
      );

      const beforeManualRetry = await readGraph();
      const manualRetryResponse = await fetch(`${graphUrl}/refresh`, {
        method: "POST",
        headers,
      });
      expect(manualRetryResponse.status).toBe(200);
      const manualRetry =
        (await manualRetryResponse.json()) as SystemGraphSnapshot;
      // Manual Retry does not unset identities already proven absent. It
      // rebuilds the graph, but the settled inventory remains cacheable.
      expect(manualRetry).toMatchObject({ state: "ready" });
      expect(manualRetry.revision).toBeGreaterThan(beforeManualRetry.revision);
    },
  );

  it(
    "registers each agent once when the launch directory is a symlink",
    { timeout: 30_000 },
    async () => {
      // The registry keys rows by path. Boot scanned the launch directory as
      // given while the first graph open scanned its resolved form, so every
      // agent registered twice; the duplicates collided into `local:` fallback
      // keys and each cross-agent target became ambiguous, dropping its edge.
      // macOS hits this on any `os.tmpdir()` path (`/var` -> `/private/var`).
      await fs.symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(workspaceRoot, "node_modules"),
        "dir",
      );
      await scaffoldAgent(
        workspaceRoot,
        "research",
        installedAgentSource("research", "growth"),
      );
      await scaffoldAgent(
        workspaceRoot,
        "growth",
        installedAgentSource("growth"),
      );
      const linkedRoot = path.join(tempRoot, "linked-workspace");
      await fs.symlink(workspaceRoot, linkedRoot, "dir");
      await fs.writeFile(
        path.join(stateRoot, "settings.json"),
        JSON.stringify({ recentDirs: [linkedRoot] }),
      );

      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: {},
        stateRoot,
        launchDir: linkedRoot,
        autoCreateSession: false,
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = { "X-Harness-Token": "test-token" };

      await vi.waitFor(
        async () => {
          const response = await fetch(`${baseUrl}/api/workflows`, { headers });
          const workflows = (await response.json()) as WorkflowInfo[];
          expect(workflows).toHaveLength(2);
        },
        { timeout: 8_000, interval: 150 },
      );

      const state = (await (
        await fetch(`${baseUrl}/api/state`, { headers })
      ).json()) as AppState;
      const workspaceKey = state.workspaceScopes?.[0]?.workspaceKey;
      expect(workspaceKey).toBeTruthy();

      const readGraph = async (): Promise<SystemGraphSnapshot> =>
        (await (
          await fetch(`${baseUrl}/api/workspaces/${workspaceKey}/system-graph`, {
            headers,
          })
        ).json()) as SystemGraphSnapshot;

      await vi.waitFor(
        async () => {
          expect((await readGraph()).state).toBe("ready");
        },
        { timeout: 8_000, interval: 150 },
      );

      // The duplicate rows only appear once a SECOND scan runs under the
      // resolved spelling, which is what a graph refresh does. Adding an agent
      // is the cheapest way to make the watcher trigger one.
      await scaffoldAgent(workspaceRoot, "reporting");
      await vi.waitFor(
        async () => {
          const graph = await readGraph();
          expect(graph.graph?.nodes.map((node) => node.agentKey)).toEqual([
            "growth",
            "reporting",
            "research",
          ]);
          expect(graph.graph?.warnings).toEqual([]);
          expect(graph.graph?.edges).toEqual([
            expect.objectContaining({
              from: "agent:research",
              to: "agent:growth",
            }),
          ]);
        },
        { timeout: 10_000, interval: 150 },
      );
    },
  );
});
