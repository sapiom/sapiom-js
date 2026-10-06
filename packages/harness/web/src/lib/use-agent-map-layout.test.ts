import { describe, expect, it } from "vitest";

import { NODE_CHIP_ROW, NODE_HEIGHT, NODE_WIDTH } from "./elk-graph-layout";
import { edgeId, type AgentMap, type MapAgent, type MapEdge } from "./project-map";
import { agentMapGeometry, quantizedMapAspect } from "./use-agent-map-layout";

const agent = (slug: string, shared: string[] = []): MapAgent => ({
  slug,
  path: slug,
  description: "",
  deployed: null,
  changedSinceRef: false,
  shared,
  triggers: [],
});
const edge = (from: string, to: string, over: Partial<MapEdge> = {}): MapEdge => ({
  from,
  to,
  kind: "launch",
  evidence: [],
  ...over,
});
const mapOf = (over: Partial<AgentMap>): AgentMap => ({
  root: "/r",
  systems: [],
  agents: [],
  edges: [],
  unresolved: [],
  platform: "skipped",
  labels: "unavailable",
  ...over,
});

describe("agentMapGeometry", () => {
  const map = mapOf({
    systems: [
      { id: "s1", name: "one", nameSource: "default", agents: ["a", "b", "c"] },
      { id: "s2", name: "two", nameSource: "default", agents: ["d", "e"] },
    ],
    agents: [agent("a"), agent("b"), agent("c"), agent("d"), agent("e"), agent("loose")],
    edges: [edge("a", "b"), edge("b", "c"), edge("d", "e")],
  });

  it("makes one group per system, holding its agents", () => {
    const input = agentMapGeometry("p", map);
    expect(input.id).toBe("p");
    expect(input.groups.map(({ id }) => id)).toEqual(["s1", "s2"]);
    expect(input.groups[0]!.nodes.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(input.groups[1]!.nodes.map(({ id }) => id)).toEqual(["d", "e"]);
  });

  it("draws no edge for an agent calling itself, and no card for a slug the map does not list", () => {
    const input = agentMapGeometry(
      "p",
      mapOf({
        systems: [{ id: "s", name: "s", nameSource: "default", agents: ["a", "b", "ghost"] }],
        agents: [agent("a"), agent("b")],
        edges: [edge("a", "a"), edge("a", "b")],
      }),
    );
    expect(input.groups[0]!.nodes.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(input.groups[0]!.edges.map(({ from, to }) => `${from}>${to}`)).toEqual(["a>b"]);
  });

  it("puts agents in no system at the top level", () => {
    expect(agentMapGeometry("p", map).nodes.map(({ id }) => id)).toEqual(["loose"]);
    const none = agentMapGeometry("p", mapOf({ agents: [agent("x"), agent("y")] }));
    expect(none.groups).toEqual([]);
    expect(none.nodes.map(({ id }) => id)).toEqual(["x", "y"]);
  });

  it("assigns each edge to the group holding both endpoints", () => {
    const input = agentMapGeometry("p", map);
    expect(input.groups[0]!.edges.map(({ from, to }) => `${from}>${to}`)).toEqual(["a>b", "b>c"]);
    expect(input.groups[1]!.edges.map(({ from, to }) => `${from}>${to}`)).toEqual(["d>e"]);
  });

  it("drops an edge that crosses systems or touches a loose agent", () => {
    const crossing = mapOf({
      ...map,
      edges: [edge("c", "d"), edge("a", "loose"), edge("a", "b")],
    });
    const input = agentMapGeometry("p", crossing);
    expect(input.groups.flatMap((g) => g.edges.map(({ id }) => id))).toEqual([
      edgeId(edge("a", "b")),
    ]);
  });

  it("grows a node's height by the chip row only when it has shared chips", () => {
    const input = agentMapGeometry(
      "p",
      mapOf({
        systems: [{ id: "s", name: "s", nameSource: "default", agents: ["a", "b"] }],
        agents: [agent("a", ["vault:K"]), agent("b"), agent("c", ["vault:K"]), agent("d")],
      }),
    );
    const heights = Object.fromEntries(
      [...input.groups.flatMap((g) => g.nodes), ...input.nodes].map((n) => [n.id, n.height]),
    );
    expect(heights).toEqual({
      a: NODE_HEIGHT + NODE_CHIP_ROW,
      b: NODE_HEIGHT,
      c: NODE_HEIGHT + NODE_CHIP_ROW,
      d: NODE_HEIGHT,
    });
    for (const n of [...input.groups.flatMap((g) => g.nodes), ...input.nodes])
      expect(n.width).toBe(NODE_WIDTH);
  });

  it("labels only edges the map tool labelled", () => {
    const labelled = { ...edge("a", "b"), label: { value: "starts screening" } } as unknown as MapEdge;
    const input = agentMapGeometry(
      "p",
      mapOf({
        systems: [{ id: "s", name: "s", nameSource: "default", agents: ["a", "b", "c"] }],
        agents: [agent("a"), agent("b"), agent("c")],
        edges: [labelled, edge("b", "c"), { ...edge("a", "c"), label: { value: "  " } } as unknown as MapEdge],
      }),
    );
    const [first, second, third] = input.groups[0]!.edges;
    expect(first!.label?.text).toBe("starts screening");
    expect(second).not.toHaveProperty("label");
    expect(third).not.toHaveProperty("label");
  });

  it("gives parallel edges of different kinds unique ids", () => {
    const input = agentMapGeometry(
      "p",
      mapOf({
        systems: [{ id: "s", name: "s", nameSource: "default", agents: ["a", "b"] }],
        agents: [agent("a"), agent("b")],
        edges: [
          edge("a", "b"),
          edge("a", "b", { kind: "signal" }),
          edge("a", "b", { kind: "event", eventType: "x" }),
        ],
      }),
    );
    const ids = input.groups[0]!.edges.map(({ id }) => id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("is deterministic", () => {
    expect(agentMapGeometry("p", map)).toEqual(agentMapGeometry("p", map));
  });
});

describe("quantizedMapAspect", () => {
  it("rounds to quarters with a floor of 0.25", () => {
    expect(quantizedMapAspect(1000, 500)).toBe(2);
    expect(quantizedMapAspect(1010, 500)).toBe(2);
    expect(quantizedMapAspect(100, 1000)).toBe(0.25);
  });
  it("is null for an unmeasured viewport", () => {
    expect(quantizedMapAspect(0, 500)).toBeNull();
    expect(quantizedMapAspect(500, 0)).toBeNull();
    expect(quantizedMapAspect(NaN, 500)).toBeNull();
  });
});
