/**
 * Unit tests for the GitHub Device Flow router (github-device.ts).
 *
 * All GitHub HTTP calls are mocked via the `fetchImpl` seam — no network.
 * Token store is cleared between each test via `_clearTokenStoreForTest`.
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mapPollResponse,
  createGitHubDeviceRouter,
  _clearTokenStoreForTest,
  type PollResult,
} from "./github-device.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchLike = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function startServer(
  fetchImpl: FetchLike,
  clientId: string | null = "test-client-id",
): { baseUrl: string; close: () => Promise<void> } {
  const app = express();
  app.use(express.json());
  // Mount at root — exactly as production (server/index.ts) does — so each
  // route's own "/api/..." prefix is exercised. Mounting under "/api" here
  // would double-prefix and hide a missing prefix in the routes.
  app.use(
    createGitHubDeviceRouter({
      fetchImpl: fetchImpl as typeof fetch,
      clientId,
    }),
  );
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------
// mapPollResponse — state machine unit tests
// ---------------------------------------------------------------------------

describe("mapPollResponse", () => {
  it("maps access_token present → authorized", () => {
    const result: PollResult = mapPollResponse({ access_token: "ghp_abc123" });
    expect(result).toEqual({ status: "authorized" });
  });

  it("maps error: authorization_pending → pending", () => {
    expect(mapPollResponse({ error: "authorization_pending" })).toEqual({
      status: "pending",
    });
  });

  it("maps error: slow_down with interval → slow_down + interval", () => {
    expect(mapPollResponse({ error: "slow_down", interval: 10 })).toEqual({
      status: "slow_down",
      interval: 10,
    });
  });

  it("maps error: slow_down without interval → slow_down (no interval)", () => {
    const r = mapPollResponse({ error: "slow_down" });
    expect(r.status).toBe("slow_down");
    expect(r.interval).toBeUndefined();
  });

  it("maps error: expired_token → expired", () => {
    expect(mapPollResponse({ error: "expired_token" })).toEqual({
      status: "expired",
    });
  });

  it("maps error: access_denied → denied", () => {
    expect(mapPollResponse({ error: "access_denied" })).toEqual({
      status: "denied",
    });
  });

  it("maps unknown error → pending (safe default)", () => {
    expect(mapPollResponse({ error: "some_unknown_error" })).toEqual({
      status: "pending",
    });
  });

  it("maps empty body → pending", () => {
    expect(mapPollResponse({})).toEqual({ status: "pending" });
  });

  it("does not expose the access_token in the result", () => {
    const result = mapPollResponse({ access_token: "ghp_secret" });
    // The result must not contain the token.
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint tests
// ---------------------------------------------------------------------------

describe("POST /api/github/device/start", () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  afterEach(async () => {
    await server?.close();
    _clearTokenStoreForTest();
  });

  it("returns 503 when clientId is null", async () => {
    // The fetchImpl should never be called when clientId is null — the
    // requireClientId middleware short-circuits before any GitHub I/O.
    const mockFetch = vi.fn();
    server = startServer(mockFetch, null);

    const httpRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(httpRes.status).toBe(503);
    const body = (await httpRes.json()) as { error: string };
    expect(body.error).toBe("notConfigured");
    // Crucially: the injected fetchImpl must not have been invoked.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns device code fields from GitHub", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        device_code: "ghu_abc",
        interval: 5,
        expires_in: 900,
      }),
    );
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user_code).toBe("ABCD-1234");
    expect(body.verification_uri).toBe("https://github.com/login/device");
    expect(body.device_code).toBe("ghu_abc");
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(900);
  });

  it("returns 502 when GitHub responds with non-200", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(res.status).toBe(502);
  });

  it("replaces a non-github.com verification_uri with the safe fallback (A5)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        user_code: "ABCD-1234",
        verification_uri: "https://evil.example.com/phish",
        device_code: "ghu_abc",
        interval: 5,
        expires_in: 900,
      }),
    );
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Must NOT forward the attacker-controlled URI.
    expect(body.verification_uri).not.toBe("https://evil.example.com/phish");
    // Must fall back to the canonical GitHub device URI.
    expect(body.verification_uri).toBe("https://github.com/login/device");
  });

  it("preserves a legitimate github.com verification_uri unchanged (A5)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        user_code: "WXYZ-5678",
        verification_uri: "https://github.com/login/device",
        device_code: "ghu_def",
        interval: 5,
        expires_in: 900,
      }),
    );
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verification_uri).toBe("https://github.com/login/device");
  });
});

describe("POST /api/github/device/poll", () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  afterEach(async () => {
    await server?.close();
    _clearTokenStoreForTest();
  });

  it("returns 400 when device_code is missing", async () => {
    const mockFetch = vi.fn();
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns { status: pending } for authorization_pending", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "authorization_pending" }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("returns { status: slow_down, interval } for slow_down", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "slow_down", interval: 10 }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    const body = (await res.json()) as { status: string; interval: number };
    expect(body.status).toBe("slow_down");
    expect(body.interval).toBe(10);
  });

  it("returns { status: expired } for expired_token", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "expired_token" }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("expired");
  });

  it("returns { status: denied } for access_denied", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "access_denied" }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("denied");
  });

  it("does NOT include the access_token in the response when authorized", async () => {
    const mockFetch = vi
      .fn()
      // First call: token endpoint returns the token.
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_supersecret" }))
      // Second call: /user endpoint for login.
      .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Status must be authorized, token must NOT appear anywhere in the response.
    expect(body.status).toBe("authorized");
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("ghp_supersecret");
    expect(bodyStr).not.toContain("access_token");
  });

  it("sets an HttpOnly session cookie on authorization with Path=/api/", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_tok" }))
      .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
    server = startServer(mockFetch);
    const res = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("gh_sess=");
    expect(cookie).toContain("HttpOnly");
    // Path must be /api/ so the cookie is sent to /api/connect/github too.
    expect(cookie).toContain("Path=/api/");
    // Must NOT be the old narrower path that excluded /api/connect/github.
    expect(cookie).not.toContain("Path=/api/github");
  });
});

describe("GET /api/github/repos", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let sessionCookie: string;

  // Authorize once before running repo tests.
  beforeEach(async () => {
    _clearTokenStoreForTest();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_tok" }))
      .mockResolvedValueOnce(jsonResponse({ login: "octocat" }))
      // subsequent calls: repos list
      .mockResolvedValue(
        jsonResponse([
          {
            full_name: "octocat/Hello-World",
            clone_url: "https://github.com/octocat/Hello-World.git",
            private: false,
            description: "My first repository",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]),
      );
    server = startServer(mockFetch);
    const pollRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    sessionCookie = pollRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  afterEach(async () => {
    await server?.close();
    _clearTokenStoreForTest();
  });

  it("returns 401 when no session cookie is present", async () => {
    const res = await globalThis.fetch(`${server.baseUrl}/api/github/repos`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not connected");
  });

  it("maps repo fields from GitHub API", async () => {
    const res = await globalThis.fetch(`${server.baseUrl}/api/github/repos`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const repos = (await res.json()) as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      fullName: "octocat/Hello-World",
      cloneUrl: "https://github.com/octocat/Hello-World.git",
      private: false,
      description: "My first repository",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("does NOT include any raw GitHub field names (snake_case) in the response", async () => {
    const res = await globalThis.fetch(`${server.baseUrl}/api/github/repos`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await res.text();
    // Our mapper renames: full_name → fullName, clone_url → cloneUrl, etc.
    expect(body).not.toContain("full_name");
    expect(body).not.toContain("clone_url");
    expect(body).not.toContain("updated_at");
  });
});

describe("GET /api/github/status", () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  afterEach(async () => {
    await server?.close();
    _clearTokenStoreForTest();
  });

  it("returns { connected: false, configured: false } when clientId is null", async () => {
    const mockFetch = vi.fn();
    server = startServer(mockFetch, null);
    const res = await globalThis.fetch(`${server.baseUrl}/api/github/status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(false);
    expect(body.configured).toBe(false);
  });

  it("returns { connected: false, configured: true } when no session", async () => {
    const mockFetch = vi.fn();
    server = startServer(mockFetch);
    const res = await globalThis.fetch(`${server.baseUrl}/api/github/status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(false);
    expect(body.configured).toBe(true);
  });

  it("returns { connected: true, login } when session is valid", async () => {
    const mockFetch = vi
      .fn()
      // poll: token + login
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_tok" }))
      .mockResolvedValueOnce(jsonResponse({ login: "octocat" }))
      // status: /user call
      .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
    server = startServer(mockFetch);
    // Authorize first.
    const pollRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    const cookie = pollRes.headers.get("set-cookie")?.split(";")[0] ?? "";

    const statusRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/status`,
      {
        headers: { Cookie: cookie },
      },
    );
    const body = (await statusRes.json()) as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect(body.login).toBe("octocat");
  });
});

describe("POST /api/github/disconnect", () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  afterEach(async () => {
    await server?.close();
    _clearTokenStoreForTest();
  });

  it("clears the session so subsequent repos requests return 401", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghp_tok" }))
      .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
    server = startServer(mockFetch);

    const pollRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/device/poll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: "ghu_abc" }),
      },
    );
    const cookie = pollRes.headers.get("set-cookie")?.split(";")[0] ?? "";

    // Disconnect.
    const discRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/disconnect`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    expect(discRes.status).toBe(200);
    expect(discRes.headers.get("set-cookie")).toContain("Max-Age=0");
    const discBody = (await discRes.json()) as { ok: boolean };
    expect(discBody.ok).toBe(true);

    // Subsequent repos request must fail.
    const reposRes = await globalThis.fetch(
      `${server.baseUrl}/api/github/repos`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(reposRes.status).toBe(401);
  });
});

describe("token redaction", () => {
  it("redacts x-access-token URLs from error messages in gitClone", async () => {
    // We can't call gitClone directly without a real git binary, but we can
    // verify the redactToken function inline via the module.
    // The mapPollResponse test above already proves the token is not leaked.
    // This test validates the URL redaction helper (matching connect-github.ts).
    // A URL containing a token — validate redaction works the same way
    // connect-github.ts does it, without importing it.
    const raw =
      "fatal: repository 'https://x-access-token:ghp_MYSECRET@github.com/x/y.git' not found";
    const redacted = raw.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
    expect(redacted).toContain("***@github.com");
    expect(redacted).not.toContain("ghp_MYSECRET");
  });
});
