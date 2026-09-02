import { describe, expect, it } from "vitest";

import { layoutDirectedGraph } from "./directed-graph-layout";

describe("layoutDirectedGraph", () => {
  it("lays out heterogeneous cycles deterministically with labelled directed edges", () => {
    const nodes = [
      "agent",
      "subagent",
      "resource",
      "connector",
      "artifact",
    ].map((id) => ({ id }));
    const edges = [
      { id: "a", from: "agent", to: "subagent", label: "invokes" },
      { id: "b", from: "subagent", to: "agent", label: "feeds" },
      { id: "c", from: "agent", to: "resource", label: "writes" },
      { id: "d", from: "agent", to: "connector", label: "uses" },
      { id: "e", from: "artifact", to: "agent", label: "triggers" },
    ];
    const first = layoutDirectedGraph(nodes, edges);
    expect(first).toEqual(layoutDirectedGraph(nodes, edges));
    expect(first.nodes).toHaveLength(5);
    expect(first.edges.map((edge) => edge.label)).toEqual([
      "invokes",
      "feeds",
      "writes",
      "uses",
      "triggers",
    ]);
    expect(first.edges.every((edge) => edge.path.startsWith("M "))).toBe(true);
  });

  it("fails closed for missing endpoints", () => {
    expect(() =>
      layoutDirectedGraph(
        [{ id: "a" }],
        [{ id: "edge", from: "a", to: "missing", label: "uses" }],
      ),
    ).toThrow("Invalid directed graph layout input");
  });
});
