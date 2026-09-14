import { describe, expect, it } from "vitest";

import type { AgentMapGraph, PlanNodeId, PlanRelationshipId } from "./agent-map.js";
import { canonicalizeAgentMapGraph, computeGraphContentDigest } from "./agent-map-canonical.js";

const first = "node_018f0000-0000-7000-8000-000000000001" as PlanNodeId;
const second = "node_018f0000-0000-7000-8000-000000000002" as PlanNodeId;

describe("Agent Map content canonicalization", () => {
  it("orders stable identities and set-like contract references without mutation", () => {
    const graph: AgentMapGraph = {
      nodes: [
        { id: second, kind: "agent", name: "Publisher", purpose: "Publish", ownerAgentId: null, contractRefs: ["z", "a"] },
        { id: first, kind: "agent", name: "Research", purpose: "Research", ownerAgentId: null, contractRefs: [] },
      ],
      relationships: [],
    };
    const before = JSON.stringify(graph);
    const canonical = canonicalizeAgentMapGraph(graph);
    expect(canonical.nodes.map(({ id }) => id)).toEqual([first, second]);
    expect(canonical.nodes[1]?.contractRefs).toEqual(["a", "z"]);
    expect(JSON.stringify(graph)).toBe(before);
    expect(computeGraphContentDigest(graph)).toBe(computeGraphContentDigest(canonical));
  });

  it.each([
    ["node", (graph: AgentMapGraph) => graph.nodes.push({ ...graph.nodes[0]!, contractRefs: [] })],
    ["relationship", (graph: AgentMapGraph) => {
      const relationship = { id: "rel_018f0000-0000-7000-8000-000000000001" as PlanRelationshipId,
        fromNodeId: first, toNodeId: second, kind: "invokes" as const, executionMode: null,
        contractRef: null, description: "Delegate" };
      graph.relationships.push(relationship, { ...relationship });
    }],
    ["contract", (graph: AgentMapGraph) => graph.nodes[0]!.contractRefs.push("report", "report")],
  ])("rejects duplicate %s identities", (_name, mutate) => {
    const graph: AgentMapGraph = {
      nodes: [
        { id: first, kind: "agent", name: "Research", purpose: "Research", ownerAgentId: null, contractRefs: [] },
        { id: second, kind: "agent", name: "Publish", purpose: "Publish", ownerAgentId: null, contractRefs: [] },
      ],
      relationships: [],
    };
    mutate(graph);
    expect(() => canonicalizeAgentMapGraph(graph)).toThrow(/duplicate Agent Map/u);
  });
});
