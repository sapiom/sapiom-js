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

describe("renderGraphSvg with enrichment", () => {
  it("prefers enrichment sublabels over structural ones and adds <title> tooltips for descriptions", () => {
    const graph: CanvasGraph = {
      ...ORDER_TRIAGE_GRAPH,
      nodes: [
        { id: "intake", kind: "entry", label: "intake" },
        { id: "classify", kind: "pause", label: "classify", sublabel: 'waits for signal "go"' },
      ],
      edges: [],
    };
    const svg = renderGraphSvg(graph, {
      nodeDetails: {
        intake: { sublabel: "receives the order", description: "Entry point for order events." },
        classify: { sublabel: "AI-written override" },
      },
    });
    expect(svg).toContain(">receives the order</text>");
    expect(svg).toContain("<title>Entry point for order events.</title>");
    expect(svg).toContain(">AI-written override</text>");
    expect(svg).not.toContain('waits for signal "go"');
  });

  it("labels edges by the enrichment's from->to key and ignores keys for edges that don't exist", () => {
    const svg = renderGraphSvg(ORDER_TRIAGE_GRAPH, {
      edgeLabels: { "route->auto_resolve": "low priority", "ghost->nowhere": "never rendered" },
    });
    expect(svg).toContain(">low priority</text>");
    expect(svg).not.toContain("never rendered");
  });

  it("renders a background band + label for a group whose members all exist, behind the nodes", () => {
    const svg = renderGraphSvg(ORDER_TRIAGE_GRAPH, {
      layoutHints: { groups: [{ label: "decision core", nodeIds: ["classify", "route"] }] },
    });
    expect(svg).toContain('class="canvas-group-band"');
    expect(svg).toContain(">decision core</text>");
    // Behind everything: the band precedes the first node group in the markup.
    expect(svg.indexOf("canvas-group-band")).toBeLessThan(svg.indexOf("canvas-node"));
  });

  it("silently drops a group hint that references a node id not in the graph", () => {
    const svg = renderGraphSvg(ORDER_TRIAGE_GRAPH, {
      layoutHints: { groups: [{ label: "phantom", nodeIds: ["classify", "not-a-node"] }] },
    });
    expect(svg).not.toContain("canvas-group-band");
    expect(svg).not.toContain("phantom");
  });

  it("laneOrder reorders nodes within their computed layer only", () => {
    // auto_resolve and escalate share the terminal layer; default order is
    // insertion order (auto_resolve first). The hint flips them.
    const layout = layoutGraph(ORDER_TRIAGE_GRAPH, { "3": ["escalate", "auto_resolve"] });
    expect(layout.pos["escalate"].x).toBeLessThan(layout.pos["auto_resolve"].x);
    // Same y — the hint may not move a node between layers.
    expect(layout.pos["escalate"].y).toBe(layout.pos["auto_resolve"].y);
    expect(layout.pos["escalate"].y).toBeGreaterThan(layout.pos["route"].y);
  });

  it("ignores a laneOrder entry containing a node id that doesn't exist in the graph", () => {
    const base = layoutGraph(ORDER_TRIAGE_GRAPH);
    const hinted = layoutGraph(ORDER_TRIAGE_GRAPH, { "3": ["escalate", "no-such-node"] });
    expect(hinted.pos).toEqual(base.pos);
  });

  it("ignores a laneOrder entry whose listed node lives in a different layer — nodes never change layers", () => {
    const base = layoutGraph(ORDER_TRIAGE_GRAPH);
    // "intake" is in layer 0, listed under layer 3: every id exists, so the
    // hint applies to layer 3's row — but intake isn't in that row, so only
    // the row's own members reorder and intake stays exactly where it was.
    const hinted = layoutGraph(ORDER_TRIAGE_GRAPH, { "3": ["escalate", "intake", "auto_resolve"] });
    expect(hinted.pos["intake"]).toEqual(base.pos["intake"]);
    expect(hinted.pos["escalate"].x).toBeLessThan(hinted.pos["auto_resolve"].x);
  });

  it("escapes every enrichment-supplied string", () => {
    const svg = renderGraphSvg(ORDER_TRIAGE_GRAPH, {
      nodeDetails: { intake: { sublabel: '<img src=x onerror="1">', description: "a <b>bold</b> claim" } },
      edgeLabels: { "intake->classify": "<script>" },
      layoutHints: { groups: [{ label: "<style>", nodeIds: ["intake"] }] },
    });
    expect(svg).not.toContain("<img");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<style>");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
