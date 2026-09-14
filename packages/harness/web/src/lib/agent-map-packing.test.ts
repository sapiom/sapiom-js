import { expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  parseAgentMapGraph,
  parseMapChangeProposal,
} from "@shared/agent-map-codec";
import { agentMapPackingFixture } from "../../e2e/agent-map-packing-fixture";
import { agentMapGeometry, quantizedMapAspect } from "./use-agent-map-layout";
import {
  createElkGraph,
  readElkGraph,
  type ElkLayoutInput,
} from "./elk-graph-layout";
import { fitGraphView } from "./graph-viewport";
import { layoutDirectedGraph } from "./directed-graph-layout";

function input(copies = 1): ElkLayoutInput {
  const geometry = JSON.parse(
    agentMapGeometry(agentMapPackingFixture(undefined, copies)),
  );
  return {
    ...geometry,
    options: { "elk.aspectRatio": "0.5" },
    edges: geometry.edges.map((edge: { label: string }) => ({
      ...edge,
      labelWidth: edge.label.length * 7.2 + 8,
      labelHeight: 24,
      labelOffsetX: edge.label.length * 3.6 + 4,
      labelOffsetY: 18,
    })),
  };
}
it("exports a persistable anonymous graph with the specified component distribution", () => {
  const fixture = agentMapPackingFixture();
  const graph = { nodes: fixture.nodes, relationships: fixture.relationships };
  expect(parseAgentMapGraph(graph)).toEqual(graph);
  expect(parseMapChangeProposal(fixture)).toEqual(fixture);
  const parent = new Map(graph.nodes.map((node) => [node.id, node.id]));
  const root = (id: (typeof fixture.nodes)[number]["id"]): typeof id =>
    parent.get(id) === id ? id : root(parent.get(id)!);
  for (const edge of graph.relationships)
    parent.set(root(edge.toNodeId), root(edge.fromNodeId));
  const sizes = graph.nodes.map((node) => root(node.id));
  expect([
    graph.nodes.length,
    graph.relationships.length,
    new Set(sizes).size,
  ]).toEqual([34, 13, 21]);
  expect(
    sizes.filter((id) => sizes.filter((other) => other === id).length === 1),
  ).toHaveLength(17);
});
it("keys geometry by project, IDs, dimensions and visible labels, excluding status/version/object order", () => {
  const fixture = agentMapPackingFixture(),
    key = agentMapGeometry(fixture);
  const unchanged = {
    ...fixture,
    id: agentMapPackingFixture().id,
    version: 12,
    updatedAt: new Date().toISOString(),
    nodes: [...fixture.nodes]
      .reverse()
      .map((node) => ({ ...node, name: "Renamed", purpose: "New status" })),
    relationships: [...fixture.relationships]
      .reverse()
      .map((edge) => ({ ...edge, description: "Updated status" })),
  };
  unchanged.id =
    "proposal_00000000-0000-7000-8000-000000000999" as typeof fixture.id;
  expect(agentMapGeometry(unchanged)).toBe(key);
  expect(
    agentMapGeometry({ ...fixture, projectId: "another-project" }),
  ).not.toBe(key);
  expect(
    agentMapGeometry({ ...fixture, nodes: fixture.nodes.slice(1) }),
  ).not.toBe(key);
  fixture.relationships[0]!.executionMode = "human-triggered";
  expect(agentMapGeometry(fixture)).not.toBe(key);
  expect([
    quantizedMapAspect(590, 980),
    quantizedMapAspect(592, 979),
    quantizedMapAspect(1500, 1036),
    quantizedMapAspect(0, 980),
  ]).toEqual([0.5, 0.5, 1.5, null]);
});
it.each([
  { width: 590, height: 980, aspect: 0.5 },
  { width: 1500, height: 1036, aspect: 1.5 },
])(
  "packs to the available $width × $height viewport without regressing Classic",
  async (viewport) => {
    const graph = input(),
      engine = new ELK();
    graph.options = { "elk.aspectRatio": String(viewport.aspect) };
    const placed = readElkGraph(
      graph,
      await engine.layout(createElkGraph(graph)),
    );
    const classic = layoutDirectedGraph(graph.nodes, graph.edges);
    expect(
      fitGraphView(placed.bounds, viewport, 16, 0.001).zoom,
    ).toBeGreaterThanOrEqual(
      fitGraphView(classic.bounds, viewport, 16, 0.001).zoom,
    );
    const reordered = {
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    expect(
      readElkGraph(reordered, await engine.layout(createElkGraph(reordered))),
    ).toEqual(placed);
  },
);
it.each([1, 10])(
  "records cold/warm validated layouts for %i copies of the fixture",
  async (copies) => {
    const graph = input(copies),
      engine = new ELK(),
      timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now(),
        layout = readElkGraph(
          graph,
          await engine.layout(createElkGraph(graph)),
        );
      timings.push(Math.round(performance.now() - start));
      expect(layout.nodes).toHaveLength(34 * copies);
      expect(layout.edges).toHaveLength(13 * copies);
    }
    console.log(
      JSON.stringify({
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        firstMs: timings[0],
        warmMs: timings.slice(1),
      }),
    );
  },
);
