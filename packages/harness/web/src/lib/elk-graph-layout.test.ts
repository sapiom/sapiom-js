import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  createElkGraph,
  readElkGraph,
  type ElkLayoutInput,
} from "./elk-graph-layout";
import { NODE_HEIGHT, NODE_WIDTH } from "./directed-graph-layout";

const fixture = (count: number, pairs: number[][]): ElkLayoutInput => ({
  id: "project/proposal",
  nodes: Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  })),
  edges: pairs.map(([from, to], i) => ({
    id: `e${i}`,
    from: `n${from}`,
    to: `n${to}`,
    label: "invokes · asynchronous",
    labelWidth: 196,
    labelHeight: 22,
    labelOffsetX: 98,
    labelOffsetY: 16,
  })),
});

describe("vertical ELK geometry", () => {
  it.each([
    fixture(0, []),
    fixture(1, []),
    fixture(4, [
      [0, 1],
      [1, 2],
      [2, 0],
      [0, 1],
      [2, 3],
    ]),
    fixture(
      8,
      Array.from({ length: 7 }, (_, i) => [0, i + 1]),
    ),
    fixture(
      6,
      Array.from({ length: 6 }, (_, from) =>
        Array.from({ length: from }, (_, to) => [from, to]),
      ).flat(),
    ),
  ])(
    "retains IDs, routes, dimensions and labels without overlaps ($nodes.length nodes)",
    async (input) => {
      const raw = await new ELK().layout(createElkGraph(input));
      const layout = readElkGraph(input, raw);
      expect(layout.nodes.map(({ id }) => id).sort()).toEqual(
        input.nodes.map(({ id }) => id).sort(),
      );
      expect(
        layout.edges
          .map(({ id, from, to, label }) => ({ id, from, to, label }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(
        input.edges
          .map(({ id, from, to, label }) => ({ id, from, to, label }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      expect(layout.bounds.width).toBeGreaterThan(0);
      for (const node of layout.nodes) {
        expect([node.width, node.height]).toEqual([NODE_WIDTH, NODE_HEIGHT]);
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y + node.height).toBeLessThanOrEqual(layout.bounds.height);
      }
      for (const edge of layout.edges) {
        expect(edge.path).toMatch(/^M [\d.]+ [\d.]+ L /);
        expect(edge.labelX).toBeLessThanOrEqual(layout.bounds.width);
        expect(edge.labelY).toBeLessThanOrEqual(layout.bounds.height);
      }
      expect(
        createElkGraph({
          ...input,
          nodes: [...input.nodes].reverse(),
          edges: [...input.edges].reverse(),
        }),
      ).toEqual(createElkGraph(input));
    },
  );

  it("includes label ink and routed points outside the declared root bounds", async () => {
    const input = fixture(2, [[0, 1]]),
      raw = await new ELK().layout(createElkGraph(input));
    raw.edges![0]!.labels![0]!.x = -200;
    const layout = readElkGraph(input, raw);
    expect(layout.edges[0]!.labelX).toBe(16 + input.edges[0]!.labelOffsetX);
    expect(layout.bounds.width).toBeGreaterThan(raw.width!);
    expect(layout.nodes[0]!.x).toBeGreaterThanOrEqual(216);
  });

  it("rejects missing/duplicate IDs, changed direction, dimensions, labels and nonfinite/diagonal routes", async () => {
    const input = fixture(2, [[0, 1]]),
      raw = await new ELK().layout(createElkGraph(input));
    const invalid = [
      (g: typeof raw) => {
        g.id = "obsolete-project";
      },
      (g: typeof raw) => {
        g.children!.pop();
      },
      (g: typeof raw) => {
        g.children![1]!.id = g.children![0]!.id;
      },
      (g: typeof raw) => {
        g.children![0]!.width = 300;
      },
      (g: typeof raw) => {
        g.children![1]!.x = g.children![0]!.x;
        g.children![1]!.y = g.children![0]!.y;
      },
      (g: typeof raw) => {
        g.edges![0]!.sources = ["n1"];
      },
      (g: typeof raw) => {
        g.edges![0]!.labels![0]!.text = "invented";
      },
      (g: typeof raw) => {
        g.edges![0]!.sections = [];
      },
      (g: typeof raw) => {
        g.edges![0]!.sections![0]!.endPoint.x = NaN;
      },
      (g: typeof raw) => {
        g.edges![0]!.sections![0]!.startPoint.x += 0.5;
      },
      (g: typeof raw) => {
        const section = g.edges![0]!.sections![0]!;
        for (const point of [
          section.startPoint,
          ...(section.bendPoints ?? []),
          section.endPoint,
        ])
          point.x += 10_000;
      },
    ];
    for (const mutate of invalid) {
      const changed = structuredClone(raw);
      mutate(changed);
      expect(() => readElkGraph(input, changed)).toThrow();
    }
    expect(() =>
      createElkGraph({ ...input, nodes: [...input.nodes, input.nodes[0]!] }),
    ).toThrow();
  });
});
