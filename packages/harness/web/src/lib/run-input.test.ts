import { describe, expect, it } from "vitest";

import {
  createInputValidator,
  defaultsFromSchema,
  fieldPathForError,
  inputContractFromCanvasGraph,
  requiredSkeletonFromSchema,
  resetValueForSchema,
  schemaSignature,
} from "./run-input";
import type { CanvasGraph } from "./canvas-graph";

describe("run input helpers", () => {
  it("prefers an author example, then defaults, then a required skeleton", () => {
    expect(
      resetValueForSchema({
        type: "object",
        examples: [{ topic: "example" }],
        properties: { topic: { type: "string", default: "default" } },
      }),
    ).toEqual({ topic: "example" });

    expect(
      resetValueForSchema({
        type: "object",
        properties: {
          topic: { type: "string", default: "default" },
          optional: { type: "string" },
        },
      }),
    ).toEqual({ topic: "default" });

    expect(
      resetValueForSchema({
        type: "object",
        required: ["topic", "enabled"],
        properties: {
          topic: { type: "string" },
          enabled: { type: "boolean" },
          optional: { type: "number" },
        },
      }),
    ).toEqual({ topic: "", enabled: false });
  });

  it("collects nested defaults without materializing optional empty fields", () => {
    expect(
      defaultsFromSchema({
        type: "object",
        properties: {
          delivery: {
            type: "object",
            properties: {
              channel: { type: "string", default: "email" },
              note: { type: "string" },
            },
          },
        },
      }),
    ).toEqual({ delivery: { channel: "email" } });
  });

  it("builds nested required objects and validates with AJV", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["delivery"],
      properties: {
        delivery: {
          type: "object",
          required: ["limit"],
          properties: { limit: { type: "integer", minimum: 1 } },
        },
      },
    };
    expect(requiredSkeletonFromSchema(schema)).toEqual({ delivery: { limit: 0 } });
    const errors = createInputValidator(schema).validateValue({
      delivery: { limit: 0 },
    });
    expect(errors).toHaveLength(1);
    expect(fieldPathForError(errors[0]!)).toBe("/delivery/limit");
  });

  it("produces the same signature regardless of object key order", () => {
    expect(schemaSignature({ type: "string", title: "Topic" })).toBe(
      schemaSignature({ title: "Topic", type: "string" }),
    );
  });

  it("reuses the visible entry-step schema as a complete run contract", () => {
    const schema = {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City to inspect",
          default: "London",
        },
      },
      required: ["city"],
    };
    const graph: CanvasGraph = {
      name: "weather",
      entry: "fetchWeather",
      nodes: [
        {
          id: "fetchWeather",
          kind: "entry",
          label: "fetchWeather",
          role: "entry",
          description: "",
          timeoutMs: null,
          inputSchema: schema,
          capabilities: [],
        },
      ],
      edges: [],
      groups: [],
      warnings: [],
    };

    expect(inputContractFromCanvasGraph(graph)).toEqual({
      status: "available",
      jsonSchema: schema,
      example: { city: "London" },
    });
  });
});
