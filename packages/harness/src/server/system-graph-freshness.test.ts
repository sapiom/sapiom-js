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
import { CachedAgentInvocationProvider } from "../core/system-graph-relationships.js";
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

describe("workspace discovery freshness without legacy graph authority", () => {
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
    vi.restoreAllMocks();
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  it("updates inventory through explicit scans without legacy graph work or a session", async () => {
    const invocationObservations = vi.spyOn(
      CachedAgentInvocationProvider.prototype,
      "invocationObservations",
    );
    await scaffoldAgent(workspaceRoot, "research");
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
    const headers = {
      "X-Harness-Token": "test-token",
      "Content-Type": "application/json",
    };
    const events: BusMessage[] = [];
    socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws/events?token=test-token`,
    );
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    socket.on("message", (raw) =>
      events.push(JSON.parse(raw.toString()) as BusMessage),
    );
    const scan = async () => {
      expect(
        (
          await fetch(`${baseUrl}/api/workflows/scan`, {
            method: "POST",
            headers,
            body: JSON.stringify({ root: workspaceRoot }),
          })
        ).status,
      ).toBe(200);
      return (await (
        await fetch(`${baseUrl}/api/workflows`, { headers })
      ).json()) as WorkflowInfo[];
    };
    expect((await scan()).map((row) => row.definitionSlug).sort()).toEqual([
      "growth",
      "research",
    ]);
    const reporting = await scaffoldAgent(workspaceRoot, "reporting");
    expect((await scan()).map((row) => row.path)).toContain(reporting);
    const insights = path.join(workspaceRoot, "insights");
    await fs.rename(reporting, insights);
    await fs.writeFile(
      path.join(insights, "sapiom.json"),
      JSON.stringify({ name: "insights", definitionId: null }),
    );
    const renamed = await scan();
    expect(renamed.map((row) => row.path)).not.toContain(reporting);
    expect(renamed.find((row) => row.path === insights)?.definitionSlug).toBe(
      "insights",
    );
    await fs.writeFile(
      path.join(insights, "sapiom.json"),
      JSON.stringify({ name: "insights-v2", definitionId: null }),
    );
    expect(
      (await scan()).find((row) => row.path === insights)?.definitionSlug,
    ).toBe("insights-v2");
    await fs.rm(insights, { recursive: true, force: true });
    expect((await scan()).map((row) => row.definitionSlug).sort()).toEqual([
      "growth",
      "research",
    ]);
    await vi.waitFor(() =>
      expect(
        events.filter((message) => message.type === "workflows.changed").length,
      ).toBeGreaterThanOrEqual(4),
    );
    expect(
      events.filter((message) => message.type === "system-graph.changed"),
    ).toEqual([]);
    expect(invocationObservations).not.toHaveBeenCalled();
    expect(server.sessionManager.list()).toEqual([]);
  });

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
    expect(state.workflows.map((row) => row.path)).toEqual([coldRoot]);
    const cached = await within(
      fetch(`${baseUrl}/api/workflows`, { headers }),
      "cached inventory",
    );
    expect(cached.status).toBe(200);
    expect(
      ((await cached.json()) as WorkflowInfo[]).map((row) => row.path),
    ).toEqual([coldRoot]);

    scanGate.resolve();
    const acceptedScan = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(acceptedScan.status).toBe(200);
    expect(
      (
        (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[]
      ).map((row) => row.path),
    ).toEqual([coldRoot]);
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
    const workflows = (await (
      await fetch(`${baseUrl}/api/workflows`, { headers })
    ).json()) as WorkflowInfo[];
    expect(workflows.map((row) => row.path)).toEqual([workspaceRoot]);
    // Public rows intentionally omit syntax-only source names. Inspect the
    // accepted persisted evidence so stale source memoization fails this test.
    const persisted = JSON.parse(
      await fs.readFile(path.join(stateRoot, "workflows.json"), "utf8"),
    ) as RegistryWorkflowInfo[];
    expect(
      persisted.find((row) => row.path === workspaceRoot)?.sourceDefinitionName,
    ).toBe("budget-v2-final");
  });

  it("retains accepted inventory after a failed dirty scan and recovers on retry", async () => {
    const agent = await scaffoldAgent(workspaceRoot, "recoverable");
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
    await fs.writeFile(
      path.join(agent, "sapiom.json"),
      JSON.stringify({ name: "recovered", definitionId: null }),
    );
    failuresRemaining = 4;
    const failed = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(failed.status).toBe(500);
    expect(failuresRemaining).toBe(0);

    expect(
      (
        (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[]
      ).map((row) => row.definitionSlug),
    ).toEqual(["recoverable"]);
    const retried = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(retried.status).toBe(200);
    expect(
      ((await retried.json()) as { found: WorkflowInfo[] }).found.map(
        (row) => row.definitionSlug,
      ),
    ).toEqual(["recovered"]);
    expect(
      (
        (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[]
      ).map((row) => row.definitionSlug),
    ).toEqual(["recovered"]);
  });

  it(
    "coalesces two sessions into one pass plus one held-edit trailing pass",
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
      await server.sessionManager.create({
        cwd: workspaceRoot,
        harness: "claude-code",
      });
      await server.sessionManager.create({
        cwd: workspaceRoot,
        harness: "claude-code",
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

  it("reconciles a newly foreign repository from its parent session watcher", async () => {
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
    await server.sessionManager.create({
      cwd: workspaceRoot,
      harness: "claude-code",
    });
    await server.sessionManager.create({
      cwd: workspaceRoot,
      harness: "claude-code",
    });
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
  }, 20_000);

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
    let blockPublication = false;
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: { "claude-code": fakeClaudeAdapter() },
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
    // Project enrollment creates an ordinary bootstrap session. Use that sole
    // owner so killing it really retires the final shared lease.
    await vi.waitFor(() => expect(server!.sessionManager.list().filter((session) => session.status !== "exited")).toHaveLength(1));
    const session = server.sessionManager.list().find((session) => session.status !== "exited")!;
    // Drain the shared watcher's initial reconciliation before holding a scan.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    blockPublication = true;
    const oldScan = fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    await publicationEntered.promise;

    await server.sessionManager.kill(session.id);
    await vi.waitFor(() => expect(server!.sessionManager.get(session.id)?.status).toBe("exited"));
    expect(server.sessionManager.list().filter((candidate) => candidate.status !== "exited")).toEqual([]);
    await fs.rm(path.join(agentRoot, "sapiom.json")); // unobserved interval
    publicationGate.resolve();
    const oldResponse = await oldScan;
    expect(oldResponse.status).toBe(200);
    expect(
      ((await oldResponse.json()) as { found: WorkflowInfo[] }).found,
    ).toEqual([]);
    const retained = (await (
      await fetch(`${baseUrl}/api/workflows`, { headers })
    ).json()) as WorkflowInfo[];
    expect(retained.map((row) => row.path)).toEqual([agentRoot]);
    const recovery = await fetch(`${baseUrl}/api/workflows/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ root: workspaceRoot }),
    });
    expect(recovery.status).toBe(200);
    expect(
      await (await fetch(`${baseUrl}/api/workflows`, { headers })).json(),
    ).toEqual([]);
  });

  it(
    "registers each agent once when the launch directory is a symlink",
    { timeout: 30_000 },
    async () => {
      // Both spellings must reach the same registry rows when explicitly scanned.
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

      const scan = async (root: string) => {
        const response = await fetch(`${baseUrl}/api/workflows/scan`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ root }),
        });
        expect(response.status).toBe(200);
        return (await (
          await fetch(`${baseUrl}/api/workflows`, { headers })
        ).json()) as WorkflowInfo[];
      };
      const initial = await scan(workspaceRoot);
      expect(initial).toHaveLength(2);
      expect(
        new Set(await Promise.all(initial.map((row) => fs.realpath(row.path))))
          .size,
      ).toBe(2);
      await scaffoldAgent(workspaceRoot, "reporting");
      const added = await scan(linkedRoot);
      expect(added.map((row) => row.definitionSlug).sort()).toEqual([
        "growth",
        "reporting",
        "research",
      ]);
      expect(
        new Set(await Promise.all(added.map((row) => fs.realpath(row.path))))
          .size,
      ).toBe(3);
    },
  );
});
