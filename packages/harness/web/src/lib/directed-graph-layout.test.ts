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

describe("component packing", () => {
  for (const count of [1, 10, 50, 100]) {
    for (const topology of ["disconnected", "chain", "fan-out", "cycles", "components"]) {
      it(`places ${count} ${topology} nodes without overlap and deterministically reflows added edges`, () => {
        const nodes = Array.from({ length: count }, (_, i) => ({ id: `agent-${String(i).padStart(3, "0")}` }));
        const edge = (from: number, to: number) => ({ id: `${from}-${to}`, from: nodes[from]!.id, to: nodes[to]!.id, label: "feeds" });
        const edges = nodes.slice(1).flatMap((_, i) => topology === "disconnected" ? [] :
          topology === "fan-out" ? [edge(0, i + 1)] : topology === "components" && i % 4 === 0 ? [] : [edge(i, i + 1)]);
        if (topology === "cycles" && count > 1) edges.push(edge(count - 1, 0));
        const layout = layoutDirectedGraph(nodes, edges);
        expect(layout).toEqual(layoutDirectedGraph([...nodes].reverse(), [...edges].reverse()));
        expect(layout.nodes).toHaveLength(count);
        if (count >= 10) {
          expect(layout.bounds.width / layout.bounds.height).toBeGreaterThan(0.3);
          expect(layout.bounds.width / layout.bounds.height).toBeLessThan(4);
        }
        for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
          const a = layout.nodes[i]!; const b = layout.nodes[j]!;
          expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
        }
        if (topology === "disconnected" && count > 1) {
          expect(new Set(layout.nodes.map((node) => node.x)).size).toBeGreaterThan(1);
          expect(layout.bounds.width / layout.bounds.height).toBeGreaterThan(0.5);
          expect(layout.bounds.width / layout.bounds.height).toBeLessThan(3);
          expect(layoutDirectedGraph(nodes, [edge(0, 1)]).nodes).not.toEqual(layout.nodes);
        }
      });
    }
  }
});
