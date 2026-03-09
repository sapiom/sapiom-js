import { IdentityManager } from "./IdentityManager";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock randomUUID (used by HttpClient for idempotency keys)
jest.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

/**
 * Helper: create a minimal HttpClient that uses mocked global fetch
 */
function createMockHttpClient(baseURL = "https://api.sapiom.ai") {
  const { HttpClient } = require("./HttpClient");
  return new HttpClient({
    baseURL,
    timeout: 5000,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "sk_test_key",
    },
    retry: { maxAttempts: 1, baseDelayMs: 0 },
  });
}

/**
 * Helper: create a JWT with given payload (no signature verification needed)
 */
function createTestJWT(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "fake-signature";
  return `${header}.${body}.${signature}`;
}

/**
 * Helper: mock a successful token response
 */
function mockTokenResponse(
  audiences: string | string[],
  expiresInMs: number = 60 * 60 * 1000, // 1 hour
) {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const jwt = createTestJWT({
    sub: "org_123",
    aud: audiences,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
  });

  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name === "content-type" ? "application/json" : null,
    },
    json: jest.fn().mockResolvedValue({ identity: jwt, identityExpiresAt: expiresAt }),
    text: jest.fn().mockResolvedValue(JSON.stringify({ identity: jwt, identityExpiresAt: expiresAt })),
  });

  return { jwt, expiresAt };
}

describe("IdentityManager", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    jest.useRealTimers();
  });

  describe("lazy token fetch", () => {
    it("should lazily fetch token on first getToken() call", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      const { jwt } = mockTokenResponse("services.sapiom.ai");

      const token = await manager.getToken();

      expect(token).not.toBeNull();
      expect(token!.identity).toBe(jwt);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/auth/tokens"),
        expect.objectContaining({ method: "POST" }),
      );

      manager.dispose();
    });

    it("should cache token and reuse on second call", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      mockTokenResponse("services.sapiom.ai");

      const token1 = await manager.getToken();
      const token2 = await manager.getToken();

      expect(token1!.identity).toBe(token2!.identity);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only one HTTP call

      manager.dispose();
    });
  });

  describe("token expiry and refresh", () => {
    it("should block and re-fetch when token is expired", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      // First token expires immediately
      mockTokenResponse("services.sapiom.ai", -1000);
      await manager.getToken();

      // Second call should fetch again since token is expired
      const { jwt: newJwt } = mockTokenResponse("services.sapiom.ai");
      const token = await manager.getToken();

      expect(token!.identity).toBe(newJwt);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      manager.dispose();
    });

    it("should return current token and trigger async refresh when near expiry", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      // Token expires in 2 minutes (< 3 min threshold)
      const { jwt: nearExpiryJwt } = mockTokenResponse(
        "services.sapiom.ai",
        2 * 60 * 1000,
      );

      const token = await manager.getToken();
      expect(token!.identity).toBe(nearExpiryJwt);

      // Mock for the background refresh
      mockTokenResponse("services.sapiom.ai");

      // Second call should return the near-expiry token immediately
      // while triggering an async refresh
      const token2 = await manager.getToken();
      expect(token2!.identity).toBe(nearExpiryJwt);

      // Wait for async refresh to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledTimes(2); // initial + async refresh

      manager.dispose();
    });
  });

  describe("audience matching", () => {
    it("should attach header when hostname directly matches aud", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      const { jwt } = mockTokenResponse("services.sapiom.ai");

      const headers = await manager.getHeaderIfMatch(
        "https://services.sapiom.ai/v1/models",
      );

      expect(headers["Sapiom-Identity"]).toBe(jwt);

      manager.dispose();
    });

    it("should attach header when hostname is subdomain of aud", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      const { jwt } = mockTokenResponse("services.sapiom.ai");

      const headers = await manager.getHeaderIfMatch(
        "https://fal.services.sapiom.ai/v1/infer",
      );

      expect(headers["Sapiom-Identity"]).toBe(jwt);

      manager.dispose();
    });

    it("should NOT attach header when hostname does not match aud", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      mockTokenResponse("services.sapiom.ai");

      const headers = await manager.getHeaderIfMatch(
        "https://api.openai.com/v1/chat",
      );

      expect(headers["Sapiom-Identity"]).toBeUndefined();

      manager.dispose();
    });

    it("should handle aud as array", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      const { jwt } = mockTokenResponse([
        "services.sapiom.ai",
        "tools.sapiom.ai",
      ]);

      const headers1 = await manager.getHeaderIfMatch(
        "https://services.sapiom.ai/v1/models",
      );
      expect(headers1["Sapiom-Identity"]).toBe(jwt);

      const headers2 = await manager.getHeaderIfMatch(
        "https://tools.sapiom.ai/v1/search",
      );
      expect(headers2["Sapiom-Identity"]).toBe(jwt);

      const headers3 = await manager.getHeaderIfMatch(
        "https://api.external.com/data",
      );
      expect(headers3["Sapiom-Identity"]).toBeUndefined();

      manager.dispose();
    });

    it("should be case-insensitive for audience matching", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      const { jwt } = mockTokenResponse("Services.Sapiom.AI");

      const headers = await manager.getHeaderIfMatch(
        "https://services.sapiom.ai/v1/models",
      );
      expect(headers["Sapiom-Identity"]).toBe(jwt);

      manager.dispose();
    });
  });

  describe("graceful degradation", () => {
    it("should return null when facilitator is unreachable", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const token = await manager.getToken();
      expect(token).toBeNull();

      manager.dispose();
    });

    it("should return empty headers when facilitator is unreachable", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const headers = await manager.getHeaderIfMatch(
        "https://services.sapiom.ai/v1/models",
      );
      expect(headers).toEqual({});

      manager.dispose();
    });

    it("should return empty headers for invalid URL", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      const headers = await manager.getHeaderIfMatch("not-a-valid-url");
      expect(headers).toEqual({});

      manager.dispose();
    });
  });

  describe("mutex (concurrent request deduplication)", () => {
    it("should only make one HTTP request for concurrent first calls", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      // Use a slow-resolving mock
      const { jwt } = mockTokenResponse("services.sapiom.ai");

      // Fire 5 concurrent requests
      const results = await Promise.all([
        manager.getToken(),
        manager.getToken(),
        manager.getToken(),
        manager.getToken(),
        manager.getToken(),
      ]);

      // All should get the same token
      for (const result of results) {
        expect(result!.identity).toBe(jwt);
      }

      // But only one HTTP request should have been made
      expect(mockFetch).toHaveBeenCalledTimes(1);

      manager.dispose();
    });
  });

  describe("shouldAttachHeader", () => {
    it("should return false when no token is cached", () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      expect(manager.shouldAttachHeader("services.sapiom.ai")).toBe(false);

      manager.dispose();
    });

    it("should return true after token is fetched and hostname matches", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);
      mockTokenResponse("services.sapiom.ai");

      await manager.getToken();
      expect(manager.shouldAttachHeader("services.sapiom.ai")).toBe(true);
      expect(manager.shouldAttachHeader("fal.services.sapiom.ai")).toBe(true);
      expect(manager.shouldAttachHeader("api.external.com")).toBe(false);

      manager.dispose();
    });
  });

  describe("backgroundRefresh", () => {
    it("should start a timer that fires refresh for near-expiry tokens", async () => {
      jest.useFakeTimers();
      const httpClient = createMockHttpClient();

      // Initial token near expiry (2 min left)
      mockTokenResponse("services.sapiom.ai", 2 * 60 * 1000);

      const manager = new IdentityManager(httpClient, {
        backgroundRefresh: true,
      });

      // Trigger initial fetch
      await manager.getToken();

      // Mock for background refresh
      mockTokenResponse("services.sapiom.ai", 60 * 60 * 1000);

      // Advance timer to trigger background refresh check
      jest.advanceTimersByTime(61 * 1000);

      // Allow the promise to resolve
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalledTimes(2);

      manager.dispose();
      jest.useRealTimers();
    });

    it("should clean up timer on dispose", () => {
      jest.useFakeTimers();
      const clearIntervalSpy = jest.spyOn(global, "clearInterval");
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient, {
        backgroundRefresh: true,
      });

      manager.dispose();

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
      jest.useRealTimers();
    });

    it("should not start timer when backgroundRefresh is false", () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, "setInterval");
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient, {
        backgroundRefresh: false,
      });

      // setInterval may be called by other things, check it wasn't called for refresh
      const callsBefore = setIntervalSpy.mock.calls.length;
      expect(callsBefore).toBe(0);

      manager.dispose();
      setIntervalSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe("JWT decoding edge cases", () => {
    it("should handle JWT with no aud claim", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      const jwt = createTestJWT({ sub: "org_123" }); // no aud
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ identity: jwt, identityExpiresAt: expiresAt }),
        text: jest.fn().mockResolvedValue(JSON.stringify({ identity: jwt, identityExpiresAt: expiresAt })),
      });

      const headers = await manager.getHeaderIfMatch(
        "https://services.sapiom.ai/v1/models",
      );
      expect(headers["Sapiom-Identity"]).toBeUndefined();

      manager.dispose();
    });

    it("should handle malformed JWT gracefully", async () => {
      const httpClient = createMockHttpClient();
      const manager = new IdentityManager(httpClient);

      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "application/json" : null,
        },
        json: jest.fn().mockResolvedValue({ identity: "not-a-jwt", identityExpiresAt: expiresAt }),
        text: jest.fn().mockResolvedValue(JSON.stringify({ identity: "not-a-jwt", identityExpiresAt: expiresAt })),
      });

      const headers = await manager.getHeaderIfMatch(
        "https://services.sapiom.ai/v1/models",
      );
      expect(headers["Sapiom-Identity"]).toBeUndefined();

      manager.dispose();
    });
  });
});
