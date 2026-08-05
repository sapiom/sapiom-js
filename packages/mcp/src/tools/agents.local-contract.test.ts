import { describe, expect, it, vi } from "vitest";
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

describe("local agent tool contracts", () => {
  it("describes the real local boundary and current coding stub paths", () => {
    const descriptions = new Map<string, string>();
    const schemas = new Map<string, Record<string, { description?: string }>>();
    const server = {
      tool: vi.fn(
        (
          name: string,
          description: string,
          schema: Record<string, { description?: string }>,
        ) => {
          descriptions.set(name, description);
          schemas.set(name, schema);
        },
      ),
    } as unknown as McpServer;

    register(server, env);

    const check = descriptions.get("sapiom_dev_agents_check") ?? "";
    expect(check).toContain("no Sapiom account or service call");
    expect(check).not.toMatch(/offline|instant/i);

    const runLocal = descriptions.get("sapiom_dev_agents_run_local") ?? "";
    expect(runLocal).toContain("models.coding.launch");
    expect(runLocal).not.toContain("agent.coding.launch");
    expect(runLocal).toContain("Author code is ordinary local code");
    expect(runLocal).not.toContain("instant");

    const stubs =
      schemas.get("sapiom_dev_agents_run_local")?.stubs?.description ?? "";
    expect(stubs).toContain("not a sequence of responses");
    expect(stubs).not.toContain("<response> | [<response>]");

    const deploy = descriptions.get("sapiom_dev_agents_deploy") ?? "";
    expect(deploy).toContain("current local source");
    expect(deploy).toContain("including uncommitted source");
    expect(deploy).toContain("metered cloud build");
    expect(deploy).not.toContain("current git commit");
  });
});
