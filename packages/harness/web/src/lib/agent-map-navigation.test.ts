import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanNodeId, StudioProjectId } from "@shared/agent-map";
import type { WorkflowInfo } from "@shared/types";
import { createApi } from "./api";
import {
  agentMapNavigationError,
  agentMapTargetWorkflow,
  parseAgentMapNodeTarget,
} from "./agent-map-navigation";

const projectId =
  "project_00000000-0000-4000-8000-000000000001" as StudioProjectId;
const nodeId = "node_00000000-0000-7000-8000-000000000001" as PlanNodeId;
const target = {
  projectId,
  nodeId,
  agentId: "agent_00000000-0000-4000-8000-000000000001",
  workflowPath: "/workspace/second",
};
const workflow = (patch: Partial<WorkflowInfo> = {}): WorkflowInfo => ({
  name: "Same name",
  path: target.workflowPath,
  source: "scan",
  definitionId: 42,
  definitionSlug: "same",
  studioBindings: [{ projectId, agentId: target.agentId }],
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Agent Map navigation target", () => {
  it.each([
    "/workspace/second",
    "C:\\agents\\second",
    "\\\\server\\share\\second",
  ])("accepts an exact target at %s", (workflowPath) => {
    expect(
      parseAgentMapNodeTarget({ ...target, workflowPath }, projectId, nodeId),
    ).toEqual({ ...target, workflowPath });
  });

  it.each([
    null,
    [],
    { ...target, extra: true },
    { ...target, projectId: projectId.replace(/1$/, "2") },
    { ...target, nodeId: nodeId.replace(/1$/, "2") },
    { ...target, agentId: "same-name" },
    { ...target, workflowPath: "relative/path" },
    { ...target, workflowPath: "/private/\nsecret" },
  ])("rejects malformed or foreign replies", (value) => {
    expect(() => parseAgentMapNodeTarget(value, projectId, nodeId)).toThrow(
      "Invalid Agent Map navigation target",
    );
  });

  it("joins exact project/agent identity and path despite duplicate names and cloud definitions", () => {
    const other = workflow({
      path: "/workspace/first",
      studioBindings: [
        { projectId, agentId: target.agentId.replace(/1$/, "2") },
      ],
    });
    const exact = workflow();
    expect(agentMapTargetWorkflow(target, [other, exact])).toBe(exact);
    expect(agentMapTargetWorkflow(target, [other])).toBeNull();
    expect(
      agentMapTargetWorkflow(target, [workflow({ path: "/moved" })]),
    ).toBeNull();
    expect(
      agentMapTargetWorkflow(target, [
        workflow({
          studioBindings: [
            {
              projectId: projectId.replace(/1$/, "2"),
              agentId: target.agentId,
            },
          ],
        }),
      ]),
    ).toBeNull();
    expect(() =>
      agentMapTargetWorkflow(target, [exact, workflow({ path: "/duplicate" })]),
    ).toThrow();
  });

  it("uses the protected target route and validates its response", async () => {
    vi.stubEnv("VITE_MOCK", "0");
    vi.stubGlobal("window", { __HARNESS__: { token: "test-ui-token" } });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(target)));
    vi.stubGlobal("fetch", fetch);
    expect(
      await createApi().getAgentMapNodeImplementation(projectId, nodeId),
    ).toEqual(target);
    expect(fetch).toHaveBeenCalledWith(
      `/api/projects/${projectId}/agent-map/nodes/${nodeId}/implementation`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Harness-Token": expect.any(String),
        }),
      }),
    );
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...target, workflowPath: "relative" })),
    );
    await expect(
      createApi().getAgentMapNodeImplementation(projectId, nodeId),
    ).rejects.toThrow();
  });

  it("shows bounded recovery copy without echoing paths or backend errors", () => {
    expect(agentMapNavigationError({ code: "unbound" })).toBe(
      "No implementation is linked yet.",
    );
    expect(agentMapNavigationError({ code: "target_not_found" })).toBe(
      "This agent isn't available locally.",
    );
    expect(agentMapNavigationError({ code: "target_ambiguous" })).toContain(
      "one implementation",
    );
    expect(agentMapNavigationError(new Error("/private/secret"))).toBe(
      "Couldn't open this agent. Try again.",
    );
  });
});
