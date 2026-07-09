import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerTool } from "./register-tool.js";

type CapturedRegistration = {
  name: string;
  description: string;
  schema: unknown;
  handler: (args: unknown, extra: unknown) => unknown;
};

function createMockServer(): {
  server: McpServer;
  registrations: CapturedRegistration[];
} {
  const registrations: CapturedRegistration[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: unknown,
        handler: CapturedRegistration["handler"],
      ) => {
        registrations.push({ name, description, schema, handler });
      },
    ),
  } as unknown as McpServer;
  return { server, registrations };
}

describe("registerTool pass-through", () => {
  it("forwards name, description, and schema to server.tool verbatim", () => {
    const { server, registrations } = createMockServer();
    const schema = { dir: z.string() };

    registerTool(server, "tool_a", "does a thing", schema, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe("tool_a");
    expect(registrations[0].description).toBe("does a thing");
    expect(registrations[0].schema).toBe(schema);
  });

  it("invokes the handler with the same args and extra, and returns its result unchanged", async () => {
    const { server, registrations } = createMockServer();
    const result = { content: [{ type: "text" as const, text: "hello" }] };
    const seen: unknown[] = [];

    registerTool(
      server,
      "tool_b",
      "echo",
      { value: z.string() },
      async (args, extra) => {
        seen.push(args, extra);
        return result;
      },
    );

    const args = { value: "hi" };
    const extra = { signal: new AbortController().signal };
    const returned = await registrations[0].handler(args, extra);

    expect(seen[0]).toBe(args);
    expect(seen[1]).toBe(extra);
    expect(returned).toBe(result);
  });

  it("passes isError results through unchanged", async () => {
    const { server, registrations } = createMockServer();
    const errorResult = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: { code: "NOT_AUTHENTICATED" } }),
        },
      ],
      isError: true,
    };

    registerTool(server, "tool_c", "fails", {}, async () => errorResult);

    const returned = await registrations[0].handler({}, {});
    expect(returned).toBe(errorResult);
  });

  it("propagates a thrown error to the caller unchanged", async () => {
    const { server, registrations } = createMockServer();
    const boom = new TypeError("exploded");

    registerTool(server, "tool_d", "throws", {}, async () => {
      throw boom;
    });

    await expect(registrations[0].handler({}, {})).rejects.toBe(boom);
  });

  it("registers each tool exactly once, in call order", () => {
    const { server, registrations } = createMockServer();
    const handler = async () => ({
      content: [{ type: "text" as const, text: "x" }],
    });

    registerTool(server, "first", "1", {}, handler);
    registerTool(server, "second", "2", {}, handler);

    expect(registrations.map((r) => r.name)).toEqual(["first", "second"]);
  });
});
