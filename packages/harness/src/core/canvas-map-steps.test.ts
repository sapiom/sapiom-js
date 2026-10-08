import { describe, expect, it } from "vitest";

import type { CanvasGraph } from "./canvas-graph.js";
import { graphFromMap, parseCanvasMapInput, type CanvasMapInput } from "./canvas-map-steps.js";
import { layoutGraph, NODE_W, renderGraphSvg } from "./canvas-svg.js";

const steps: NonNullable<CanvasMapInput["steps"]> = {
  entry: "receive",
  steps: [
    { id: "receive", file: "agents/copilot/index.ts", line: 10 },
    { id: "draft", file: "agents/copilot/index.ts", line: 30 },
    { id: "notify", file: "agents/copilot/index.ts", line: 50 },
  ],
  transitions: [
    { from: "receive", to: "draft", kind: "continue" },
    { from: "draft", to: "notify", kind: "continue" },
  ],
};

const input = (overrides: Partial<CanvasMapInput> = {}): CanvasMapInput => ({
  steps,
  calls: [
    { to: "escalation", kind: "launch", fromStep: "notify" },
    { to: "digest", kind: "event ticket.closed" },
  ],
  calledBy: [{ from: "intake", kind: "event ticket.opened" }],
  ...overrides,
});

const details: CanvasGraph = {
  manifestName: "copilot",
  description: "Drafts replies.",
  entry: "receive",
  nodes: [
    { id: "receive", kind: "entry", label: "receive", description: "Reads the ticket", inputSchema: { type: "object" } },
    { id: "draft", kind: "step", label: "draft", capabilities: ["ai.chat"] },
    { id: "notify", kind: "terminal-warn", label: "notify", sublabel: "terminal · fail" },
    { id: "launch:old", kind: "launched-workflow", label: "old" },
  ],
  edges: [
    { from: "receive", to: "draft", kind: "branching" },
    { from: "notify", to: "launch:old", kind: "launch", label: "launch()" },
  ],
  warnings: ["entry step declares no inputSchema"],
};

const fallback = { manifestName: "copilot", description: "" };

describe("graphFromMap", () => {
  it("draws the map's steps and transitions, with agents at the border", () => {
    const graph = graphFromMap(input(), null, fallback)!;
    expect(graph.entry).toBe("receive");
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["receive", "entry"],
      ["draft", "step"],
      ["notify", "terminal-success"],
      ["agent:escalation", "launched-workflow"],
      ["agent:digest", "launched-workflow"],
      ["agent:intake", "launched-workflow"],
    ]);
    expect(graph.edges).toEqual([
      { from: "receive", to: "draft", kind: "sequential" },
      { from: "draft", to: "notify", kind: "sequential" },
      { from: "notify", to: "agent:escalation", kind: "launch" },
      { from: "receive", to: "agent:digest", kind: "launch" },
      { from: "agent:intake", to: "receive", kind: "launch" },
    ]);
  });

  it("starts a call at its step when known, else at the entry, and skips self edges", () => {
    const graph = graphFromMap(
      input({
        calls: [
          { to: "x", kind: "launch", fromStep: "not-a-step" },
          { to: "copilot", kind: "signal" },
        ],
        calledBy: [{ from: "copilot", kind: "launch" }],
      }),
      null,
      fallback,
    )!;
    expect(graph.edges.filter((e) => e.to.startsWith("agent:") || e.from.startsWith("agent:"))).toEqual([
      { from: "receive", to: "agent:x", kind: "launch" },
    ]);
  });

  it("joins agents check's details by step id and drops its launch nodes", () => {
    const graph = graphFromMap(input(), details, fallback)!;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("receive")).toMatchObject({ kind: "entry", description: "Reads the ticket", inputSchema: { type: "object" } });
    expect(byId.get("draft")).toMatchObject({ kind: "step", capabilities: ["ai.chat"] });
    expect(byId.get("notify")).toMatchObject({ kind: "terminal-warn", sublabel: "terminal · fail" });
    expect(byId.has("launch:old")).toBe(false);
    expect(graph.edges[0]).toEqual({ from: "receive", to: "draft", kind: "branching" });
    expect(graph.warnings).toEqual(details.warnings);
    expect(graph.description).toBe("Drafts replies.");
  });

  it("keeps the working copy's steps when the map has none, still with border agents", () => {
    const graph = graphFromMap(input({ steps: null }), details, fallback)!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["receive", "draft", "notify", "agent:escalation", "agent:digest", "agent:intake"]);
    expect(graphFromMap(input({ steps: null }), null, fallback)).toBeNull();
  });

  it("keeps the entry on the board, ends a step whose only transitions go nowhere, and names an agent both called and calling", () => {
    const graph = graphFromMap(
      {
        steps: {
          entry: "start",
          steps: [{ id: "a" }, { id: "b" }],
          transitions: [
            { from: "start", to: "a", kind: "continue" },
            { from: "a", to: "b", kind: "continue" },
            { from: "b", to: "missing", kind: "continue" },
            { from: "b", to: "b", kind: "continue" },
          ],
        },
        calls: [{ to: "peer", kind: "launch" }],
        calledBy: [{ from: "peer", kind: "event x" }],
      },
      null,
      fallback,
    )!;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")?.kind).toBe("entry");
    expect(byId.get("b")?.kind).toBe("terminal-success");
    expect(byId.get("agent:peer")?.sublabel).toBe("agent · calls this agent");
    expect(graph.edges).toContainEqual({ from: "start", to: "agent:peer", kind: "launch" });
  });

  it("labels an edge only when the map carries a label", () => {
    const graph = graphFromMap(input({ calls: [{ to: "escalation", kind: "launch", label: "hands work to" }] }), null, fallback)!;
    expect(graph.edges.find((e) => e.to === "agent:escalation")?.label).toBe("hands work to");
  });
});

describe("parseCanvasMapInput", () => {
  it("accepts the map request and refuses malformed or oversized ones", () => {
    expect(parseCanvasMapInput(input())).not.toBeNull();
    expect(parseCanvasMapInput({ ...input(), extra: 1 })).toBeNull();
    expect(parseCanvasMapInput({ steps: null, calls: [{ to: "" , kind: "launch" }], calledBy: [] })).toBeNull();
    expect(parseCanvasMapInput(undefined)).toBeNull();
  });
});

describe("the board's border column", () => {
  it("places other agents in one column right of every step, beside the step they touch", () => {
    const graph = graphFromMap(input(), null, fallback)!;
    const layout = layoutGraph(graph);
    const stepRight = Math.max(...["receive", "draft", "notify"].map((id) => layout.pos[id]!.x + NODE_W));
    const column = ["agent:escalation", "agent:digest", "agent:intake"].map((id) => layout.pos[id]!);
    expect(new Set(column.map((p) => p.x)).size).toBe(1);
    expect(column[0]!.x).toBeGreaterThan(stepRight);
    expect(column[0]!.y).toBeGreaterThanOrEqual(layout.pos.notify!.y);
    for (let i = 1; i < column.length; i++) expect(column[i]!.y).toBeGreaterThan(column[i - 1]!.y);
    expect(layout.width).toBeGreaterThanOrEqual(column[0]!.x + NODE_W);
    expect(layout.height).toBeGreaterThanOrEqual(column[2]!.y);
  });

  it("marks nodes and edges so a reader can tell which step a call leaves", () => {
    const svg = renderGraphSvg(graphFromMap(input(), null, fallback)!);
    expect(svg).toContain('data-node-id="agent:escalation"');
    expect(svg).toContain('data-edge-from="notify" data-edge-to="agent:escalation"');
    expect(svg).toContain('data-edge-from="agent:intake" data-edge-to="receive"');
  });
});
