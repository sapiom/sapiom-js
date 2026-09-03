import { describe, expect, it } from "vitest";

import type {
  AgentMapGraph,
  PlanNodeId,
  PlanRelationshipId,
} from "./agent-map.js";
import {
  canonicalAgentMapArchitecturePayload,
  canonicalizeAgentMapGraph,
} from "./agent-map-canonical.js";

const agentA = "node_018f0000-0000-7000-8000-000000000001" as PlanNodeId;
const agentB = "node_018f0000-0000-7000-8000-000000000002" as PlanNodeId;

const shuffledGraph = (): AgentMapGraph => ({
  nodes: [
    {
      id: agentB,
      kind: "agent",
      name: "Marketing",
      purpose: "Publish research",
      ownerAgentId: null,
      contractRefs: ["report/v2", "brief/v1"],
    },
    {
      id: agentA,
      kind: "agent",
      name: "Research",
      purpose: "Find market signals",
      ownerAgentId: null,
      contractRefs: [],
    },
  ],
  relationships: [],
});

describe("Agent Map canonical architecture protocol", () => {
  it("orders IDs and contract references without mutating input", () => {
    const graph = shuffledGraph();
    const before = JSON.stringify(graph);
    const canonical = canonicalizeAgentMapGraph(graph);

    expect(canonical.nodes.map(({ id }) => id)).toEqual([agentA, agentB]);
    expect(canonical.nodes[1]?.contractRefs).toEqual(["brief/v1", "report/v2"]);
    expect(JSON.stringify(graph)).toBe(before);
    expect(canonical.nodes[1]).not.toBe(graph.nodes[0]);
    expect(canonical.nodes[1]?.contractRefs).not.toBe(
      graph.nodes[0]?.contractRefs,
    );
  });

  it("encodes the fixed domain-separated tuple with explicit nulls", () => {
    expect(
      canonicalAgentMapArchitecturePayload("project-1", shuffledGraph()),
    ).toEqual([
      "sapiom.agent-map.architecture",
      1,
      "project-1",
      [
        [agentA, "agent", "Research", "Find market signals", null, []],
        [
          agentB,
          "agent",
          "Marketing",
          "Publish research",
          null,
          ["brief/v1", "report/v2"],
        ],
      ],
      [],
    ]);
  });

  it.each([
    ["node IDs", (graph: AgentMapGraph) => graph.nodes.push(graph.nodes[0]!)],
    [
      "relationship IDs",
      (graph: AgentMapGraph) => {
        const relationship = {
          id: "rel_018f0000-0000-7000-8000-000000000001" as PlanRelationshipId,
          fromNodeId: agentA,
          toNodeId: agentB,
          kind: "invokes" as const,
          executionMode: null,
          contractRef: null,
          description: "Delegates",
        };
        graph.relationships.push(relationship, { ...relationship });
      },
    ],
    [
      "contract references",
      (graph: AgentMapGraph) => graph.nodes[0]?.contractRefs.push("report/v2"),
    ],
  ])("rejects duplicate %s before serialization", (_name, mutate) => {
    const graph = shuffledGraph();
    mutate(graph);
    expect(() =>
      canonicalAgentMapArchitecturePayload("project-1", graph),
    ).toThrow(/duplicate Agent Map/u);
  });
});
