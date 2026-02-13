import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
  clearCredentials: vi.fn(),
}));

import { register } from "./status.js";
import { readCredentials, clearCredentials } from "../credentials.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: any, handler: ToolHandler) => {
        handlers.set(_name, handler);
      },
    ),
  } as unknown as McpServer;
  return { server, handlers };
}

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

describe("status tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register both sapiom_status and sapiom_logout", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    expect(handlers.has("sapiom_status")).toBe(true);
    expect(handlers.has("sapiom_logout")).toBe(true);
  });

  describe("sapiom_status", () => {
    it("should return authenticated status when credentials exist", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(readCredentials).mockResolvedValue({
        apiKey: "sk-test",
        tenantId: "t-123",
        organizationName: "Test Org",
        apiKeyId: "k-456",
      });

      const result = await handlers.get("sapiom_status")!({});
      expect(result.content[0].text).toContain("Authenticated as Test Org");
      expect(result.content[0].text).toContain("t-123");
    });

    it("should return not-authenticated message when no credentials", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(readCredentials).mockResolvedValue(null);

      const result = await handlers.get("sapiom_status")!({});
      expect(result.content[0].text).toContain("Not authenticated");
      expect(result.content[0].text).toContain("sapiom_authenticate");
    });
  });

  describe("sapiom_logout", () => {
    it("should clear credentials and return success", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const result = await handlers.get("sapiom_logout")!({});
      expect(clearCredentials).toHaveBeenCalledWith("production");
      expect(result.content[0].text).toContain("Logged out successfully");
    });
  });
});
