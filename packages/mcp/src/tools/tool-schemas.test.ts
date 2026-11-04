/**
 * The JSON Schemas MCP clients see for tools built from zod shapes. The SDK
 * converts a shape at `tools/list` time, so this pins the fields clients rely on
 * (properties, required, types) whatever zod version produces them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ResolvedEnvironment } from "../credentials.js";
import { register as registerAgents } from "./agents.js";
import { register as registerFeedback } from "./feedback.js";
import { register as registerSandbox } from "./sandbox.js";

// Signed out: a tool that passes argument validation answers NOT_AUTHENTICATED.
vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(async () => null),
}));

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "sapiom-dev", version: "0.0.0" });
  registerSandbox(server, env);
  registerFeedback(server, env);
  registerAgents(server, env);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("tool input schemas over tools/list", () => {
  it("sapiom_dev_sandbox_configure exposes the sandbox body as a JSON Schema object", async () => {
    const { tools } = await (await connect()).listTools();
    const configure = tools.find(
      (tool) => tool.name === "sapiom_dev_sandbox_configure",
    )!;
    const schema = configure.inputSchema as {
      type: string;
      properties: Record<
        string,
        { type?: string; additionalProperties?: { type?: string } }
      >;
      required?: string[];
    };

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "build",
      "dir",
      "env",
      "name",
      "port",
      "source",
      "start",
      "tier",
      "ttl",
    ]);
    expect(schema.required).toEqual(
      expect.arrayContaining(["name", "source", "start", "port"]),
    );
    expect(schema.properties.env).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });

    const feedback = tools.find(
      (tool) => tool.name === "sapiom_send_feedback",
    )!;
    expect(feedback.inputSchema.type).toBe("object");
    expect(feedback.inputSchema.required).toEqual(["message"]);
  });

  it("answers an argument of the wrong type with an error result", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-tool-schemas-"));
    temps.push(dir);

    const result = await (
      await connect()
    ).callTool({
      name: "sapiom_dev_sandbox_configure",
      arguments: {
        dir,
        name: "web",
        source: { kind: "upload" },
        start: "node server.js",
        port: "x",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("sapiom_dev_agents_emit_event accepts an omitted payload", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const emit = tools.find(
      (tool) => tool.name === "sapiom_dev_agents_emit_event",
    )!;
    expect(emit.inputSchema.required).toEqual(["type"]);

    const result = await client.callTool({
      name: "sapiom_dev_agents_emit_event",
      arguments: { type: "heartbeat.tick" },
    });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).error.code).toBe("NOT_AUTHENTICATED");
  });
});
