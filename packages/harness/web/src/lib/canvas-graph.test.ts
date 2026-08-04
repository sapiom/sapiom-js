import { describe, expect, it } from "vitest";

import { graphCounts, nodeKindLabel, type CanvasGraph } from "./canvas-graph";

describe("nodeKindLabel", () => {
  it("renders the private launched-workflow kind as a launched agent", () => {
    expect(nodeKindLabel("launched-workflow")).toBe("Launched agent");
  });
});

describe("graphCounts", () => {
  it("counts pipeline steps separately from exits and launched-agent placeholders", () => {
    const graph = {
      nodes: [
        { id: "start", kind: "entry" },
        { id: "done", kind: "terminal-success" },
        { id: "launch:child", kind: "launched-workflow" },
      ],
    } as CanvasGraph;

    expect(graphCounts(graph)).toEqual({ steps: 1, exits: 1 });
  });
});
