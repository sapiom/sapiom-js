import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";

import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({ readCredentials: vi.fn() }));

import { register } from "./agents.js";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
} as ResolvedEnvironment;

/** Capture the schemas `register` hands to `server.tool(name, desc, schema, handler)`. */
function registeredSchemas(): Map<string, ZodRawShape> {
  const schemas = new Map<string, ZodRawShape>();
  const server = {
    tool: vi.fn((name: string, _desc: string, schema: ZodRawShape) => {
      schemas.set(name, schema);
    }),
  } as unknown as McpServer;
  register(server, env);
  return schemas;
}

/**
 * Execution ids are numeric (bigint server-side). A bare `z.string()` let a model pass a step name
 * or a variable (`result`, `child-expert-1`) and get back "execution not found" — which reads as
 * "the run is gone" rather than "that is not an id", so the mistake was never self-correcting
 * (SAP-3337). The MCP SDK validates the shape before the handler runs, so the regex message is what
 * the model sees, before any request leaves.
 */
describe("executionId schemas reject a non-numeric execution id", () => {
  const schemas = registeredSchemas();
  const EXPECTED_MESSAGE =
    'executionId must be the numeric execution id from run/launch or a listed execution (e.g. "4821"), not a step name or variable.';

  const toolNames = ["sapiom_dev_agents_inspect", "sapiom_dev_agents_signal"];

  it.each(toolNames)("%s declares an executionId", (name) => {
    expect(schemas.get(name)?.executionId).toBeDefined();
  });

  it.each(toolNames)("%s rejects a step name with a message naming the fix", (name) => {
    const schema = schemas.get(name)!.executionId as z.ZodType<unknown>;
    const result = schema.safeParse("result");

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(EXPECTED_MESSAGE);
  });

  it.each(toolNames)("%s accepts a numeric execution id", (name) => {
    const schema = schemas.get(name)!.executionId as z.ZodType<unknown>;

    expect(schema.safeParse("4821").success).toBe(true);
  });

  it("keeps inspect's executionId optional (it also lists and reads builds)", () => {
    const schema = schemas.get("sapiom_dev_agents_inspect")!
      .executionId as z.ZodType<unknown>;

    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it("requires signal's executionId (there is nothing to resume without one)", () => {
    const schema = schemas.get("sapiom_dev_agents_signal")!
      .executionId as z.ZodType<unknown>;

    expect(schema.safeParse(undefined).success).toBe(false);
  });
});
