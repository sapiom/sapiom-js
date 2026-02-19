import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedEnvironment } from "../credentials.js";

vi.mock("../credentials.js", () => ({
  readCredentials: vi.fn(),
}));

vi.mock("@sapiom/fetch", () => ({
  createFetch: vi.fn(),
}));

import { register } from "./auth.js";
import { readCredentials } from "../credentials.js";
import { createFetch } from "@sapiom/fetch";

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

const envWithAuth0: ResolvedEnvironment = {
  ...env,
  services: { auth0: "https://custom.auth0.test" },
};

const mockCredentials = {
  apiKey: "sk-test",
  tenantId: "t-123",
  organizationName: "Test Org",
  apiKeyId: "k-456",
};

function authenticateWith(mockFetch: ReturnType<typeof vi.fn>) {
  vi.mocked(readCredentials).mockResolvedValue(mockCredentials);
  vi.mocked(createFetch).mockReturnValue(mockFetch as any);
}

describe("auth tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register all three auth tools", () => {
    const { server, handlers } = createMockServer();
    register(server, env);
    expect(handlers.has("sapiom_auth_create_app")).toBe(true);
    expect(handlers.has("sapiom_auth_get_app")).toBe(true);
    expect(handlers.has("sapiom_auth_delete_app")).toBe(true);
  });

  describe("sapiom_auth_create_app", () => {
    it("should return error when not authenticated", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(readCredentials).mockResolvedValue(null);

      const result = await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github"],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not authenticated");
    });

    it("should create app and return integration guide on success", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            appId: "my-app",
            id: "uuid-123",
            authBaseUrl: "https://my-app.auth.sapiom.ai",
            status: "active",
            providers: ["github"],
            jwtSecret: "secret-abc",
          }),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github"],
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("my-app");
      expect(result.content[0].text).toContain("secret-abc");
      expect(result.content[0].text).toContain("Integration Guide");
      expect(result.content[0].text).toContain("sapiom:auth:login");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth0.services.sapiom.ai/v1/apps",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "my-app", providers: ["github"] }),
        }),
      );
    });

    it("should include connectionScopes in request when provided", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            appId: "my-app",
            id: "uuid-123",
            authBaseUrl: "https://my-app.auth.sapiom.ai",
            status: "active",
            providers: ["github", "google-oauth2"],
            jwtSecret: "secret-abc",
          }),
      });
      authenticateWith(mockFetch);

      const connectionScopes = {
        github: ["repo", "read:user"],
        "google-oauth2": ["email", "profile"],
      };

      const result = await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github", "google-oauth2"],
        connectionScopes,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Connection Scopes");
      expect(result.content[0].text).toContain("repo, read:user");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth0.services.sapiom.ai/v1/apps",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            name: "my-app",
            providers: ["github", "google-oauth2"],
            connectionScopes,
          }),
        }),
      );
    });

    it("should create app without connectionScopes (backward compat)", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            appId: "my-app",
            id: "uuid-123",
            authBaseUrl: "https://my-app.auth.sapiom.ai",
            status: "active",
            providers: ["github"],
            jwtSecret: "secret-abc",
          }),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github"],
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain("Connection Scopes");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth0.services.sapiom.ai/v1/apps",
        expect.objectContaining({
          body: JSON.stringify({ name: "my-app", providers: ["github"] }),
        }),
      );
    });

    it("should include displayName in request when provided", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            appId: "my-app",
            id: "uuid-123",
            authBaseUrl: "https://my-app.auth.sapiom.ai",
            status: "active",
            providers: ["github"],
            jwtSecret: "secret-abc",
          }),
      });
      authenticateWith(mockFetch);

      await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        displayName: "My Cool App",
        providers: ["github", "google-oauth2"],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth0.services.sapiom.ai/v1/apps",
        expect.objectContaining({
          body: JSON.stringify({
            name: "my-app",
            providers: ["github", "google-oauth2"],
            displayName: "My Cool App",
          }),
        }),
      );
    });

    it("should use custom auth0 URL from services config", async () => {
      const { server, handlers } = createMockServer();
      register(server, envWithAuth0);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            appId: "my-app",
            id: "uuid-123",
            authBaseUrl: "https://my-app.auth.test",
            status: "active",
            providers: ["github"],
            jwtSecret: "secret-abc",
          }),
      });
      authenticateWith(mockFetch);

      await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github"],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.auth0.test/v1/apps",
        expect.any(Object),
      );
    });

    it("should return error on API failure", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: "Invalid app name" }),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github"],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid app name");
    });

    it("should handle network errors", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Network unreachable"));
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_create_app")!({
        name: "my-app",
        providers: ["github"],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Network unreachable");
    });
  });

  describe("sapiom_auth_get_app", () => {
    it("should return error when not authenticated", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(readCredentials).mockResolvedValue(null);

      const result = await handlers.get("sapiom_auth_get_app")!({
        appId: "my-app",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not authenticated");
    });

    it("should return app details on success", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            appId: "my-app",
            id: "uuid-123",
            authBaseUrl: "https://my-app.auth.sapiom.ai",
            status: "active",
            providers: ["github", "google-oauth2"],
            createdAt: "2026-01-15T10:00:00Z",
          }),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_get_app")!({
        appId: "my-app",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("my-app");
      expect(result.content[0].text).toContain("uuid-123");
      expect(result.content[0].text).toContain("active");
      expect(result.content[0].text).toContain("github, google-oauth2");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth0.services.sapiom.ai/v1/apps/my-app",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("should return error on API failure", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: "App not found" }),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_get_app")!({
        appId: "nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("App not found");
    });

    it("should handle network errors", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_get_app")!({
        appId: "my-app",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection refused");
    });
  });

  describe("sapiom_auth_delete_app", () => {
    it("should return error when not authenticated", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      vi.mocked(readCredentials).mockResolvedValue(null);

      const result = await handlers.get("sapiom_auth_delete_app")!({
        appId: "my-app",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Not authenticated");
    });

    it("should delete app and return confirmation", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_delete_app")!({
        appId: "my-app",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("deleted successfully");
      expect(result.content[0].text).toContain("my-app");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://auth0.services.sapiom.ai/v1/apps/my-app",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("should return error on API failure", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ message: "Forbidden" }),
      });
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_delete_app")!({
        appId: "my-app",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Forbidden");
    });

    it("should handle network errors", async () => {
      const { server, handlers } = createMockServer();
      register(server, env);

      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Timeout"));
      authenticateWith(mockFetch);

      const result = await handlers.get("sapiom_auth_delete_app")!({
        appId: "my-app",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Timeout");
    });
  });
});
