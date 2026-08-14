import { describe, expect, it } from "vitest";

import {
  graphCounts,
  nodeKindLabel,
  parseCanvasGraph,
  type CanvasGraph,
} from "./canvas-graph";

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

describe("parseCanvasGraph", () => {
  it("preserves the complete entry schema needed by the Run sheet", () => {
    const graph = parseCanvasGraph({
      name: "weather",
      entry: "fetchWeather",
      nodes: [
        {
          id: "fetchWeather",
          kind: "entry",
          inputSchema: {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "City to inspect",
                default: "London",
                enum: ["London", "Paris"],
              },
            },
            required: ["city"],
          },
        },
      ],
      edges: [],
    });

    expect(graph?.nodes[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City to inspect",
          default: "London",
          enum: ["London", "Paris"],
        },
      },
      required: ["city"],
    });
  });
});
