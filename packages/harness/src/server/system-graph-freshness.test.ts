import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type {
  AppState,
  BusMessage,
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
  WorkflowInfo,
} from "../shared/types.js";
import type { SystemGraphSnapshot } from "../shared/system-graph.js";
import type { RegistryWorkflowInfo } from "../core/workflow-registry.js";
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

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeClaudeAdapter(): HarnessAdapter {
  const spec = (options: LaunchOpts): SpawnSpec => ({
    command: "bash",
    args: [],
    env: {},
    cwd: options.cwd,
  });
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: spec,
    resume: (_agentSessionId, options) => spec(options),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
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
    await server?.sessionManager.flush();
    await server?.close();
    server = undefined;
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  it(
    "refreshes source invocations and agent inventory without a session",
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
      // Cold discovery is detached: cached inventory renders immediately,
      // conservatively degraded until this process accepts fresh evidence.
      expect(initial.state).toBe("degraded");
      expect(initial.graph?.nodes.map((node) => node.agentKey).sort()).toEqual([
        "growth",
        "research",
      ]);
      let absentSettled!: SystemGraphSnapshot;
      await vi.waitFor(
        async () => {
          absentSettled = await readGraph();
          expect(absentSettled.revision).toBeGreaterThan(initial.revision);
          expect(absentSettled.state).toBe("degraded");
          expect(absentSettled.graph?.edges).toEqual([]);
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
      // Manual Retry rebuilds immediately from accepted inventory, then direct
      // invocation extraction completes in the background.
      expect(manualRetry).toMatchObject({ state: "degraded" });
      expect(manualRetry.revision).toBeGreaterThan(beforeManualRetry.revision);
    },
  );

  it("serves persisted cold inventory without awaiting discovery", async () => {
    const within = async <T>(promise: Promise<T>, label: string): Promise<T> =>
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`timed out: ${label}`)), 1_000);
        }),
      ]);
    const coldRoot = await scaffoldAgent(workspaceRoot, "cold");
    await fs.writeFile(
      path.join(stateRoot, "workflows.json"),
      JSON.stringify([
        {
          name: "cold",
          path: coldRoot,
          definitionId: null,
          definitionSlug: "cold",
          templateId: null,
          forkId: null,
          starterId: null,
          activeBuildRunId: null,
          activeBuildRunStatus: null,
          markerPresent: true,
          source: "scan",
        } satisfies RegistryWorkflowInfo,
      ]),
    );
    const scanGate = deferred();
    const scanEntered = deferred();
    let blockFirstScan = true;
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir: workspaceRoot,
      autoCreateSession: false,
      workflowDiscoveryTestHooks: {
        beforeScan: async () => {
          if (!blockFirstScan) return;
          blockFirstScan = false;
          scanEntered.resolve();
          await scanGate.promise;
        },
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = { "X-Harness-Token": "test-token" };
    await within(scanEntered.promise, "scan entry");
    const state = (await (
      await within(fetch(`${baseUrl}/api/state`, { headers }), "state")
    ).json()) as AppState;
    const workspaceKey = state.workspaceScopes?.find(
      (scope) => scope.cwd === workspaceRoot,
    )?.workspaceKey;
    expect(workspaceKey).toBeTruthy();
    const response = await within(
      fetch(`${baseUrl}/api/workspaces/${workspaceKey}/system-graph`, {
        headers,
      }),
      "graph",
    );
    expect(response.status).toBe(200);
    const cached = (await response.json()) as SystemGraphSnapshot;
    expect(cached.state).toBe("degraded");
    expect(cached.graph?.nodes.some((node) => node.agentKey === "cold")).toBe(
      true,
    );

    scanGate.resolve();
    const acceptedScan = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(acceptedScan.status).toBe(200);
    await within(
      vi.waitFor(async () => {
        const settled = (await (
          await fetch(
            `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`,
            { headers },
          )
        ).json()) as SystemGraphSnapshot;
        expect(settled.graph?.nodes).toHaveLength(1);
      }),
      "settled graph",
    );
  });

  it("supersedes a paused publication and commits only the newest scan", async () => {
    const agentRoot = await scaffoldAgent(workspaceRoot, "initial");
    const publicationGate = deferred();
    const publicationEntered = deferred();
    let blockNextPublication = false;
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir: workspaceRoot,
      autoCreateSession: false,
      workflowDiscoveryTestHooks: {
        beforePublication: async () => {
          if (!blockNextPublication) return;
          blockNextPublication = false;
          publicationEntered.resolve();
          await publicationGate.promise;
        },
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    await vi.waitFor(async () => {
      const workflows = (await (
        await fetch(`${baseUrl}/api/workflows`, { headers })
      ).json()) as WorkflowInfo[];
      expect(workflows[0]?.definitionSlug).toBe("initial");
    });
    blockNextPublication = true;
    await fs.writeFile(
      path.join(agentRoot, "sapiom.json"),
      JSON.stringify({ name: "intermediate", definitionId: null }),
    );
    const first = fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    await publicationEntered.promise;

    await fs.writeFile(
      path.join(agentRoot, "sapiom.json"),
      JSON.stringify({ name: "newest", definitionId: null }),
    );
    const second = fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    publicationGate.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const workflows = (await (
      await fetch(`${baseUrl}/api/workflows`, { headers })
    ).json()) as WorkflowInfo[];
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.definitionSlug).toBe("newest");
  });

  it("uses fresh source and project budgets for a generation superseded after scanning", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "index.ts"),
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "budget-v1" });`,
    );
    const scanReturned = deferred();
    const releaseScan = deferred();
    let blockNextRequestedResult = false;
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir: workspaceRoot,
      autoCreateSession: false,
      workflowDiscoveryTestHooks: {
        afterScan: async ({ reason }) => {
          if (!blockNextRequestedResult || reason !== "requested") return;
          blockNextRequestedResult = false;
          scanReturned.resolve();
          await releaseScan.promise;
        },
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    await vi.waitFor(async () => {
      expect(
        (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[],
      ).toHaveLength(1);
    });
    const state = (await (
      await fetch(`${baseUrl}/api/state`, { headers })
    ).json()) as AppState;
    const workspaceKey = state.workspaceScopes?.find(
      (scope) => scope.cwd === workspaceRoot,
    )?.workspaceKey;
    expect(workspaceKey).toBeTruthy();
    const graphUrl = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    await fetch(graphUrl, { headers });

    blockNextRequestedResult = true;
    const first = fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    await scanReturned.promise;
    await fs.writeFile(
      path.join(workspaceRoot, "index.ts"),
      `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "budget-v2-final" });`,
    );
    const second = fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    releaseScan.resolve();
    expect(
      (await Promise.all([first, second])).map((response) => response.status),
    ).toEqual([200, 200]);
    await vi.waitFor(async () => {
      const snapshot = (await (
        await fetch(graphUrl, { headers })
      ).json()) as SystemGraphSnapshot;
      expect(snapshot.graph?.nodes.map((node) => node.agentKey)).toEqual([
        "budget-v2-final",
      ]);
    });
  });

  it("lets an ordinary first graph scan release a failed dirty prerequisite", async () => {
    await scaffoldAgent(workspaceRoot, "recoverable");
    let failuresRemaining = 0;
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir: workspaceRoot,
      autoCreateSession: false,
      workflowDiscoveryTestHooks: {
        beforeScan: () => {
          if (failuresRemaining <= 0) return;
          failuresRemaining -= 1;
          throw new Error("held dirty reconciliation failed");
        },
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    await vi.waitFor(async () => {
      const workflows = (await (
        await fetch(`${baseUrl}/api/workflows`, { headers })
      ).json()) as WorkflowInfo[];
      expect(workflows.map((workflow) => workflow.definitionSlug)).toEqual([
        "recoverable",
      ]);
    });
    const state = (await (
      await fetch(`${baseUrl}/api/state`, { headers })
    ).json()) as AppState;
    const workspaceKey = state.workspaceScopes?.find(
      (scope) => scope.cwd === workspaceRoot,
    )?.workspaceKey;
    expect(workspaceKey).toBeTruthy();

    failuresRemaining = 4;
    const failed = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(failed.status).toBe(500);
    expect(failuresRemaining).toBe(0);

    const graphUrl = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    // The first GET attaches the prior dirty token before it starts the
    // ordinary background recovery scan. It may initially be building, but
    // the accepted exact-root proof must release that inherited token.
    await fetch(graphUrl, { headers });
    await vi.waitFor(
      async () => {
        const response = await fetch(graphUrl, { headers });
        const snapshot = (await response.json()) as SystemGraphSnapshot;
        expect(snapshot.state).not.toBe("building");
        expect(
          snapshot.graph?.nodes.some((node) => node.agentKey === "recoverable"),
        ).toBe(true);
      },
      { timeout: 8_000, interval: 100 },
    );
  });

  it(
    "coalesces two sessions and a graph subscriber into one pass plus one held-edit trailing pass",
    { timeout: 25_000 },
    async () => {
      await fs.writeFile(
        path.join(workspaceRoot, "index.ts"),
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "shared-v0" });`,
      );
      const firstPassEntered = deferred();
      const releaseFirstPass = deferred();
      let observePasses = false;
      let passCount = 0;
      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: { "claude-code": fakeClaudeAdapter() },
        stateRoot,
        launchDir: workspaceRoot,
        autoCreateSession: false,
        workflowDiscoveryTestHooks: {
          beforeScan: async ({ root }) => {
            if (!observePasses || path.resolve(root) !== workspaceRoot) return;
            passCount += 1;
            if (passCount !== 1) return;
            firstPassEntered.resolve();
            await releaseFirstPass.promise;
          },
        },
      });
      const headers = { "X-Harness-Token": "test-token" };
      const baseUrl = `http://127.0.0.1:${server.port}`;
      await server.sessionManager.create({
        cwd: workspaceRoot,
        harness: "claude-code",
      });
      await server.sessionManager.create({
        cwd: workspaceRoot,
        harness: "claude-code",
      });
      const state = (await (
        await fetch(`${baseUrl}/api/state`, { headers })
      ).json()) as AppState;
      const workspaceKey = state.workspaceScopes?.find(
        (scope) => scope.cwd === workspaceRoot,
      )?.workspaceKey;
      expect(workspaceKey).toBeTruthy();
      await fetch(`${baseUrl}/api/workspaces/${workspaceKey}/system-graph`, {
        headers,
      });

      // Let the shared broker's one conservative initial reconciliation drain
      // before counting the edit under test.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      observePasses = true;
      await fs.writeFile(
        path.join(workspaceRoot, "index.ts"),
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "shared-v1" });`,
      );
      await firstPassEntered.promise;

      // A second save while the first registry pass is held must supersede it
      // immediately. The overlapping source callback reaches the coordinator
      // without waiting behind the older subscriber fanout.
      await fs.writeFile(
        path.join(workspaceRoot, "index.ts"),
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "shared-v2-final" });`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      releaseFirstPass.resolve();

      await vi.waitFor(() => expect(passCount).toBe(2), {
        timeout: 8_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      expect(passCount).toBe(2);
    },
  );

  it.each(["graph-first", "session-first"] as const)(
    "reconciles a newly foreign repository from the parent regardless of %s subscriber order",
    async (subscriberOrder) => {
      const checkout = path.join(workspaceRoot, "checkout");
      await fs.mkdir(checkout, { recursive: true });
      await fs.writeFile(
        path.join(checkout, "index.ts"),
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "checkout-agent" });`,
      );
      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: { "claude-code": fakeClaudeAdapter() },
        stateRoot,
        launchDir: workspaceRoot,
        autoCreateSession: false,
      });
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        "X-Harness-Token": "test-token",
        "Content-Type": "application/json",
      };
      await vi.waitFor(async () => {
        const workflows = (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[];
        expect(workflows.map((workflow) => workflow.path)).toEqual([checkout]);
      });
      const state = (await (
        await fetch(`${baseUrl}/api/state`, { headers })
      ).json()) as AppState;
      const workspaceKey = state.workspaceScopes?.find(
        (scope) => scope.cwd === workspaceRoot,
      )?.workspaceKey;
      expect(workspaceKey).toBeTruthy();
      const startGraph = () =>
        fetch(`${baseUrl}/api/workspaces/${workspaceKey}/system-graph`, {
          headers,
        });
      const startSession = () =>
        server!.sessionManager.create({
          cwd: workspaceRoot,
          harness: "claude-code",
        });
      if (subscriberOrder === "graph-first") {
        await startGraph();
        await startSession();
      } else {
        await startSession();
        await startGraph();
      }
      await new Promise((resolve) => setTimeout(resolve, 2_500));

      await fs.mkdir(path.join(checkout, ".git"));
      await vi.waitFor(
        async () => {
          const workflows = (await (
            await fetch(`${baseUrl}/api/workflows`, { headers })
          ).json()) as WorkflowInfo[];
          expect(workflows).toEqual([]);
        },
        { timeout: 8_000, interval: 100 },
      );

      const direct = await fetch(`${baseUrl}/api/workflows/scan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ root: checkout }),
      });
      expect(direct.status).toBe(200);
      await vi.waitFor(async () => {
        const workflows = (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[];
        expect(workflows.map((workflow) => workflow.path)).toEqual([checkout]);
      });
    },
    20_000,
  );

  it(
    "keeps staged session contexts invisible when publication is superseded and commits only the newest rows",
    { timeout: 20_000 },
    async () => {
      await scaffoldAgent(workspaceRoot, "initial");
      const stagingEntered = deferred();
      const releaseStaging = deferred();
      let blockNextStaging = false;
      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: { "claude-code": fakeClaudeAdapter() },
        stateRoot,
        launchDir: workspaceRoot,
        autoCreateSession: false,
        workflowDiscoveryTestHooks: {
          afterContextStaging: async () => {
            if (!blockNextStaging) return;
            blockNextStaging = false;
            stagingEntered.resolve();
            await releaseStaging.promise;
          },
        },
      });
      const sessionRoots = [
        path.join(workspaceRoot, "session-a"),
        path.join(workspaceRoot, "session-b"),
      ];
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        "X-Harness-Token": "test-token",
        "Content-Type": "application/json",
      };
      await vi.waitFor(async () => {
        const workflows = (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[];
        expect(workflows.map((workflow) => workflow.name)).toEqual(["initial"]);
      });
      await Promise.all(
        sessionRoots.map((root) => fs.mkdir(root, { recursive: true })),
      );
      await Promise.all(
        sessionRoots.map((cwd) =>
          server!.sessionManager.create({ cwd, harness: "claude-code" }),
        ),
      );
      const readAgentNames = async (cwd: string): Promise<string[]> => {
        const context = JSON.parse(
          await fs.readFile(
            path.join(cwd, ".sapiom", "harness-context.json"),
            "utf8",
          ),
        ) as { agents: Array<{ name: string }> };
        return context.agents.map((agent) => agent.name).sort();
      };
      await vi.waitFor(async () => {
        for (const cwd of sessionRoots) {
          expect(await readAgentNames(cwd)).toEqual(["initial"]);
        }
      });

      const intermediate = await scaffoldAgent(workspaceRoot, "intermediate");
      blockNextStaging = true;
      const first = fetch(`${baseUrl}/api/workflows/scan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ root: workspaceRoot }),
      });
      await stagingEntered.promise;
      for (const cwd of sessionRoots) {
        expect(await readAgentNames(cwd)).toEqual(["initial"]);
      }

      await fs.rm(intermediate, { recursive: true, force: true });
      await scaffoldAgent(workspaceRoot, "newest");
      const second = fetch(`${baseUrl}/api/workflows/scan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ root: workspaceRoot }),
      });
      releaseStaging.resolve();
      expect(
        (await Promise.all([first, second])).map((response) => response.status),
      ).toEqual([200, 200]);

      await vi.waitFor(async () => {
        const workflows = (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[];
        expect(workflows.map((workflow) => workflow.name).sort()).toEqual([
          "initial",
          "newest",
        ]);
        for (const cwd of sessionRoots) {
          expect(await readAgentNames(cwd)).toEqual(["initial", "newest"]);
        }
      });
    },
  );

  it("publishes globally when one active session context cannot be staged", async () => {
    await scaffoldAgent(workspaceRoot, "initial");
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: { "claude-code": fakeClaudeAdapter() },
      stateRoot,
      launchDir: workspaceRoot,
      autoCreateSession: false,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    await vi.waitFor(async () => {
      expect(
        (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[],
      ).toHaveLength(1);
    });
    const goodCwd = path.join(workspaceRoot, "good-session");
    const badCwd = path.join(workspaceRoot, "bad-session");
    await Promise.all([
      fs.mkdir(goodCwd, { recursive: true }),
      fs.mkdir(badCwd, { recursive: true }),
    ]);
    await Promise.all([
      server.sessionManager.create({ cwd: goodCwd, harness: "claude-code" }),
      server.sessionManager.create({ cwd: badCwd, harness: "claude-code" }),
    ]);
    await fs.rm(path.join(badCwd, ".sapiom"), {
      recursive: true,
      force: true,
    });
    await fs.writeFile(path.join(badCwd, ".sapiom"), "blocked");

    await scaffoldAgent(workspaceRoot, "newest");
    const response = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(response.status).toBe(200);
    const goodContext = JSON.parse(
      await fs.readFile(
        path.join(goodCwd, ".sapiom", "harness-context.json"),
        "utf8",
      ),
    ) as { agents: Array<{ name: string }> };
    expect(goodContext.agents.map((agent) => agent.name).sort()).toEqual([
      "initial",
      "newest",
    ]);
    const workflows = (await (
      await fetch(`${baseUrl}/api/workflows`, { headers })
    ).json()) as WorkflowInfo[];
    expect(workflows.map((workflow) => workflow.name).sort()).toEqual([
      "initial",
      "newest",
    ]);
  });

  it("does not re-promote evidence from a publication paused across the last watch lease", async () => {
    const agentRoot = await scaffoldAgent(workspaceRoot, "offline-edit");
    const publicationGate = deferred();
    const publicationEntered = deferred();
    const reopenScanGate = deferred();
    let blockPublication = false;
    let blockReopenScan = false;
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: {},
      stateRoot,
      launchDir: workspaceRoot,
      autoCreateSession: false,
      workflowDiscoveryTestHooks: {
        beforePublication: async () => {
          if (!blockPublication) return;
          blockPublication = false;
          publicationEntered.resolve();
          await publicationGate.promise;
        },
        beforeScan: async () => {
          if (blockReopenScan) await reopenScanGate.promise;
        },
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    await vi.waitFor(async () => {
      const workflows = (await (
        await fetch(`${baseUrl}/api/workflows`, { headers })
      ).json()) as WorkflowInfo[];
      expect(workflows).toHaveLength(1);
    });
    const initialState = (await (
      await fetch(`${baseUrl}/api/state`, { headers })
    ).json()) as AppState;
    const workspaceKey = initialState.workspaceScopes?.find(
      (scope) => scope.cwd === workspaceRoot,
    )?.workspaceKey;
    expect(workspaceKey).toBeTruthy();
    const graphUrl = `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`;
    await fetch(graphUrl, { headers }); // acquire the only continuous lease

    blockPublication = true;
    const oldScan = fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    await publicationEntered.promise;

    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [] }),
    );
    await fetch(`${baseUrl}/api/state`, { headers }); // retires the last lease
    await fs.rm(path.join(agentRoot, "sapiom.json")); // unobserved interval
    publicationGate.resolve();
    expect((await oldScan).status).toBe(200);

    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [workspaceRoot] }),
    );
    const restoredState = (await (
      await fetch(`${baseUrl}/api/state`, { headers })
    ).json()) as AppState;
    expect(
      restoredState.workspaceScopes?.some(
        (scope) => scope.workspaceKey === workspaceKey,
      ),
    ).toBe(true);
    blockReopenScan = true;

    const reopened = (await (
      await fetch(graphUrl, { headers })
    ).json()) as SystemGraphSnapshot;

    expect(reopened.state).toBe("degraded");
    expect(reopened.state).not.toBe("ready");
    expect(reopened.graph?.nodes).toHaveLength(1);
    reopenScanGate.resolve();
  });

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
          await fetch(
            `${baseUrl}/api/workspaces/${workspaceKey}/system-graph`,
            {
              headers,
            },
          )
        ).json()) as SystemGraphSnapshot;

      await vi.waitFor(
        async () => {
          expect((await readGraph()).state).toBe("ready");
        },
        { timeout: 8_000, interval: 150 },
      );

      // A second scan under the resolved spelling must not register duplicate
      // rows or make the existing invocation target ambiguous.
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
