import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

// Mock dependencies
vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
  writeCredentials: vi.fn(),
}));

vi.mock("../auth.js", () => ({
  performBrowserAuth: vi.fn(),
}));

import { register } from "./authenticate.js";
import { readCredentials, writeCredentials } from "../credentials.js";
import { performBrowserAuth } from "../auth.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer(): {
  server: McpServer;
  getHandler: () => ToolHandler;
} {
  let captured: ToolHandler | null = null;
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: any, handler: ToolHandler) => {
        captured = handler;
      },
    ),
  } as unknown as McpServer;
  return {
    server,
    getHandler: () => {
      if (!captured) throw new Error("No handler registered");
      return captured;
    },
  };
}

const env: ResolvedEnvironment = {
  name: "production",
  appURL: "https://app.sapiom.ai",
  apiURL: "https://api.sapiom.ai",
  services: {},
  credentials: null,
};

describe("sapiom_authenticate tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register the tool with correct name", () => {
    const { server } = createMockServer();
    register(server, env);
    expect(server.tool).toHaveBeenCalledWith(
      "sapiom_authenticate",
      expect.any(String),
      {},
      expect.any(Function),
    );
  });

  it("should return already-authenticated message when credentials exist", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue({
      apiKey: "sk-test",
      tenantId: "t-123",
      organizationName: "Test Org",
      apiKeyId: "k-456",
    });

    const result = await getHandler()({});
    expect(result.content[0].text).toContain("Already authenticated");
    expect(result.content[0].text).toContain("Test Org");
    expect(performBrowserAuth).not.toHaveBeenCalled();
  });

  it("should perform browser auth and save credentials on success", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockResolvedValue({
      apiKey: "sk-new",
      tenantId: "t-new",
      organizationName: "New Org",
      apiKeyId: "k-new",
    });

    const result = await getHandler()({});
    expect(result.content[0].text).toContain("Successfully authenticated");
    expect(result.content[0].text).toContain("New Org");
    expect(writeCredentials).toHaveBeenCalledWith(
      "production",
      "https://app.sapiom.ai",
      "https://api.sapiom.ai",
      {
        apiKey: "sk-new",
        tenantId: "t-new",
        organizationName: "New Org",
        apiKeyId: "k-new",
      },
    );
  });

  it("should return error when browser auth fails", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockRejectedValue(
      new Error("Timed out after 5 minutes"),
    );

    const result = await getHandler()({});
    expect(result.content[0].text).toContain("Authentication failed");
    expect(result.content[0].text).toContain("Timed out");
    expect(result.isError).toBe(true);
  });

  it("should handle non-Error thrown values", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockRejectedValue("string error");

    const result = await getHandler()({});
    expect(result.content[0].text).toContain("Unknown error");
    expect(result.isError).toBe(true);
  });
});
