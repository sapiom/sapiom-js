import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentMapImplementation,
  AgentMapImplementationsResponse,
  AgentMapVersionId,
} from "@shared/agent-map";
import type { WorkflowInfo } from "@shared/types";
import { createApi } from "./api";
import {
  agentMapDeployments,
  parseAgentMapImplementations,
} from "./agent-map-deployment";
import {
  proposalNodeId as nodeId,
  proposalProjectId as projectId,
  proposalSnapshot,
} from "./agent-map-test-fixture";

const agentId = "agent_00000000-0000-4000-8000-000000000001";
const binding: AgentMapImplementation = {
  nodeId,
  agentId,
  revision: 1,
  resolution: "bound",
};
const response = (
  patch: Partial<AgentMapImplementation> = {},
): AgentMapImplementationsResponse => ({
  projectId,
  mapVersionId:
    "mapv_00000000-0000-7000-8000-000000000003" as AgentMapVersionId,
  bindings: [{ ...binding, ...patch }],
});
const workflow = (patch: Partial<WorkflowInfo> = {}): WorkflowInfo => ({
  name: "Research",
  path: "/agent",
  source: "scan",
  definitionId: 42,
  definitionSlug: "shared",
  activeBuildRunStatus: "ready",
  studioBindings: [{ projectId, agentId }],
  ...patch,
});
const snapshot = proposalSnapshot();
const project = (
  rows: WorkflowInfo[],
  reply = response(),
  previous = new Map(),
) => agentMapDeployments(snapshot, reply, rows, previous, "available");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  null,
  [],
  { ...response(), projectId: "other" },
  { ...response(), mapVersionId: [response().mapVersionId] },
  { ...response(), bindings: [{ ...binding, nodeId: [nodeId] }] },
  { ...response(), bindings: [{ ...binding, agentId: [agentId] }] },
  { ...response(), mapVersionId: "invalid" },
  { ...response(), bindings: [binding, binding] },
  response({ agentId: null }),
  response({ resolution: "unbound" }),
  response({ revision: -1 }),
  response({ revision: 1.5 }),
  response({ revision: Number.MAX_SAFE_INTEGER + 1 }),
  response({ agentId: "Research" }),
  response({ nodeId: "wrong" as typeof nodeId }),
  response({ resolution: "proposed" as "bound" }),
])("rejects malformed or foreign bulk replies", (raw) => {
  expect(() => parseAgentMapImplementations(raw, projectId)).toThrow();
});
it("uses the protected bulk route and validates its response", async () => {
  vi.stubEnv("VITE_MOCK", "0");
  vi.stubGlobal("window", { __HARNESS__: { token: "test-token" } });
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(response())));
  vi.stubGlobal("fetch", fetch);
  expect(await createApi().getAgentMapImplementations(projectId)).toEqual(
    response(),
  );
  expect(fetch).toHaveBeenCalledWith(
    `/api/projects/${projectId}/agent-map/implementations`,
    expect.objectContaining({
      headers: expect.objectContaining({ "X-Harness-Token": "test-token" }),
    }),
  );
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ ...response(), projectId: "other" })),
  );
  await expect(
    createApi().getAgentMapImplementations(projectId),
  ).rejects.toThrow();
});
it("joins exact identities despite duplicate names, paths moving and canonical pointers lagging", () => {
  expect(project([workflow({ path: "/moved" })]).get(nodeId)?.indicator).toBe(
    "deployed",
  );
  for (const rows of [
    [],
    [workflow({ studioBindings: [] })],
    [workflow({ studioBindings: [{ projectId: "other", agentId }] })],
    [workflow(), workflow({ path: "/duplicate" })],
  ]) {
    expect(project(rows).get(nodeId)).toMatchObject({
      indicator: null,
      unavailable: true,
    });
  }
  snapshot.proposal!.version += 1;
  expect(project([workflow()]).get(nodeId)?.indicator).toBe("deployed");
});
it("handles planned, local, building, failed and ready agents without badging resources", () => {
  expect(
    project([], response({ resolution: "unbound", agentId: null })).get(nodeId)
      ?.indicator,
  ).toBe("draft");
  for (const status of ["building", "failed", "ready"]) {
    expect(
      project([workflow({ activeBuildRunStatus: status })]).get(nodeId)
        ?.indicator,
    ).toBe(status === "ready" ? "deployed" : "draft");
  }
  expect(
    project([workflow({ definitionId: null })]).get(nodeId)?.indicator,
  ).toBe("draft");
  const resource = proposalSnapshot();
  resource.proposal!.nodes[0].kind = "resource";
  expect(
    agentMapDeployments(resource, response(), [], new Map(), "available").size,
  ).toBe(0);
});
it("retains a label on outages only for the same binding and forgets omitted or rebound nodes", () => {
  const previous = new Map(project([workflow()]));
  for (const resolution of ["missing", "ambiguous", "unavailable"] as const) {
    expect(
      project([], response({ resolution }), previous).get(nodeId),
    ).toMatchObject({ indicator: "deployed", unavailable: true });
  }
  expect(
    project([], response({ revision: 2 }), previous).get(nodeId)?.indicator,
  ).toBeNull();
  expect(
    project(
      [],
      response({ agentId: agentId.replace(/1$/, "2") }),
      previous,
    ).get(nodeId)?.indicator,
  ).toBeNull();
  expect(
    project([], { ...response(), bindings: [] }, previous).get(nodeId)
      ?.indicator,
  ).toBeNull();
  expect(
    agentMapDeployments(snapshot, null, [], previous, "unavailable").get(
      nodeId,
    ),
  ).toMatchObject({ indicator: "deployed", unavailable: true });
  expect(
    agentMapDeployments(snapshot, null, [], new Map(), "loading").get(nodeId),
  ).toMatchObject({ indicator: null, loading: true });
});

it("honors current workflow evidence, including unknown after relinking, during binding outages", () => {
  const previous = project([workflow()]);
  expect(
    agentMapDeployments(
      snapshot,
      response(),
      [workflow({ activeBuildRunStatus: "failed" })],
      previous,
      "unavailable",
    ).get(nodeId),
  ).toMatchObject({ indicator: "draft", unavailable: true });
  expect(
    project(
      [workflow({ definitionId: 43, activeBuildRunStatus: null })],
      response(),
      new Map(previous),
    ).get(nodeId)?.indicator,
  ).toBeNull();
});
