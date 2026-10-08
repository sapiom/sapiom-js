import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import {
  createElkGraph,
  readElkGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type ElkLayoutInput,
  type LayoutEdgeInput,
  type LayoutGroupInput,
  type LayoutNodeInput,
  type MapLayout,
  type PlacedBox,
} from "./elk-graph-layout";

const node = (id: string): LayoutNodeInput => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT });
const labelled = (id: string, from: string, to: string, text = "launches"): LayoutEdgeInput => ({
  id,
  from,
  to,
  label: { text, width: 80, height: 20, offsetX: 40, offsetY: 14 },
});
const bare = (id: string, from: string, to: string): LayoutEdgeInput => ({ id, from, to });
const group = (
  id: string,
  nodes: string[],
  edges: LayoutEdgeInput[] = [],
): LayoutGroupInput => ({ id, nodes: nodes.map(node), edges });

const fleet0: ElkLayoutInput = { id: "p", groups: [], nodes: [node("solo")] };
const oneSystem: ElkLayoutInput = {
  id: "p",
  groups: [
    group(
      "sys-a",
      ["a", "b", "c"],
      [labelled("a>b", "a", "b", "starts screening"), bare("b>c", "b", "c")],
    ),
  ],
  nodes: [node("x"), node("y")],
};
const cyclic: ElkLayoutInput = {
  id: "p",
  groups: [
    group(
      "sys-cycle",
      ["a", "b", "c"],
      [
        labelled("a>b launch", "a", "b", "launch"),
        bare("a>b event", "a", "b"),
        labelled("b>c", "b", "c"),
        bare("c>a", "c", "a"),
      ],
    ),
  ],
  nodes: [],
};
const several: ElkLayoutInput = {
  id: "p",
  groups: [
    group("sys-1", ["a", "b"], [labelled("a>b", "a", "b")]),
    group("sys-2", ["c", "d", "e"], [bare("c>d", "c", "d"), labelled("d>e", "d", "e")]),
    group("sys-3", ["f", "g"], [bare("g>f", "g", "f")]),
  ],
  nodes: [node("loose-1"), node("loose-2")],
};

const run = async (input: ElkLayoutInput) =>
  readElkGraph(input, await new ELK().layout(createElkGraph(input)));
const rawLayout = (input: ElkLayoutInput): Promise<ElkNode> =>
  new ELK().layout(createElkGraph(input));

const overlap = (a: PlacedBox, b: PlacedBox) =>
  !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
const inside = (outer: PlacedBox, inner: PlacedBox) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-6;
const parse = (path: string) =>
  [...path.matchAll(/([ML]) (-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
    command: m[1]!,
    x: Number(m[2]),
    y: Number(m[3]),
  }));
const onBoundary = (point: { x: number; y: number }, box: PlacedBox) => {
  const x = point.x - box.x;
  const y = point.y - box.y;
  const within = x >= -1e-6 && x <= box.width + 1e-6 && y >= -1e-6 && y <= box.height + 1e-6;
  return (
    within &&
    (Math.abs(x) < 1e-6 ||
      Math.abs(x - box.width) < 1e-6 ||
      Math.abs(y) < 1e-6 ||
      Math.abs(y - box.height) < 1e-6)
  );
};

function assertLayout(input: ElkLayoutInput, layout: MapLayout) {
  const nodeIds = [...input.groups.flatMap((g) => g.nodes), ...input.nodes].map(({ id }) => id);
  expect(layout.nodes.map(({ id }) => id).sort()).toEqual([...nodeIds].sort());
  expect(layout.groups.map(({ id }) => id).sort()).toEqual(input.groups.map(({ id }) => id).sort());
  for (const placed of layout.nodes) {
    expect([placed.width, placed.height]).toEqual([NODE_WIDTH, NODE_HEIGHT]);
    const owner = input.groups.find((g) => g.nodes.some(({ id }) => id === placed.id));
    if (owner) expect(inside(layout.groups.find(({ id }) => id === owner.id)!, placed)).toBe(true);
  }
  for (let i = 0; i < layout.nodes.length; i++)
    for (const other of layout.nodes.slice(i + 1))
      expect(overlap(layout.nodes[i]!, other)).toBe(false);
  const loose = layout.nodes.filter(({ id }) => input.nodes.some((n) => n.id === id));
  const outer = [...layout.groups, ...loose];
  for (let i = 0; i < outer.length; i++)
    for (const other of outer.slice(i + 1)) expect(overlap(outer[i]!, other)).toBe(false);
  const edges = input.groups.flatMap((g) => g.edges);
  expect(layout.edges.map(({ id }) => id).sort()).toEqual(edges.map(({ id }) => id).sort());
  for (const input_ of edges) {
    const placed = layout.edges.find(({ id }) => id === input_.id)!;
    expect([placed.from, placed.to]).toEqual([input_.from, input_.to]);
    if (input_.label) expect(placed.label?.text).toBe(input_.label.text);
    else expect(placed.label).toBeNull();
    const points = parse(placed.path);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]!.command).toBe("M");
    points.slice(1).forEach((point, i) => {
      expect(point.command).toBe("L");
      const previous = points[i]!;
      expect(Math.abs(point.x - previous.x) < 1e-6 || Math.abs(point.y - previous.y) < 1e-6).toBe(
        true,
      );
    });
    const from = layout.nodes.find(({ id }) => id === input_.from)!;
    const to = layout.nodes.find(({ id }) => id === input_.to)!;
    expect(onBoundary(points[0]!, from)).toBe(true);
    expect(onBoundary(points[points.length - 1]!, to)).toBe(true);
  }
  const extents = [
    ...layout.groups,
    ...layout.nodes,
  ];
  for (const box of extents) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(layout.bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(layout.bounds.height);
  }
  for (const edge of layout.edges)
    for (const point of parse(edge.path)) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(layout.bounds.width);
      expect(point.y).toBeLessThanOrEqual(layout.bounds.height);
    }
  for (const edge of layout.edges)
    if (edge.label) {
      expect(edge.label.x).toBeGreaterThanOrEqual(0);
      expect(edge.label.y).toBeGreaterThanOrEqual(0);
    }
}

describe("hierarchical ELK layout", () => {
  it.each([
    ["a fleet of one loose agent", fleet0],
    ["one system and two loose agents", oneSystem],
    ["a cycle with parallel edges of different kinds", cyclic],
    ["several systems", several],
  ])("places %s without overlaps", async (_name, input) => {
    const layout = await run(input);
    assertLayout(input, layout);
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
  });

  it("has no groups or edges for a fleet of one loose agent", async () => {
    const layout = await run(fleet0);
    expect(layout.groups).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.nodes).toHaveLength(1);
  });

  it("keeps parallel edges between one pair as separate routes", async () => {
    const layout = await run(cyclic);
    const parallel = layout.edges.filter(({ from, to }) => from === "a" && to === "b");
    expect(parallel.map(({ id }) => id).sort()).toEqual(["a>b event", "a>b launch"]);
    expect(parallel.map(({ label }) => label !== null).sort()).toEqual([false, true]);
  });

  it("is deterministic and independent of input order", async () => {
    const first = await run(several);
    expect(await run(several)).toEqual(first);
    const shuffled: ElkLayoutInput = {
      ...several,
      groups: [...several.groups]
        .reverse()
        .map((g) => ({ ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() })),
      nodes: [...several.nodes].reverse(),
    };
    expect(createElkGraph(shuffled)).toEqual(createElkGraph(several));
    expect(await run(shuffled)).toEqual(first);
  });

  it("includes label ink outside the declared root bounds", async () => {
    const raw = await rawLayout(oneSystem);
    const sys = raw.children!.find(({ id }) => id === "sys-a")!;
    sys.edges!.find(({ id }) => id === "a>b")!.labels![0]!.x = -300;
    const layout = readElkGraph(oneSystem, raw);
    expect(layout.bounds.width).toBeGreaterThan(raw.width!);
    expect(layout.edges.find(({ id }) => id === "a>b")!.label!.x).toBeGreaterThanOrEqual(0);
  });
});

describe("ELK input validation", () => {
  const throwsInvalid = (input: ElkLayoutInput) =>
    expect(() => createElkGraph(input)).toThrow("Invalid ELK layout");

  it("rejects duplicate ids across nodes and groups", () => {
    throwsInvalid({ id: "p", groups: [group("g", ["a", "a"])], nodes: [] });
    throwsInvalid({ id: "p", groups: [group("g", ["a"])], nodes: [node("a")] });
    throwsInvalid({ id: "p", groups: [group("a", ["a"])], nodes: [] });
    throwsInvalid({
      id: "p",
      groups: [group("g", ["a", "b"], [bare("e", "a", "b"), bare("e", "b", "a")])],
      nodes: [],
    });
  });

  it("rejects an edge whose endpoint is outside its group", () => {
    throwsInvalid({
      id: "p",
      groups: [group("g", ["a", "b"], [bare("e", "a", "z")])],
      nodes: [node("z")],
    });
    throwsInvalid({
      id: "p",
      groups: [group("g", ["a"], [bare("e", "a", "b")]), group("h", ["b"])],
      nodes: [],
    });
  });

  it("rejects a self-edge", () => {
    throwsInvalid({ id: "p", groups: [group("g", ["a", "b"], [bare("e", "a", "a")])], nodes: [] });
  });

  it("rejects an empty group", () => {
    throwsInvalid({ id: "p", groups: [group("g", [])], nodes: [node("a")] });
  });

  it("rejects non-positive sizes and an unmeasured label", () => {
    throwsInvalid({ id: "p", groups: [], nodes: [{ id: "a", width: 0, height: 72 }] });
    throwsInvalid({
      id: "p",
      groups: [
        group(
          "g",
          ["a", "b"],
          [{ id: "e", from: "a", to: "b", label: { text: "x", width: 0, height: 0, offsetX: 0, offsetY: 0 } }],
        ),
      ],
      nodes: [],
    });
  });

  describe("a tampered ELK result", () => {
    const tamper = async (mutate: (graph: ElkNode) => void) => {
      const raw = structuredClone(await rawLayout(oneSystem));
      mutate(raw);
      expect(() => readElkGraph(oneSystem, raw)).toThrow("Invalid ELK layout");
    };
    const sys = (g: ElkNode) => g.children!.find(({ id }) => id === "sys-a")!;

    // An edgeless group, so no route constrains the moved node: only the
    // containment check can catch it.
    it("rejects a node moved outside its group", async () => {
      const edgeless: ElkLayoutInput = {
        id: "p",
        groups: [group("g", ["a", "b"])],
        nodes: [],
      };
      const raw = structuredClone(await rawLayout(edgeless));
      const g = raw.children![0]!;
      expect(() => readElkGraph(edgeless, structuredClone(raw))).not.toThrow();
      g.children![0]!.x = g.x! + g.width! + 50;
      expect(() => readElkGraph(edgeless, raw)).toThrow("Invalid ELK layout");
    });
    it("rejects a missing edge", () =>
      tamper((g) => {
        sys(g).edges!.pop();
      }));
    it("rejects a missing node, a changed id and a changed size", async () => {
      await tamper((g) => {
        sys(g).children!.pop();
      });
      await tamper((g) => {
        g.id = "other";
      });
      await tamper((g) => {
        sys(g).children![0]!.width = 300;
      });
    });
    it("rejects overlapping nodes, a wrong endpoint and a diagonal route", async () => {
      await tamper((g) => {
        const [first, second] = sys(g).children!;
        second!.x = first!.x;
        second!.y = first!.y;
      });
      await tamper((g) => {
        sys(g).edges![0]!.sources = ["c"];
      });
      await tamper((g) => {
        sys(g).edges![0]!.sections![0]!.startPoint.x += 0.5;
      });
    });
    it("rejects a label that the request did not have", () =>
      tamper((g) => {
        const bareEdge = sys(g).edges!.find(({ id }) => id === "b>c")!;
        bareEdge.labels = [{ text: "invented", x: 0, y: 0, width: 5, height: 5 }];
      }));
  });
});
