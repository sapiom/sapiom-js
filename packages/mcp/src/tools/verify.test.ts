import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../fetch.js", () => ({
  getAuthenticatedFetch: vi.fn(),
}));

import { register } from "./verify.js";
import { getAuthenticatedFetch } from "../fetch.js";

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

const envWithPrelude: ResolvedEnvironment = {
  ...env,
  services: { prelude: "https://custom.prelude.test" },
};

describe("verify tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register both sapiom_verify_send and sapiom_verify_check", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    expect(handlers.has("sapiom_verify_send")).toBe(true);
    expect(handlers.has("sapiom_verify_check")).toBe(true);
  });

  describe("sapiom_verify_send", () => {
    it("should return error when not authenticated", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(getAuthenticatedFetch).mockResolvedValue(null);

      const result = await handlers.get("sapiom_verify_send")!({
        phoneNumber: "+15551234567",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not authenticated");
    });

    it("should send verification and return ID on success", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "ver-123", status: "pending" }),
      });
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_send")!({
        phoneNumber: "+15551234567",
      });

      expect(result.content[0].text).toContain("ver-123");
      expect(result.content[0].text).toContain("+15551234567");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://prelude.services.sapiom.ai/verifications",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("+15551234567"),
        }),
      );
    });

    it("should use custom prelude URL from services config", async () => {
      const { server, handlers } = createMockServer();
      register(server, envWithPrelude);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "ver-456", status: "pending" }),
      });
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      await handlers.get("sapiom_verify_send")!({
        phoneNumber: "+15551234567",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.prelude.test/verifications",
        expect.any(Object),
      );
    });

    it("should return error on API failure", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: "Invalid phone number" }),
      });
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_send")!({
        phoneNumber: "+15551234567",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid phone number");
    });

    it("should handle network errors", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Network unreachable"));
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_send")!({
        phoneNumber: "+15551234567",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Network unreachable");
    });
  });

  describe("sapiom_verify_check", () => {
    it("should return error when not authenticated", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(getAuthenticatedFetch).mockResolvedValue(null);

      const result = await handlers.get("sapiom_verify_check")!({
        verificationId: "ver-123",
        code: "123456",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not authenticated");
    });

    it("should return success for correct code", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "ver-123", status: "success" }),
      });
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_check")!({
        verificationId: "ver-123",
        code: "123456",
      });

      expect(result.content[0].text).toContain("Verification successful");
      expect(result.isError).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://prelude.services.sapiom.ai/verifications/check",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            verificationRequestId: "ver-123",
            code: "123456",
          }),
        }),
      );
    });

    it("should return error for incorrect code", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "ver-123", status: "failed" }),
      });
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_check")!({
        verificationId: "ver-123",
        code: "000000",
      });

      expect(result.content[0].text).toContain("failed");
      expect(result.isError).toBe(true);
    });

    it("should return error on API failure", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: "Verification not found" }),
      });
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_check")!({
        verificationId: "invalid-id",
        code: "123456",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Verification not found");
    });

    it("should handle network errors", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
      vi.mocked(getAuthenticatedFetch).mockResolvedValue(mockFetch as any);

      const result = await handlers.get("sapiom_verify_check")!({
        verificationId: "ver-123",
        code: "123456",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection refused");
    });
  });
});
