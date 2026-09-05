import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowInfo } from "@shared/types";

import {
  createApi,
  isMockMode,
  MockApi,
  parseNdjsonLine,
  projectMockSystemGraphInventory,
  progressiveLeasingRun,
  PROGRESSIVE_STEP_MS,
  terminalDeployEvent,
  type DeployStreamEvent,
} from "./api";

describe("MockApi deterministic system graph identity and navigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assigns duplicate definition slugs distinct deterministic local identities", () => {
    const workflows = [
      {
        name: "Second",
        path: "/workspace/second",
        definitionId: 2,
        definitionSlug: "shared",
        source: "scan" as const,
      },
      {
        name: "First",
        path: "/workspace/first",
        definitionId: 1,
        definitionSlug: "shared",
        source: "scan" as const,
      },
    ];

    const forward = projectMockSystemGraphInventory("/workspace", workflows);
    const reversed = projectMockSystemGraphInventory(
      "/workspace",
      [...workflows].reverse(),
    );

    expect(forward).toEqual(reversed);
    expect(forward.nodes.map((node) => node.agentKey)).toEqual([
      "local:first",
      "local:second",
    ]);
    expect(new Set(forward.nodes.map((node) => node.id)).size).toBe(2);
    expect(forward.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);
    expect(forward.degraded).toBe(true);
  });

  it("suffixes colliding local fallbacks without duplicate warnings", () => {
    const workflows = [
      {
        name: "Root",
        path: "/workspace",
        definitionId: null,
        definitionSlug: null,
        source: "scan" as const,
      },
      {
        name: "Nested root",
        path: "/workspace/root",
        definitionId: null,
        definitionSlug: null,
        source: "scan" as const,
      },
      {
        name: "Suffixed root",
        path: "/workspace/root~2",
        definitionId: null,
        definitionSlug: null,
        source: "scan" as const,
      },
    ];
    const projection = projectMockSystemGraphInventory("/workspace", workflows);

    expect(projection.nodes.map((node) => node.agentKey)).toEqual([
      "local:root",
      "local:root~2",
      "local:root~2~2",
    ]);
    expect(projection.warnings).toEqual([]);
    expect(projection.degraded).toBe(false);
    expect(projection).toEqual(
      projectMockSystemGraphInventory("/workspace", [...workflows].reverse()),
    );
  });

  it("gives proven source identity precedence over a legacy marker alias", () => {
    const workflow: WorkflowInfo = {
      name: "billing-package",
      path: "/workspace/billing",
      definitionId: null,
      definitionSlug: "payments",
      activeBuildRunId: null,
      activeBuildRunStatus: null,
      source: "scan",
    };

    const projection = projectMockSystemGraphInventory(
      "/workspace",
      [workflow],
      {
        [workflow.path]: {
          kind: "source",
          sourceDefinitionName: "billing",
        },
      },
    );

    expect(projection.nodes).toEqual([
      {
        id: "agent:billing",
        agentKey: "billing",
        label: "billing-package",
      },
    ]);
    expect(projection.targets).toEqual([
      { agentKey: "billing", workflowPath: workflow.path },
    ]);
    expect(projection.degraded).toBe(false);
  });

  it("keeps persisted unknown source identity visible but lifecycle-degraded", () => {
    const workflow: WorkflowInfo = {
      name: "billing-package",
      path: "/workspace/billing",
      definitionId: null,
      definitionSlug: null,
      source: "scan",
    };

    const projection = projectMockSystemGraphInventory(
      "/workspace",
      [workflow],
      {
        [workflow.path]: {
          kind: "unknown",
          sourceDefinitionName: "billing",
        },
      },
    );

    expect(projection.nodes[0]?.agentKey).toBe("billing");
    expect(projection.degraded).toBe(true);
  });

  it("falls back deterministically for duplicate proven source identities", () => {
    const workflows: WorkflowInfo[] = ["first", "second"].map((name) => ({
      name,
      path: `/workspace/${name}`,
      definitionId: null,
      definitionSlug: null,
      source: "scan",
    }));
    const evidence = Object.fromEntries(
      workflows.map((workflow) => [
        workflow.path,
        { kind: "source", sourceDefinitionName: "billing" } as const,
      ]),
    );

    const projection = projectMockSystemGraphInventory(
      "/workspace",
      workflows,
      evidence,
    );

    expect(projection.nodes.map((node) => node.agentKey)).toEqual([
      "local:first",
      "local:second",
    ]);
    expect(projection.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "billing",
        message:
          "Multiple agents use billing; kept each with a local identity.",
      },
    ]);
    expect(projection.degraded).toBe(true);
  });

  it("invalidates mock rail and graph revisions across source add, edit, and delete", async () => {
    const events = await import("./events");
    const publish = vi.spyOn(events, "publishMockBusMessage");
    const api = new MockApi();
    const state = await api.getState();
    const scope = state.workspaceScopes?.find(
      (candidate) => candidate.cwd === "/Users/demo/rfq-agent",
    );
    expect(scope).toBeDefined();
    const before = await api.getSystemGraph(scope!.workspaceKey);
    const row: WorkflowInfo = {
      name: "rfq-package",
      path: scope!.cwd,
      definitionId: null,
      definitionSlug: null,
      activeBuildRunId: null,
      activeBuildRunStatus: null,
      source: "scan",
    };

    api.replaceSourceDiscoveredWorkflows([row], {
      [row.path]: { kind: "source", sourceDefinitionName: "rfq-current" },
    });
    const added = await api.getSystemGraph(scope!.workspaceKey);
    expect(added.revision).toBeGreaterThan(before.revision);
    expect(added.graph?.nodes.map((node) => node.agentKey)).toEqual([
      "rfq-current",
    ]);

    api.replaceSourceDiscoveredWorkflows([row], {
      [row.path]: { kind: "source", sourceDefinitionName: "rfq-next" },
    });
    const edited = await api.getSystemGraph(scope!.workspaceKey);
    expect(edited.revision).toBeGreaterThan(added.revision);
    expect(edited.graph?.nodes.map((node) => node.agentKey)).toEqual([
      "rfq-next",
    ]);

    api.replaceSourceDiscoveredWorkflows([], {});
    const removed = await api.getSystemGraph(scope!.workspaceKey);
    expect(removed.revision).toBeGreaterThan(edited.revision);
    expect(removed.graph?.nodes).toEqual([]);
    await vi.waitFor(() => {
      expect(
        publish.mock.calls.filter(
          ([message]) => message.type === "workflows.changed",
        ),
      ).toHaveLength(3);
    });
  });

  it("uses projection warnings and lifecycle for non-special mock graphs", async () => {
    const api = new MockApi();
    const scope = (await api.getState()).workspaceScopes?.find(
      (candidate) => candidate.cwd !== "/Users/demo/acme-app",
    );
    expect(scope).toBeDefined();
    const setWorkflows = (workflows: WorkflowInfo[]) => {
      (api as unknown as { workflows: WorkflowInfo[] }).workflows = workflows;
    };
    setWorkflows([
      {
        name: "First",
        path: `${scope!.cwd}/first`,
        definitionId: 1,
        definitionSlug: "shared",
        source: "scan",
      },
      {
        name: "Second",
        path: `${scope!.cwd}/second`,
        definitionId: 2,
        definitionSlug: "shared",
        source: "scan",
      },
    ]);

    const duplicate = await api.getSystemGraph(scope!.workspaceKey);
    expect(duplicate.state).toBe("degraded");
    expect(duplicate.graph?.nodes.map((node) => node.agentKey)).toEqual([
      "local:first",
      "local:second",
    ]);
    expect(duplicate.graph?.warnings).toEqual([
      {
        code: "duplicate-agent-key",
        agentKey: "shared",
        message: "Multiple agents use shared; kept each with a local identity.",
      },
    ]);

    setWorkflows([
      {
        name: "Unique",
        path: `${scope!.cwd}/unique`,
        definitionId: null,
        definitionSlug: null,
        source: "scan",
      },
    ]);
    const unique = await api.getSystemGraph(scope!.workspaceKey);
    expect(unique.state).toBe("ready");
    expect(unique.graph?.warnings).toEqual([]);
  });

  it("caches ordinary graph reads and advances an explicit refresh", async () => {
    const api = new MockApi();
    const scope = (await api.getState()).workspaceScopes?.[0];
    expect(scope).toBeDefined();

    const first = await api.getSystemGraph(scope!.workspaceKey);
    const cached = await api.getSystemGraph(scope!.workspaceKey);
    const refreshed = await api.getSystemGraph(scope!.workspaceKey, {
      refresh: true,
    });

    expect(cached).toBe(first);
    expect(refreshed.revision).toBeGreaterThan(first.revision);
  });

  it("bypasses a cached graph for a directly announced mock revision", async () => {
    const api = new MockApi();
    const scope = (await api.getState()).workspaceScopes?.[0];
    expect(scope).toBeDefined();
    const first = await api.getSystemGraph(scope!.workspaceKey);
    vi.stubGlobal("window", {
      location: { search: "" },
      __MOCK_SYSTEM_GRAPH_REVISION__: first.revision + 1,
      __MOCK_SYSTEM_GRAPH_STATE__: "stale",
    });

    const announced = await api.getSystemGraph(scope!.workspaceKey);

    expect(announced).toMatchObject({
      revision: first.revision + 1,
      state: "stale",
    });
    expect(announced).not.toBe(first);
  });

  it("rebuilds graph navigation atomically after a workflow move", async () => {
    const api = new MockApi();
    const state = await api.getState();
    const scope = state.workspaceScopes?.find(
      (candidate) => candidate.cwd === "/Users/demo/acme-app",
    );
    expect(scope).toBeDefined();

    const before = await api.getSystemGraph(scope!.workspaceKey);
    const oldNavigation = await api.getSystemGraphNavigation(
      scope!.workspaceKey,
    );
    expect(
      oldNavigation.targets.find((target) => target.agentKey === "leasing")
        ?.workflowPath,
    ).toBe("/Users/demo/acme-app/leasing");

    await api.moveAgent(
      "/Users/demo/acme-app/leasing",
      "/Users/demo/acme-app/leasing-moved",
    );
    const navigation = await api.getSystemGraphNavigation(scope!.workspaceKey);

    expect(navigation.revision).toBeGreaterThan(before.revision);
    expect(
      navigation.targets.find((target) => target.agentKey === "leasing")
        ?.workflowPath,
    ).toBe("/Users/demo/acme-app/leasing-moved");
    expect(
      oldNavigation.targets.find((target) => target.agentKey === "leasing")
        ?.workflowPath,
    ).toBe("/Users/demo/acme-app/leasing");
  });
});

describe("RealApi.getSystemGraph", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the revisioned graph lifecycle envelope", async () => {
    if (isMockMode()) return;
    const graph = {
      kind: "system",
      scope: { kind: "working-tree", workspaceKey: "workspace-test" },
      nodes: [],
      edges: [],
      warnings: [],
    };
    vi.stubGlobal("window", {
      __HARNESS__: { token: "test-token" },
      location: { search: "" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            workspaceKey: "workspace-test",
            revision: 7,
            state: "degraded",
            graph,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    );

    await expect(createApi().getSystemGraph("workspace-test")).resolves.toEqual(
      {
        workspaceKey: "workspace-test",
        revision: 7,
        state: "degraded",
        graph,
      },
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-test/system-graph",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Harness-Token": "test-token" }),
      }),
    );
  });

  it("sends explicit graph retries through the refresh route", async () => {
    if (isMockMode()) return;
    vi.stubGlobal("window", {
      __HARNESS__: { token: "test-token" },
      location: { search: "" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            workspaceKey: "workspace-test",
            revision: 8,
            state: "ready",
            graph: {
              kind: "system",
              scope: {
                kind: "working-tree",
                workspaceKey: "workspace-test",
              },
              nodes: [],
              edges: [],
              warnings: [],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await createApi().getSystemGraph("workspace-test", { refresh: true });

    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-test/system-graph/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Harness-Token": "test-token" }),
      }),
    );
  });

  it("fetches and strictly parses the protected navigation sidecar", async () => {
    if (isMockMode()) return;
    vi.stubGlobal("window", {
      __HARNESS__: { token: "test-token" },
      location: { search: "" },
    });
    const navigation = {
      workspaceKey: "workspace-test",
      revision: 8,
      targets: [{ agentKey: "research", workflowPath: "/private/research" }],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(navigation), { status: 200 }),
        ),
    );

    await expect(
      createApi().getSystemGraphNavigation("workspace-test"),
    ).resolves.toEqual(navigation);
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-test/system-graph/navigation",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Harness-Token": "test-token" }),
      }),
    );
  });
});

describe("progressiveLeasingRun", () => {
  const at = (elapsed: number) =>
    progressiveLeasingRun("exec-mock-prod-1", elapsed);

  it("starts with the first step running, the rest pending, and no latencies", () => {
    const run = at(0);
    expect(run.status).toBe("running");
    expect(run.steps.map((s) => s.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    // Honest-absence: nothing has finished, so no step reports a duration.
    expect(run.steps.every((s) => s.latencyMs === undefined)).toBe(true);
  });

  it("advances monotonically: earlier steps pass before later ones", () => {
    // Two steps in: step 0 passed (with its latency), step 1 running (no latency).
    const run = at(PROGRESSIVE_STEP_MS + 10);
    expect(run.status).toBe("running");
    expect(run.steps[0].status).toBe("passed");
    expect(run.steps[0].latencyMs).toBeGreaterThan(0);
    expect(run.steps[1].status).toBe("running");
    expect(run.steps[1].latencyMs).toBeUndefined();
  });

  it("reports a running step with NO latencyMs, a passed step WITH it", () => {
    const run = at(PROGRESSIVE_STEP_MS * 2 + 10);
    for (const step of run.steps) {
      if (step.status === "running" || step.status === "pending") {
        expect(step.latencyMs).toBeUndefined();
      }
      if (step.status === "passed") expect(step.latencyMs).toBeGreaterThan(0);
    }
  });

  it("terminates as completed with every step passed and no cost fields", () => {
    const run = at(PROGRESSIVE_STEP_MS * 6);
    expect(run.status).toBe("completed");
    expect(run.steps.every((s) => s.status === "passed")).toBe(true);
    expect(JSON.stringify(run)).not.toMatch(/\$|cost/i);
  });
});

describe("terminalDeployEvent", () => {
  it("returns the terminal ready event", () => {
    const events: DeployStreamEvent[] = [
      { phase: "building", definitionId: "42" },
      {
        phase: "ready",
        definitionId: "42",
        buildRunId: "b1",
        status: "succeeded",
      },
    ];
    expect(terminalDeployEvent(events)).toEqual({
      phase: "ready",
      definitionId: "42",
      buildRunId: "b1",
      status: "succeeded",
    });
  });

  it("returns the terminal error event", () => {
    const events: DeployStreamEvent[] = [
      { phase: "building", definitionId: "42" },
      { phase: "error", code: "BUILD_FAILED", message: "boom" },
    ];
    expect(terminalDeployEvent(events)).toEqual({
      phase: "error",
      code: "BUILD_FAILED",
      message: "boom",
    });
  });

  it("returns the LAST terminal event when more than one is present", () => {
    // Defensive: pick the final terminal line, not the first.
    const events: DeployStreamEvent[] = [
      { phase: "error", code: "A", message: "first" },
      {
        phase: "ready",
        definitionId: "42",
        buildRunId: "b1",
        status: "succeeded",
      },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({ phase: "ready" });
  });

  it("synthesizes an error when the stream carried no terminal line", () => {
    // A stream that only ever said "building" (server died mid-build) still
    // yields a definite failure outcome, never a building line.
    const events: DeployStreamEvent[] = [
      { phase: "building", definitionId: "42" },
    ];
    expect(terminalDeployEvent(events)).toEqual({
      phase: "error",
      code: "NO_OUTPUT",
      message: "deploy produced no terminal status",
    });
  });

  it("synthesizes an error for an empty stream", () => {
    expect(terminalDeployEvent([])).toMatchObject({
      phase: "error",
      code: "NO_OUTPUT",
    });
  });

  it("treats a linking line as non-terminal", async () => {
    // The server emits `linking` before `building` when it has to create the
    // agent; only ready/error may end the stream.
    const events: DeployStreamEvent[] = [
      { phase: "linking", name: "order-triage" },
      { phase: "building", definitionId: "42" },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({
      phase: "error",
      code: "NO_OUTPUT",
    });
  });

  it("treats a warning line as non-terminal", async () => {
    // `warning` is advisory (the agent was created but its id couldn't be
    // written to sapiom.json) — it never closes the stream on its own.
    const events: DeployStreamEvent[] = [
      { phase: "linking", name: "order-triage" },
      {
        phase: "warning",
        message: "Couldn't save the agent id to sapiom.json.",
      },
      { phase: "building", definitionId: "42" },
    ];
    expect(terminalDeployEvent(events)).toMatchObject({
      phase: "error",
      code: "NO_OUTPUT",
    });
  });
});

describe("parseNdjsonLine (deploy stream)", () => {
  it("parses a well-formed deploy event line", () => {
    expect(
      parseNdjsonLine<DeployStreamEvent>(
        '{"phase":"building","definitionId":"42"}',
      ),
    ).toEqual({
      phase: "building",
      definitionId: "42",
    });
  });

  it("drops a bare `null` line instead of forwarding it", () => {
    // JSON.parse("null") === null: a stray null line must be silently dropped,
    // never handed to the deploy consumer (where it could throw downstream).
    expect(parseNdjsonLine<DeployStreamEvent>("null")).toBeUndefined();
  });

  it("drops blank and non-JSON noise lines", () => {
    expect(parseNdjsonLine<DeployStreamEvent>("   ")).toBeUndefined();
    expect(
      parseNdjsonLine<DeployStreamEvent>("Build succeeded in 12ms"),
    ).toBeUndefined();
  });
});
