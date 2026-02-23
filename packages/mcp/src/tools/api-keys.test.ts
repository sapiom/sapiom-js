import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../fetch.js", () => ({
  getAuthenticatedClient: vi.fn(),
}));

import { register } from "./api-keys.js";
import { getAuthenticatedClient } from "../fetch.js";

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

describe("api-keys tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register sapiom_create_transaction_api_key", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    expect(handlers.has("sapiom_create_transaction_api_key")).toBe(true);
  });

  describe("sapiom_create_transaction_api_key", () => {
    it("should return error when not authenticated", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(getAuthenticatedClient).mockResolvedValue(null);

      const result = await handlers.get("sapiom_create_transaction_api_key")!({
        name: "test-key",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not authenticated");
    });

    it("should create a transaction key and return plainKey with security instructions", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockCreateTransactionKey = vi.fn().mockResolvedValue({
        apiKey: { id: "ak-789", name: "my-payment-key" },
        plainKey: "sk_live_abc123def456",
      });
      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        apiKeys: { createTransactionKey: mockCreateTransactionKey },
      } as any);

      const result = await handlers.get("sapiom_create_transaction_api_key")!({
        name: "my-payment-key",
        description: "For checkout payments",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("sk_live_abc123def456");
      expect(result.content[0].text).toContain("my-payment-key");
      expect(result.content[0].text).toContain("ak-789");
      expect(result.content[0].text).toContain("SECURITY");
      expect(result.content[0].text).toContain(".env");
      expect(result.content[0].text).toContain("NEVER expose");
      expect(mockCreateTransactionKey).toHaveBeenCalledWith({
        name: "my-payment-key",
        description: "For checkout payments",
      });
    });

    it("should pass undefined description when not provided", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockCreateTransactionKey = vi.fn().mockResolvedValue({
        apiKey: { id: "ak-001", name: "no-desc-key" },
        plainKey: "sk_live_xyz",
      });
      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        apiKeys: { createTransactionKey: mockCreateTransactionKey },
      } as any);

      await handlers.get("sapiom_create_transaction_api_key")!({
        name: "no-desc-key",
      });

      expect(mockCreateTransactionKey).toHaveBeenCalledWith({
        name: "no-desc-key",
        description: undefined,
      });
    });

    it("should return error on API failure", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        apiKeys: {
          createTransactionKey: vi
            .fn()
            .mockRejectedValue(new Error("Insufficient permissions")),
        },
      } as any);

      const result = await handlers.get("sapiom_create_transaction_api_key")!({
        name: "bad-key",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Insufficient permissions");
    });

    it("should handle network errors", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(getAuthenticatedClient).mockResolvedValue({
        apiKeys: {
          createTransactionKey: vi
            .fn()
            .mockRejectedValue(new Error("Network unreachable")),
        },
      } as any);

      const result = await handlers.get("sapiom_create_transaction_api_key")!({
        name: "net-error-key",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Network unreachable");
    });
  });
});
