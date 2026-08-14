import { describe, expect, it } from "vitest";

import { readWorkflowInputContract } from "./input-contract.js";

function extracted(inputSchema: Record<string, unknown> | null) {
  return {
    cached: false,
    fingerprint: "1:1",
    result: {
      ok: true as const,
      graph: {
        manifestName: "newsletter",
        entry: "research",
        nodes: [
          {
            id: "research",
            kind: "entry" as const,
            label: "Research",
            inputSchema,
          },
        ],
        edges: [],
        warnings: [],
      },
    },
  };
}

describe("readWorkflowInputContract", () => {
  it("returns the full entry schema and prefers its author example", async () => {
    const jsonSchema = {
      type: "object",
      properties: {
        niche: { type: "string", description: "Newsletter topic" },
      },
      required: ["niche"],
      examples: [{ niche: "indie games" }],
    };

    await expect(
      readWorkflowInputContract("/agent", async () => extracted(jsonSchema)),
    ).resolves.toEqual({
      status: "available",
      jsonSchema,
      example: { niche: "indie games" },
    });
  });

  it("builds a typed skeleton when no example is declared", async () => {
    await expect(
      readWorkflowInputContract("/agent", async () =>
        extracted({
          type: "object",
          properties: {
            topic: { type: "string" },
            limit: { type: "number" },
            enabled: { type: "boolean" },
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "available",
      example: { topic: "", limit: 0, enabled: false },
    });
  });

  it("distinguishes no declared contract from extraction failure", async () => {
    await expect(
      readWorkflowInputContract("/agent", async () => extracted(null)),
    ).resolves.toEqual({ status: "none", jsonSchema: null, example: {} });

    await expect(
      readWorkflowInputContract("/agent", async () => ({
        cached: false,
        fingerprint: "1:1",
        result: { ok: false as const, reason: "/private/details" },
      })),
    ).resolves.toEqual({
      status: "unavailable",
      jsonSchema: null,
      example: {},
      reason:
        "Studio couldn't extract this agent's input contract. You can still run it with raw JSON.",
    });
  });
});
