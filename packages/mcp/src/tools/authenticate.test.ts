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
  performDeviceAuth: vi.fn(),
}));

import { register } from "./authenticate.js";
import { readCredentials, writeCredentials } from "../credentials.js";
import { performBrowserAuth, performDeviceAuth } from "../auth.js";

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
      (
        _name: string,
        _desc: string,
        _schema: any,
        handler: ToolHandler,
      ) => {
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

  it("should register the tool with correct name and schema", () => {
    const { server } = createMockServer();
    register(server, env);
    expect(server.tool).toHaveBeenCalledWith(
      "sapiom_authenticate",
      expect.any(String),
      expect.objectContaining({ method: expect.anything() }),
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
    expect(performDeviceAuth).not.toHaveBeenCalled();
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

  it("should fall back to device auth when browser auth fails (default mode)", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockRejectedValue(
      new Error("Failed to start local server"),
    );
    vi.mocked(performDeviceAuth).mockResolvedValue({
      initiation: {
        device_code: "dc",
        user_code: "WDJB-MJHT",
        verification_uri: "https://app.sapiom.ai/auth/device",
        verification_uri_complete:
          "https://app.sapiom.ai/auth/device?code=WDJBMJHT",
        expires_in: 600,
        interval: 5,
      },
      result: Promise.resolve({
        apiKey: "sk-device",
        tenantId: "t-device",
        organizationName: "Device Org",
        apiKeyId: "k-device",
      }),
    });

    const result = await getHandler()({});
    expect(result.content[0].text).toContain("Successfully authenticated");
    expect(result.content[0].text).toContain("Device Org");
    expect(result.content[0].text).toContain("device code");
    expect(writeCredentials).toHaveBeenCalledWith(
      "production",
      "https://app.sapiom.ai",
      "https://api.sapiom.ai",
      expect.objectContaining({ apiKey: "sk-device" }),
    );
  });

  it('should use device auth when method is "device"', async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performDeviceAuth).mockResolvedValue({
      initiation: {
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: "https://app.sapiom.ai/auth/device",
        verification_uri_complete:
          "https://app.sapiom.ai/auth/device?code=ABCDEFGH",
        expires_in: 600,
        interval: 5,
      },
      result: Promise.resolve({
        apiKey: "sk-dev",
        tenantId: "t-dev",
        organizationName: "Dev Org",
        apiKeyId: "k-dev",
      }),
    });

    const result = await getHandler()({ method: "device" });
    expect(result.content[0].text).toContain("Successfully authenticated");
    expect(performBrowserAuth).not.toHaveBeenCalled();
    expect(performDeviceAuth).toHaveBeenCalled();
  });

  it('should use browser auth when method is "browser"', async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockResolvedValue({
      apiKey: "sk-browser",
      tenantId: "t-browser",
      organizationName: "Browser Org",
      apiKeyId: "k-browser",
    });

    const result = await getHandler()({ method: "browser" });
    expect(result.content[0].text).toContain("Successfully authenticated");
    expect(performBrowserAuth).toHaveBeenCalled();
    expect(performDeviceAuth).not.toHaveBeenCalled();
  });

  it("should return error when browser auth fails with explicit method", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockRejectedValue(
      new Error("Timed out after 5 minutes"),
    );

    const result = await getHandler()({ method: "browser" });
    expect(result.content[0].text).toContain("Browser authentication failed");
    expect(result.content[0].text).toContain("Timed out");
    expect(result.isError).toBe(true);
  });

  it("should return error when device auth fails", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performDeviceAuth).mockRejectedValue(
      new Error("Device auth initiation failed (500)"),
    );

    const result = await getHandler()({ method: "device" });
    expect(result.content[0].text).toContain("Device authentication failed");
    expect(result.isError).toBe(true);
  });

  it("should handle non-Error thrown values", async () => {
    const { server, getHandler } = createMockServer();
    register(server, env);

    vi.mocked(readCredentials).mockResolvedValue(null);
    vi.mocked(performBrowserAuth).mockRejectedValue("string error");

    const result = await getHandler()({ method: "browser" });
    expect(result.content[0].text).toContain("Unknown error");
    expect(result.isError).toBe(true);
  });
});
