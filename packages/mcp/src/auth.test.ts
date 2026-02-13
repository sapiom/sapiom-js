import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { performBrowserAuth } from "./auth.js";
import { execSync } from "node:child_process";

// Mock child_process to prevent actual browser opening
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

// Helper to simulate browser callback
function callbackToServer(
  port: number,
  params: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const req = http.request(
      `http://127.0.0.1:${port}/callback?${query}`,
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function extractAuthInfo(): { state: string; port: string } {
  const openCall = mockedExecSync.mock.calls[0]?.[0] as string;
  const urlMatch = openCall?.match(/open "(.+)"/);
  if (!urlMatch) throw new Error("No open call found");
  const authURL = new URL(urlMatch[1]);
  const state = authURL.searchParams.get("state")!;
  const redirectUri = authURL.searchParams.get("redirect_uri")!;
  const port = new URL(redirectUri).port;
  return { state, port };
}

describe("performBrowserAuth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should complete auth flow successfully", async () => {
    const mockResult = {
      apiKey: "sk-test",
      tenantId: "t-123",
      organizationName: "Test Org",
      apiKeyId: "k-456",
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResult),
    });

    const authPromise = performBrowserAuth(
      "https://app.test.com",
      "https://api.test.com",
    );

    await new Promise((r) => setTimeout(r, 100));

    const { state, port } = extractAuthInfo();

    await callbackToServer(Number(port), { code: "auth-code-123", state });

    const result = await authPromise;
    expect(result).toEqual(mockResult);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test.com/v1/auth/cli/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("auth-code-123"),
      }),
    );
  });

  it("should reject on state mismatch", async () => {
    const authPromise = performBrowserAuth(
      "https://app.test.com",
      "https://api.test.com",
    ).catch((e) => e);

    await new Promise((r) => setTimeout(r, 100));

    const { port } = extractAuthInfo();

    await callbackToServer(Number(port), {
      code: "auth-code",
      state: "wrong-state",
    });

    const error = await authPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("State mismatch");
  });

  it("should reject when no code is received", async () => {
    const authPromise = performBrowserAuth(
      "https://app.test.com",
      "https://api.test.com",
    ).catch((e) => e);

    await new Promise((r) => setTimeout(r, 100));

    const { state, port } = extractAuthInfo();

    await callbackToServer(Number(port), { state });

    const error = await authPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "No authorization code received",
    );
  });

  it("should reject when token exchange fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ message: "Invalid code" }),
    });

    const authPromise = performBrowserAuth(
      "https://app.test.com",
      "https://api.test.com",
    ).catch((e) => e);

    await new Promise((r) => setTimeout(r, 100));

    const { state, port } = extractAuthInfo();

    await callbackToServer(Number(port), { code: "bad-code", state });

    const error = await authPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Invalid code");
  });

  it("should return 404 for non-callback paths", async () => {
    const authPromise = performBrowserAuth(
      "https://app.test.com",
      "https://api.test.com",
    );

    await new Promise((r) => setTimeout(r, 100));

    const { state, port } = extractAuthInfo();

    // Request a non-callback path
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/other`, (res) =>
        resolve(res.statusCode!),
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(404);

    // Clean up: send the correct callback to close the server
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          apiKey: "k",
          tenantId: "t",
          organizationName: "o",
          apiKeyId: "a",
        }),
    });
    await callbackToServer(Number(port), { code: "c", state });
    await authPromise;
  });
});
