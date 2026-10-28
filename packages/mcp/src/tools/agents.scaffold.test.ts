import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ResolvedEnvironment } from "../credentials.js";
import { register } from "./agents.js";

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function scaffoldTool(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    }),
  } as unknown as McpServer;
  register(server, env);
  return handlers.get("sapiom_dev_agents_scaffold")!;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sapiom_dev_agents_scaffold template names (SAP-4381)", () => {
  // `../src` is a real directory next to agent-core's bundled templates: before the fix it was
  // copied into the project and npm-installed like a template.
  it.each(["../src", "../../agent-core/src"])("rejects %j without creating the project", async (template) => {
    const base = mkdtempSync(path.join(os.tmpdir(), "sapiom-scaffold-tool-"));
    temps.push(base);
    const dir = path.join(base, "project");

    const res = await scaffoldTool()({ dir, template });

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error.code).toBe("UNKNOWN_TEMPLATE");
    expect(existsSync(dir)).toBe(false);
  });
});
