import { describe, expect, it } from "vitest";
import type {
  AgentInvocationMode,
  SystemGraph,
  SystemGraphEdge,
} from "@shared/system-graph";

import {
  SYSTEM_GRAPH_NODE_HEIGHT,
  SYSTEM_GRAPH_NODE_WIDTH,
  layoutSystemGraph,
  type SystemGraphLayout,
  type SystemGraphNodeGroup,
} from "./system-graph-layout";
import { fitSystemGraphView } from "./system-graph-viewport";

const node = (id: string) => ({ id, agentKey: id, label: id.toUpperCase() });
const edge = (
  from: string,
  to: string,
  mode: AgentInvocationMode = "blocking",
): SystemGraphEdge => ({ from, to, kind: "invokes", basis: "static", mode });

function graph(nodeIds: string[], edges: SystemGraphEdge[]): SystemGraph {
  return {
    kind: "system",
    scope: { kind: "working-tree", workspaceKey: "workspace-test" },
    nodes: nodeIds.map(node),
    edges,
    warnings: [],
  };
}

function byId(layout: SystemGraphLayout, id: string) {
  const placed = layout.nodes.find((candidate) => candidate.id === id);
  if (!placed) throw new Error(`Missing layout node ${id}`);
  return placed;
}

function onlyIsolatedSection(layout: SystemGraphLayout) {
  expect(layout.isolatedSections).toHaveLength(1);
  return layout.isolatedSections[0]!;
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function expectNodesNotToOverlap(layout: SystemGraphLayout): void {
  for (let left = 0; left < layout.nodes.length; left += 1) {
    for (let right = left + 1; right < layout.nodes.length; right += 1) {
      expect(
        rectanglesOverlap(layout.nodes[left]!, layout.nodes[right]!),
        `${layout.nodes[left]!.id} overlaps ${layout.nodes[right]!.id}`,
      ).toBe(false);
    }
  }
}

function expectEdgesNotToCrossCards(layout: SystemGraphLayout): void {
  for (const routed of layout.edges) {
    for (let index = 1; index < routed.points.length; index += 1) {
      const start = routed.points[index - 1]!;
      const end = routed.points[index]!;
      for (const placed of layout.nodes) {
        const crossesHorizontalInterior =
          start.y === end.y &&
          start.y > placed.y &&
          start.y < placed.y + placed.height &&
          Math.max(start.x, end.x) > placed.x &&
          Math.min(start.x, end.x) < placed.x + placed.width;
        const crossesVerticalInterior =
          start.x === end.x &&
          start.x > placed.x &&
          start.x < placed.x + placed.width &&
          Math.max(start.y, end.y) > placed.y &&
          Math.min(start.y, end.y) < placed.y + placed.height;
        expect(
          crossesHorizontalInterior || crossesVerticalInterior,
          `${routed.from} -> ${routed.to} crosses ${placed.id}`,
        ).toBe(false);
      }
    }
  }
}

describe("layoutSystemGraph", () => {
  it("ranks a direct chain strictly from left to right", () => {
    const layout = layoutSystemGraph(
      graph(["c", "a", "b"], [edge("a", "b"), edge("b", "c")]),
    );

    expect(byId(layout, "a").x).toBeLessThan(byId(layout, "b").x);
    expect(byId(layout, "b").x).toBeLessThan(byId(layout, "c").x);
    expect(layout.isolatedSections).toEqual([]);
  });

  it("keeps fan-out targets together and fan-in targets after every caller", () => {
    const fanOut = layoutSystemGraph(
      graph(
        ["source", "left", "right"],
        [edge("source", "left"), edge("source", "right", "async")],
      ),
    );
    expect(byId(fanOut, "left").x).toBe(byId(fanOut, "right").x);
    expect(byId(fanOut, "source").x).toBeLessThan(byId(fanOut, "left").x);

    const fanIn = layoutSystemGraph(
      graph(
        ["target", "left", "right"],
        [edge("left", "target"), edge("right", "target")],
      ),
    );
    expect(byId(fanIn, "target").x).toBeGreaterThan(byId(fanIn, "left").x);
    expect(byId(fanIn, "target").x).toBeGreaterThan(byId(fanIn, "right").x);
  });

  it("condenses cycles, routes their return edges, and ranks downstream SCCs later", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c", "downstream"],
        [
          edge("a", "b"),
          edge("b", "c", "async"),
          edge("c", "a"),
          edge("c", "downstream"),
        ],
      ),
    );

    expect(byId(layout, "a").x).toBe(byId(layout, "b").x);
    expect(byId(layout, "b").x).toBe(byId(layout, "c").x);
    expect(byId(layout, "downstream").x).toBeGreaterThan(byId(layout, "c").x);
    expect(
      layout.edges.filter((candidate) => candidate.route === "cycle"),
    ).toHaveLength(3);
    expect(
      layout.edges.every((candidate) => !candidate.path.includes("NaN")),
    ).toBe(true);
    expectEdgesNotToCrossCards(layout);
  });

  it("keeps disconnected components and isolated agents exactly once", () => {
    const connected = layoutSystemGraph(
      graph(["a", "b", "x", "y"], [edge("a", "b"), edge("x", "y")]),
    );
    const layout = layoutSystemGraph(
      graph(["isolated", "a", "b", "x", "y"], [edge("a", "b"), edge("x", "y")]),
    );

    expect(layout.nodes.map((candidate) => candidate.id).sort()).toEqual([
      "a",
      "b",
      "isolated",
      "x",
      "y",
    ]);
    expect(
      layout.nodes.filter((candidate) => candidate.id !== "isolated"),
    ).toEqual(connected.nodes);
    expect(layout.edges).toEqual(connected.edges);
    expect(
      new Set(layout.nodes.map((candidate) => candidate.componentId)).size,
    ).toBe(3);
    const isolatedSection = onlyIsolatedSection(layout);
    expect(isolatedSection).toMatchObject({
      groupId: null,
      count: 1,
      label: "1 agent · no detected relationships",
    });
    expect(isolatedSection.labelBounds.y).toBeGreaterThan(
      Math.max(
        byId(layout, "b").y + SYSTEM_GRAPH_NODE_HEIGHT,
        byId(layout, "y").y + SYSTEM_GRAPH_NODE_HEIGHT,
      ),
    );
    expect(byId(layout, "isolated").y).toBeGreaterThan(
      isolatedSection.labelBounds.y + isolatedSection.labelBounds.height,
    );
    expect(
      isolatedSection.labelBounds.x + isolatedSection.labelBounds.width,
    ).toBeLessThanOrEqual(layout.bounds.width);
    expect(
      isolatedSection.labelBounds.y + isolatedSection.labelBounds.height,
    ).toBeLessThanOrEqual(layout.bounds.height);
    expectNodesNotToOverlap(layout);
  });

  it("keeps a 77-agent, 4-edge graph bounded while preserving its connected layout", () => {
    const nodeIds = Array.from(
      { length: 77 },
      (_, index) => `agent-${index.toString().padStart(2, "0")}`,
    );
    const connectedIds = nodeIds.slice(0, 5);
    const edges = connectedIds
      .slice(0, -1)
      .map((id, index) => edge(id, connectedIds[index + 1]!));
    const connected = layoutSystemGraph(graph(connectedIds, edges));
    const sparse = layoutSystemGraph(graph(nodeIds, edges));

    expect(sparse.nodes.map((candidate) => candidate.id)).toEqual(nodeIds);
    expect(sparse.edges).toHaveLength(4);
    expect(onlyIsolatedSection(sparse)).toMatchObject({
      groupId: null,
      count: 72,
      label: "72 agents · no detected relationships",
    });
    expect(
      sparse.nodes.filter((candidate) => connectedIds.includes(candidate.id)),
    ).toEqual(connected.nodes);
    expect(sparse.edges).toEqual(connected.edges);

    const isolated = sparse.nodes.filter(
      (candidate) => !connectedIds.includes(candidate.id),
    );
    expect(
      new Set(isolated.map((candidate) => candidate.x)).size,
    ).toBeGreaterThan(1);
    expect(
      new Set(isolated.map((candidate) => candidate.y)).size,
    ).toBeGreaterThan(1);
    expect(sparse.bounds.height).toBeLessThanOrEqual(1_200);
    expect(
      fitSystemGraphView(sparse.bounds, { width: 1_200, height: 800 }, 16).zoom,
    ).toBeGreaterThanOrEqual(0.5);
    expectNodesNotToOverlap(sparse);
    expectEdgesNotToCrossCards(sparse);

    expect(
      layoutSystemGraph(graph([...nodeIds].reverse(), [...edges].reverse())),
    ).toEqual(sparse);
  });

  it("keeps fallback edge labels above the isolated section without rerouting them", () => {
    const connectedIds = Array.from(
      { length: 5 },
      (_, index) => `connected-${index}`,
    );
    const denseEdges = connectedIds.flatMap((from) =>
      connectedIds.filter((to) => to !== from).map((to) => edge(from, to)),
    );
    const connected = layoutSystemGraph(graph(connectedIds, denseEdges));
    const sparse = layoutSystemGraph(
      graph([...connectedIds, "isolated"], denseEdges),
    );

    expect(
      sparse.nodes.filter((candidate) => candidate.id !== "isolated"),
    ).toEqual(connected.nodes);
    expect(sparse.edges).toEqual(connected.edges);
    const isolatedSection = onlyIsolatedSection(sparse);
    expect(
      sparse.edges.some((candidate) =>
        rectanglesOverlap(candidate.labelBounds, isolatedSection.labelBounds),
      ),
    ).toBe(false);
  });

  it("groups dual-mode records into one connector with stable mode semantics", () => {
    const layout = layoutSystemGraph(
      graph(
        ["caller", "target"],
        [
          edge("caller", "target", "async"),
          edge("caller", "target", "blocking"),
          edge("caller", "target", "async"),
        ],
      ),
    );

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({
      from: "caller",
      to: "target",
      modes: ["blocking", "async"],
      label: "blocking + async",
      route: "forward",
    });
  });

  it("stagger ports, lands arrows at card borders, and keeps label boxes off cards", () => {
    const layout = layoutSystemGraph(
      graph(
        ["source", "one", "two", "three"],
        [
          edge("source", "one"),
          edge("source", "two", "async"),
          edge("source", "three"),
        ],
      ),
    );
    const sourcePorts = layout.edges.map((candidate) => candidate.points[0]!.y);
    expect(new Set(sourcePorts).size).toBe(sourcePorts.length);

    for (const routed of layout.edges) {
      const target = byId(layout, routed.to);
      const end = routed.points.at(-1)!;
      expect(end.x).toBe(target.x - 1);
      expect(end.y).toBeGreaterThanOrEqual(target.y);
      expect(end.y).toBeLessThanOrEqual(target.y + target.height);
      for (const placed of layout.nodes) {
        expect(
          rectanglesOverlap(routed.labelBounds, placed),
          `${routed.label} overlaps ${placed.id}`,
        ).toBe(false);
      }
    }
  });

  it("routes rank-skipping connectors outside intermediate cards", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c", "side"],
        [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("side", "c")],
      ),
    );

    expect(byId(layout, "c").x).toBeGreaterThan(byId(layout, "b").x);
    expectEdgesNotToCrossCards(layout);
  });

  it("returns fixed card geometry and bounds containing every routed primitive", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c"],
        [edge("a", "b"), edge("b", "a", "async"), edge("b", "c")],
      ),
    );
    expectNodesNotToOverlap(layout);
    expectEdgesNotToCrossCards(layout);

    for (const placed of layout.nodes) {
      expect(placed.width).toBe(SYSTEM_GRAPH_NODE_WIDTH);
      expect(placed.height).toBe(SYSTEM_GRAPH_NODE_HEIGHT);
      expect(placed.x).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeGreaterThanOrEqual(0);
      expect(placed.x + placed.width).toBeLessThanOrEqual(layout.bounds.width);
      expect(placed.y + placed.height).toBeLessThanOrEqual(
        layout.bounds.height,
      );
    }
    for (const routed of layout.edges) {
      for (const point of routed.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(layout.bounds.width);
        expect(point.y).toBeLessThanOrEqual(layout.bounds.height);
      }
      expect(routed.labelBounds.x).toBeGreaterThanOrEqual(0);
      expect(routed.labelBounds.y).toBeGreaterThanOrEqual(0);
      expect(
        routed.labelBounds.x + routed.labelBounds.width,
      ).toBeLessThanOrEqual(layout.bounds.width);
      expect(
        routed.labelBounds.y + routed.labelBounds.height,
      ).toBeLessThanOrEqual(layout.bounds.height);
    }
    expect(layout.isolatedSections).toEqual([]);
  });

  it("is deeply deterministic when node and edge input order changes", () => {
    const edges = [
      edge("a", "b"),
      edge("a", "c", "async"),
      edge("c", "a"),
      edge("d", "e"),
    ];
    const forward = layoutSystemGraph(
      graph(["a", "b", "c", "d", "e", "z"], edges),
    );
    const reversed = layoutSystemGraph(
      graph(["z", "e", "d", "c", "b", "a"], [...edges].reverse()),
    );

    expect(reversed).toEqual(forward);
  });

  it("fails closed for malformed endpoint geometry instead of hanging", () => {
    expect(() =>
      layoutSystemGraph(graph(["known"], [edge("known", "missing")])),
    ).toThrow("Invalid system graph layout input");
  });
});

/**
 * SAP-2983 — the map draws the groups the rail already has.
 *
 * The defect was structural, not cosmetic: one project root holding nine
 * systems and 76 agents rendered as a single ~70-node column, because every
 * unconnected agent was its own weak component and components were STACKED.
 * These pin the two halves of the fix — containers, and packing that wraps —
 * in geometry, because "it looks better" is not a rule anything can hold.
 *
 * Geometry only. That containers carry the RAIL's labels is
 * `system-graph-groups.test.ts`; that they reach the DOM is `project-map-groups.spec.ts`.
 */
describe("layoutSystemGraph with groups", () => {
  const group = (
    id: string,
    label: string,
    nodeIds: string[],
  ): SystemGraphNodeGroup => ({
    id,
    label,
    nodeIds,
    isUngrouped: label === "Ungrouped",
  });

  /** The box a container claims, by label. */
  function boxOf(layout: SystemGraphLayout, label: string) {
    const found = layout.groups.find((candidate) => candidate.label === label);
    if (!found) throw new Error(`Missing container ${label}`);
    return found;
  }

  const contains = (
    outer: { x: number; y: number; width: number; height: number },
    inner: { x: number; y: number; width: number; height: number },
  ): boolean =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;

  it("draws no container at all when it was given no groups", () => {
    // `undefined` is "no grouping information", which is NOT "nothing is
    // grouped". Drawing a bucket for it would put a label on the whole map
    // while the project's arrangement was still loading.
    const layout = layoutSystemGraph(graph(["a", "b"], [edge("a", "b")]));
    expect(layout.groups).toEqual([]);
    expect(layout.nodes.every((node) => node.groupId === null)).toBe(true);
  });

  it("puts every card inside its own container and no card inside another", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "x", "y", "loner"],
        [edge("a", "b"), edge("x", "y", "async")],
      ),
      [
        group("g:one", "One", ["a", "b"]),
        group("g:two", "Two", ["x", "y"]),
        group("group:ungrouped", "Ungrouped", ["loner"]),
      ],
    );

    expect(layout.groups.map((candidate) => candidate.label)).toEqual([
      "One",
      "Two",
      "Ungrouped",
    ]);
    for (const [label, ids] of [
      ["One", ["a", "b"]],
      ["Two", ["x", "y"]],
      ["Ungrouped", ["loner"]],
    ] as const) {
      const box = boxOf(layout, label);
      expect(box.nodeCount).toBe(ids.length);
      for (const id of ids) {
        expect(contains(box, byId(layout, id)), `${id} inside ${label}`).toBe(
          true,
        );
        expect(byId(layout, id).groupId).toBe(box.id);
      }
    }
    // The containers themselves must not overlap, or "inside" means nothing.
    for (let left = 0; left < layout.groups.length; left += 1) {
      for (let right = left + 1; right < layout.groups.length; right += 1) {
        expect(
          rectanglesOverlap(layout.groups[left]!, layout.groups[right]!),
          `${layout.groups[left]!.label} overlaps ${layout.groups[right]!.label}`,
        ).toBe(false);
      }
    }
    const isolatedSection = onlyIsolatedSection(layout);
    expect(isolatedSection).toMatchObject({
      groupId: "group:ungrouped",
      count: 1,
      label: "1 agent · no detected relationships",
    });
    expect(
      contains(boxOf(layout, "Ungrouped"), isolatedSection.labelBounds),
    ).toBe(true);
    expectNodesNotToOverlap(layout);
  });

  it("keeps a group's own wiring and labels inside its border", () => {
    /* A container measured from its CARDS is not big enough. A cycle gutter
       runs 44px past the right edge of its component, a rank-skipping corridor
       28px above the top of one, and — the case that actually escapes any fixed
       padding — a connector label that finds no free slot beside the cards is
       pushed into a fallback stack that grows without bound. Measured: a
       six-way fan-in already puts two labels outside cards + 48px.

       So the box is the union of everything the group DRAWS, computed after
       routing. Anything less and an edge appears to leave a system it never
       leaves. */
    const sources = Array.from({ length: 8 }, (_, index) => `s${index}`);
    const layout = layoutSystemGraph(
      graph(
        ["hub", ...sources, "solo"],
        sources.map((id) => edge(id, "hub")),
      ),
      [
        group("g:fan", "Fan", ["hub", ...sources]),
        group("group:ungrouped", "Ungrouped", ["solo"]),
      ],
    );
    const box = boxOf(layout, "Fan");
    const cards = layout.nodes.filter((placed) => placed.id !== "solo");
    // The fixture is only evidence while it still overflows a card-sized box.
    const cardsBox = {
      x: Math.min(...cards.map((placed) => placed.x)),
      y: Math.min(...cards.map((placed) => placed.y)),
      width: 0,
      height: 0,
    };
    cardsBox.width =
      Math.max(...cards.map((placed) => placed.x + placed.width)) - cardsBox.x;
    cardsBox.height =
      Math.max(...cards.map((placed) => placed.y + placed.height)) - cardsBox.y;
    expect(
      layout.edges.some((routed) => !contains(cardsBox, routed.labelBounds)),
    ).toBe(true);

    for (const routed of layout.edges) {
      for (const point of routed.points) {
        expect(point.x).toBeGreaterThanOrEqual(box.x);
        expect(point.x).toBeLessThanOrEqual(box.x + box.width);
        expect(point.y).toBeGreaterThanOrEqual(box.y);
        expect(point.y).toBeLessThanOrEqual(box.y + box.height);
      }
      expect(contains(box, routed.labelBounds)).toBe(true);
    }
    expectEdgesNotToCrossCards(layout);
  });

  it("keeps a cyclic group's gutters inside its border too", () => {
    const layout = layoutSystemGraph(
      graph(
        ["a", "b", "c", "solo"],
        [edge("a", "b"), edge("b", "c"), edge("c", "a", "async"), edge("a", "c")],
      ),
      [
        group("g:cyclic", "Cyclic", ["a", "b", "c"]),
        group("group:ungrouped", "Ungrouped", ["solo"]),
      ],
    );
    const box = boxOf(layout, "Cyclic");
    for (const routed of layout.edges) {
      for (const point of routed.points) {
        expect(point.x).toBeGreaterThanOrEqual(box.x);
        expect(point.x).toBeLessThanOrEqual(box.x + box.width);
        expect(point.y).toBeGreaterThanOrEqual(box.y);
        expect(point.y).toBeLessThanOrEqual(box.y + box.height);
      }
      expect(contains(box, routed.labelBounds)).toBe(true);
    }
    expectEdgesNotToCrossCards(layout);
  });

  it("draws an edge whose ends the user split across two groups", () => {
    // A group is editable, so half a detected system can be pulled out. The
    // edge between the halves is still real; dropping it would make the map
    // claim two systems never touch.
    const layout = layoutSystemGraph(
      graph(["a", "b"], [edge("a", "b")]),
      [group("g:one", "One", ["a"]), group("g:two", "Two", ["b"])],
    );
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({
      from: "a",
      to: "b",
      crossesGroup: true,
    });
    expect(layout.edges[0]!.path).not.toContain("NaN");
    expect(layout.isolatedSections).toEqual([]);
  });

  it("wraps a container of unconnected agents instead of stacking them", () => {
    /* THE DEFECT, in numbers. 40 agents with no edges used to be 40 stacked
       components: 40 * (64 + 64) = 5,120px tall and one card wide. The
       assertion is on the SHAPE — taller than it is wide is the column coming
       back — and on distinct rows and columns, which a stack has exactly one
       of. */
    const ids = Array.from({ length: 40 }, (_, index) => `n${index}`);
    const layout = layoutSystemGraph(graph(ids, []), [
      group("group:ungrouped", "Ungrouped", ids),
    ]);

    expect(layout.groups).toHaveLength(1);
    expect(layout.bounds.height).toBeLessThan(5120 / 2);
    expect(layout.bounds.width).toBeGreaterThan(layout.bounds.height);
    expect(new Set(layout.nodes.map((node) => node.x)).size).toBeGreaterThan(1);
    expect(new Set(layout.nodes.map((node) => node.y)).size).toBeGreaterThan(1);
    expectNodesNotToOverlap(layout);
    expect(boxOf(layout, "Ungrouped").nodeCount).toBe(40);
  });

  it("does not file an unclaimed node into a group merely NAMED Ungrouped", () => {
    /* The layout half of the same identity rule the mapper carries: the bucket
       is `isUngrouped`, never the string. A user may name a real system
       "Ungrouped", and matching on the label would drop the cards nothing
       claimed inside it and move it to the end of the map. */
    const layout = layoutSystemGraph(graph(["a", "b", "orphan"], []), [
      { id: "g:named", label: "Ungrouped", nodeIds: ["a", "b"], isUngrouped: false },
    ]);
    expect(layout.groups.map((candidate) => candidate.nodeCount)).toEqual([2, 1]);
    expect(layout.groups[0]!.id).toBe("g:named");
    expect(byId(layout, "a").groupId).toBe("g:named");
    expect(byId(layout, "b").groupId).toBe("g:named");
    // The synthesized bucket is a SECOND box, after the user's group.
    expect(layout.groups[1]!.label).toBe("Ungrouped");
    expect(layout.groups[1]!.id).not.toBe("g:named");
    expect(byId(layout, "orphan").groupId).toBe(layout.groups[1]!.id);
  });

  it("still draws a node no group claimed", () => {
    // The caller hands over an exhaustive partition, so this is a backstop —
    // and it is deliberately not a throw. A card that silently disappears is
    // worse than a card in the bucket that means "nothing claims this".
    const layout = layoutSystemGraph(graph(["a", "orphan"], []), [
      group("g:one", "One", ["a"]),
    ]);
    expect(layout.nodes.map((node) => node.id).sort()).toEqual(["a", "orphan"]);
    const box = boxOf(layout, "Ungrouped");
    expect(contains(box, byId(layout, "orphan"))).toBe(true);
  });

  it("is deterministic for grouped input too", () => {
    const groups = [
      group("g:one", "One", ["a", "b"]),
      group("group:ungrouped", "Ungrouped", ["z"]),
    ];
    const forward = layoutSystemGraph(
      graph(["a", "b", "z"], [edge("a", "b")]),
      groups,
    );
    const reversed = layoutSystemGraph(
      graph(["z", "b", "a"], [edge("a", "b")]),
      groups,
    );
    expect(reversed).toEqual(forward);
  });
});
