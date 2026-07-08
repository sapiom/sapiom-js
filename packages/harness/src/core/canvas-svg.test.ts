import { describe, expect, it } from "vitest";
import type { CanvasGraph } from "./canvas-graph.js";
import { computeLayers, layoutGraph, renderGraphSvg, usedKinds } from "./canvas-svg.js";

const ORDER_TRIAGE_GRAPH: CanvasGraph = {
  manifestName: "order-triage",
  entry: "intake",
  warnings: [],
  nodes: [
    { id: "intake", kind: "entry", label: "intake" },
    { id: "classify", kind: "step", label: "classify" },
    { id: "route", kind: "step", label: "route" },
    { id: "auto_resolve", kind: "terminal-success", label: "auto_resolve" },
    { id: "escalate", kind: "terminal-success", label: "escalate" },
  ],
  edges: [
    { from: "intake", to: "classify", kind: "sequential" },
    { from: "classify", to: "route", kind: "sequential" },
    { from: "route", to: "auto_resolve", kind: "branching" },
    { from: "route", to: "escalate", kind: "branching" },
  ],
};

describe("computeLayers", () => {
  it("assigns sequential layers to a straight chain", () => {
    const layers = computeLayers(
      [{ id: "a" } as never, { id: "b" } as never, { id: "c" } as never],
      [
        { from: "a", to: "b" } as never,
        { from: "b", to: "c" } as never,
      ],
    );
    expect(layers.get("a")).toBe(0);
    expect(layers.get("b")).toBe(1);
    expect(layers.get("c")).toBe(2);
  });

  it("assigns the longest-path layer when branches reconverge (a diamond)", () => {
    // a -> b -> d, a -> c -> ... -> d (longer path), d should land past both.
    const layers = computeLayers(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "e" }, { id: "d" }].map((n) => n as never),
      [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "c", to: "e" },
        { from: "b", to: "d" },
        { from: "e", to: "d" },
      ].map((e) => e as never),
    );
    expect(layers.get("a")).toBe(0);
    expect(layers.get("b")).toBe(1);
    expect(layers.get("c")).toBe(1);
    expect(layers.get("e")).toBe(2);
    // d is reachable via a->b->d (layer 2) and a->c->e->d (layer 3) — longest wins.
    expect(layers.get("d")).toBe(3);
  });

  it("never hangs on a cycle — bounded iteration still assigns every node a layer", () => {
    const layers = computeLayers(
      [{ id: "a" }, { id: "b" }].map((n) => n as never),
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ].map((e) => e as never),
    );
    expect(layers.size).toBe(2);
  });

  it("gives a node unreachable from any root (a disconnected 2-cycle with no in-degree-0 entry) a layer past the deepest known one, instead of vanishing", () => {
    // a -> b is the main chain (layers 0, 1); x <-> y is a disconnected
    // island where both nodes have in-degree > 0, so neither starts a BFS.
    const layers = computeLayers(
      [{ id: "a" }, { id: "b" }, { id: "x" }, { id: "y" }].map((n) => n as never),
      [
        { from: "a", to: "b" },
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ].map((e) => e as never),
    );
    expect(layers.get("x")).toBe(2);
    expect(layers.get("y")).toBe(2);
  });
});

describe("layoutGraph", () => {
  it("centers each layer's row and stacks layers top to bottom", () => {
    const layout = layoutGraph(ORDER_TRIAGE_GRAPH);
    // intake, classify, route are each alone in their layer — same x (centered).
    expect(layout.pos.intake!.x).toBe(layout.pos.classify!.x);
    expect(layout.pos.classify!.x).toBe(layout.pos.route!.x);
    expect(layout.pos.intake!.y).toBeLessThan(layout.pos.classify!.y);
    expect(layout.pos.classify!.y).toBeLessThan(layout.pos.route!.y);
    // auto_resolve and escalate share a layer — same y, different x.
    expect(layout.pos.auto_resolve!.y).toBe(layout.pos.escalate!.y);
    expect(layout.pos.auto_resolve!.x).not.toBe(layout.pos.escalate!.x);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});

describe("renderGraphSvg", () => {
  const svg = renderGraphSvg(ORDER_TRIAGE_GRAPH);

  it("emits one <g class=\"canvas-node ...\"> per node, tagged with its kind", () => {
    expect((svg.match(/class="canvas-node node--entry"/g) ?? []).length).toBe(1);
    expect((svg.match(/class="canvas-node node--step"/g) ?? []).length).toBe(2);
    expect((svg.match(/class="canvas-node node--terminal-success"/g) ?? []).length).toBe(2);
  });

  it("emits one <path class=\"canvas-edge...\"> per edge", () => {
    expect((svg.match(/<path class="canvas-edge/g) ?? []).length).toBe(4);
  });

  it("uses a straight line for a sequential edge and a curve for branching edges", () => {
    expect(svg).toMatch(/M\d+(\.\d+)?,\d+(\.\d+)? L\d+/); // sequential: M...L...
    expect(svg).toMatch(/M\d+(\.\d+)?,\d+(\.\d+)? C\d+/); // branching: M...C...
  });

  it("never emits its own <defs> — the shared document shell provides glow filter + arrow markers once", () => {
    expect(svg).not.toContain("<defs>");
    expect(svg).toContain('filter="url(#canvas-glow)"');
    expect(svg).toContain('marker-end="url(#canvas-arrow)"');
  });

  it("escapes node labels", () => {
    const graph: CanvasGraph = {
      ...ORDER_TRIAGE_GRAPH,
      nodes: [{ id: "a", kind: "entry", label: '<script>alert("x")</script>' }],
      edges: [],
    };
    const rendered = renderGraphSvg(graph);
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
  });

  it("silently skips an edge whose endpoint isn't in the node set, rather than crashing", () => {
    const graph: CanvasGraph = {
      ...ORDER_TRIAGE_GRAPH,
      nodes: [{ id: "a", kind: "entry", label: "a" }],
      edges: [{ from: "a", to: "does-not-exist", kind: "sequential" }],
    };
    expect(() => renderGraphSvg(graph)).not.toThrow();
  });
});

describe("usedKinds", () => {
  it("collects every distinct node and edge kind present in the graph", () => {
    const { nodeKinds, edgeKinds } = usedKinds(ORDER_TRIAGE_GRAPH);
    expect([...nodeKinds].sort()).toEqual(["entry", "step", "terminal-success"]);
    expect([...edgeKinds].sort()).toEqual(["branching", "sequential"]);
  });
});
