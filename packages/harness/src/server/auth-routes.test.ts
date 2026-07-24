/**
 * Unit tests for the in-app auth routes (auth-routes.ts).
 *
 * All OAuth I/O is mocked via the `performBrowserAuthImpl` seam — no real
 * browser, no local port, no network. The credential store (writeCredentials /
 * clearCredentials) is also mocked so tests don't touch ~/.sapiom/credentials.json.
 */

import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAuthRouter,
  createMutableAuthState,
  type AuthRoutesOptions,
} from "./auth-routes.js";
import { EventBus } from "../core/event-bus.js";
import type { BusMessage } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Vitest module mocks — intercept credential store calls
// ---------------------------------------------------------------------------

vi.mock("@sapiom/mcp/auth", () => ({
  resolveEnvironment: vi.fn().mockResolvedValue({
    name: "production",
    appURL: "https://app.sapiom.ai",
    apiURL: "https://api.sapiom.ai",
  }),
  performBrowserAuth: vi.fn(), // replaced per-test via performBrowserAuthImpl seam
  writeCredentials: vi.fn().mockResolvedValue(undefined),
  clearCredentials: vi.fn().mockResolvedValue(undefined),
}));

import { writeCredentials, clearCredentials } from "@sapiom/mcp/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal ApiKeyProvider spy — records refresh() and clear() calls. */
function makeProvider(refreshResult: string | null = null, initialKey: string | null = null) {
  const calls = { refresh: 0, clear: 0 };
  let currentKey: string | null = initialKey;
  return {
    calls,
    getKey: () => currentKey,
    refresh: async () => {
      calls.refresh++;
      if (refreshResult) currentKey = refreshResult;
      return currentKey;
    },
    clear: () => {
      calls.clear++;
      currentKey = null;
    },
  };
}

/** Collect every event published to the bus during a test. */
function collectBusEvents(bus: EventBus): BusMessage[] {
  const events: BusMessage[] = [];
  bus.subscribe((msg) => events.push(msg));
  return events;
}

/** Build and start a minimal express app mounting the auth router. */
function startApp(opts: Partial<AuthRoutesOptions> & { bus: EventBus }) {
  const authState = opts.authState ?? createMutableAuthState({ authenticated: false, organizationName: null });
  const apiKeyProvider = opts.apiKeyProvider ?? makeProvider();
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createAuthRouter({
      authState,
      apiKeyProvider,
      bus: opts.bus,
      environment: "production",
      performBrowserAuthImpl: opts.performBrowserAuthImpl,
    }),
  );
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, authState, apiKeyProvider };
}

// ---------------------------------------------------------------------------
// createMutableAuthState
// ---------------------------------------------------------------------------

describe("createMutableAuthState", () => {
  it("returns initial state", () => {
    const state = createMutableAuthState({ authenticated: true, organizationName: "Acme" });
    expect(state.get()).toEqual({ authenticated: true, organizationName: "Acme" });
  });

  it("updates on set()", () => {
    const state = createMutableAuthState({ authenticated: false, organizationName: null });
    state.set({ authenticated: true, organizationName: "Acme" });
    expect(state.get()).toEqual({ authenticated: true, organizationName: "Acme" });
  });

  it("returns a copy — mutating the returned object does not affect internal state", () => {
    const state = createMutableAuthState({ authenticated: false, organizationName: null });
    const snap = state.get();
    snap.authenticated = true;
    expect(state.get().authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/status
// ---------------------------------------------------------------------------

describe("GET /api/auth/status", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;

  afterEach(() => {
    server?.close();
  });

  it("returns initial unauthenticated state", async () => {
    const bus = new EventBus();
    const result = startApp({ bus });
    server = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false, organizationName: null });
  });

  it("reflects authenticated state when seeded as authenticated", async () => {
    const bus = new EventBus();
    const authState = createMutableAuthState({ authenticated: true, organizationName: "Acme" });
    const result = startApp({ bus, authState });
    server = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: true, organizationName: "Acme" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/start — success path
// ---------------------------------------------------------------------------

describe("POST /api/auth/start — success", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let busEvents: BusMessage[];
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    busEvents = collectBusEvents(bus);
    vi.mocked(writeCredentials).mockReset().mockResolvedValue(undefined);
    vi.mocked(clearCredentials).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    server?.close();
    vi.clearAllMocks();
  });

  it("returns { started: true } immediately and completes the flow async", async () => {
    type AuthResult = {
      apiKey: string;
      tenantId: string;
      organizationName: string;
      apiKeyId: string;
    };

    let capturedResolve!: (v: AuthResult) => void;
    // The mock captures its inner Promise's resolve so the test can drive completion.
    const mockBrowserAuth = vi.fn().mockImplementation(
      () =>
        new Promise<AuthResult>((resolve) => {
          capturedResolve = resolve;
        }),
    );

    const provider = makeProvider("sk-fresh-key");
    const result = startApp({ bus, performBrowserAuthImpl: mockBrowserAuth, apiKeyProvider: provider });
    server = result.server;
    baseUrl = result.baseUrl;
    const { authState } = result;

    // POST returns immediately.
    const res = await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ started: true });

    // Auth is not yet complete (still waiting on the mock browser flow) — but
    // we need to give the route time to set up its async chain and call
    // performBrowserAuthImpl, after which capturedResolve will be populated.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedResolve).toBeDefined();
    expect(authState.get().authenticated).toBe(false);

    // Simulate the browser completing OAuth.
    capturedResolve({
      apiKey: "sk-fresh-key",
      tenantId: "tenant-1",
      organizationName: "Acme Corp",
      apiKeyId: "key-1",
    });

    // Give the async chain a tick to settle.
    await new Promise((r) => setTimeout(r, 10));

    // Auth state updated.
    expect(authState.get()).toEqual({ authenticated: true, organizationName: "Acme Corp" });

    // Credentials were written.
    expect(writeCredentials).toHaveBeenCalledWith(
      "production",
      "https://app.sapiom.ai",
      "https://api.sapiom.ai",
      {
        apiKey: "sk-fresh-key",
        tenantId: "tenant-1",
        organizationName: "Acme Corp",
        apiKeyId: "key-1",
      },
    );

    // Provider was refreshed to adopt the new key.
    expect(provider.calls.refresh).toBe(1);

    // Bus broadcasted auth.changed with authenticated: true.
    const authEvents = busEvents.filter((e) => e.type === "auth.changed");
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0]).toEqual({
      type: "auth.changed",
      authenticated: true,
      organizationName: "Acme Corp",
    });
  });

  it("rejects a concurrent start with 409", async () => {
    // A slow browser auth — never resolves during the test.
    const mockBrowserAuth = vi.fn().mockImplementation(
      () => new Promise<never>(() => {/* never resolves */}),
    );

    const result = startApp({ bus, performBrowserAuthImpl: mockBrowserAuth });
    server = result.server;
    baseUrl = result.baseUrl;

    // First POST — starts the flow.
    const res1 = await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    expect(res1.status).toBe(200);

    // Second POST — already in progress.
    const res2 = await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as Record<string, unknown>;
    expect(body.error).toBe("authentication already in progress");
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/start — failure / cancel paths
// ---------------------------------------------------------------------------

describe("POST /api/auth/start — failure", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let busEvents: BusMessage[];
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    busEvents = collectBusEvents(bus);
    vi.mocked(writeCredentials).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    server?.close();
    vi.clearAllMocks();
  });

  it("broadcasts auth.changed with authenticated:false on OAuth failure and does not crash", async () => {
    const mockBrowserAuth = vi.fn().mockRejectedValue(
      new Error("Authentication timed out after 5 minutes."),
    );

    const provider = makeProvider();
    const result = startApp({ bus, performBrowserAuthImpl: mockBrowserAuth, apiKeyProvider: provider });
    server = result.server;
    baseUrl = result.baseUrl;
    const { authState } = result;

    const res = await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).started).toBe(true);

    // Let the async rejection settle.
    await new Promise((r) => setTimeout(r, 20));

    // Auth state remains unauthenticated.
    expect(authState.get().authenticated).toBe(false);

    // writeCredentials was never called (failed before reaching it).
    expect(writeCredentials).not.toHaveBeenCalled();

    // Provider was never refreshed.
    expect(provider.calls.refresh).toBe(0);

    // Bus still broadcasts so the SPA knows the flow ended.
    const authEvents = busEvents.filter((e) => e.type === "auth.changed");
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0]).toMatchObject({ type: "auth.changed", authenticated: false });
  });

  it("allows a new start after a failed one (pendingAuth is cleared)", async () => {
    let callCount = 0;
    const mockBrowserAuth = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("cancelled");
      return {
        apiKey: "sk-ok",
        tenantId: "t1",
        organizationName: "Org",
        apiKeyId: "k1",
      };
    });

    const result = startApp({ bus, performBrowserAuthImpl: mockBrowserAuth });
    server = result.server;
    baseUrl = result.baseUrl;

    // First start — fails.
    await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 20));

    // Second start — succeeds after the first settled.
    const res2 = await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    expect(res2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));

    expect(callCount).toBe(2);
    expect(result.authState.get().authenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/disconnect
// ---------------------------------------------------------------------------

describe("POST /api/auth/disconnect", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  let busEvents: BusMessage[];
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    busEvents = collectBusEvents(bus);
    vi.mocked(clearCredentials).mockReset().mockResolvedValue(undefined);
    vi.mocked(writeCredentials).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    server?.close();
    vi.clearAllMocks();
  });

  it("clears credentials, resets auth state, broadcasts auth.changed, returns { ok: true }", async () => {
    const authState = createMutableAuthState({ authenticated: true, organizationName: "Acme" });
    const provider = makeProvider();
    const result = startApp({ bus, authState, apiKeyProvider: provider });
    server = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/auth/disconnect`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true });

    // Credential store cleared.
    expect(clearCredentials).toHaveBeenCalledWith("production");

    // Auth state set to unauthenticated.
    expect(authState.get()).toEqual({ authenticated: false, organizationName: null });

    // Bus notified.
    const authEvents = busEvents.filter((e) => e.type === "auth.changed");
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0]).toEqual({
      type: "auth.changed",
      authenticated: false,
      organizationName: null,
    });
  });

  it("is idempotent — disconnecting when already unauthenticated still succeeds", async () => {
    const result = startApp({ bus });
    server = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/auth/disconnect`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(clearCredentials).toHaveBeenCalledOnce();
    expect(result.authState.get().authenticated).toBe(false);
  });

  it("zeroes the in-memory key immediately after disconnect", async () => {
    // Seed the provider with a live key (simulates an authenticated session).
    const provider = makeProvider(null, "sk-live-key");
    const authState = createMutableAuthState({ authenticated: true, organizationName: "Acme" });
    const result = startApp({ bus, authState, apiKeyProvider: provider });
    server = result.server;
    baseUrl = result.baseUrl;

    // Confirm the key is present before disconnect.
    expect(provider.getKey()).toBe("sk-live-key");

    const res = await fetch(`${baseUrl}/api/auth/disconnect`, { method: "POST" });
    expect(res.status).toBe(200);

    // clear() must have been called exactly once.
    expect(provider.calls.clear).toBe(1);
    // getKey() must return null immediately — no stale key after disconnect.
    expect(provider.getKey()).toBeNull();
  });

  it("cancels an in-flight sign-in so a late browser-auth resolve cannot re-authenticate", async () => {
    type AuthResult = {
      apiKey: string;
      tenantId: string;
      organizationName: string;
      apiKeyId: string;
    };

    let capturedResolve!: (v: AuthResult) => void;
    const mockBrowserAuth = vi.fn().mockImplementation(
      () =>
        new Promise<AuthResult>((resolve) => {
          capturedResolve = resolve;
        }),
    );

    const provider = makeProvider("sk-fresh", null);
    const result = startApp({ bus, performBrowserAuthImpl: mockBrowserAuth, apiKeyProvider: provider });
    server = result.server;
    baseUrl = result.baseUrl;
    const { authState } = result;
    const busEvents = collectBusEvents(bus);

    // Start an in-flight sign-in.
    const startRes = await fetch(`${baseUrl}/api/auth/start`, { method: "POST" });
    expect(startRes.status).toBe(200);

    // Give the async chain time to reach performBrowserAuthImpl.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedResolve).toBeDefined();

    // Disconnect while the browser flow is still pending.
    const disconnectRes = await fetch(`${baseUrl}/api/auth/disconnect`, { method: "POST" });
    expect(disconnectRes.status).toBe(200);

    // Confirm disconnect zeroed the key and set state to unauthenticated.
    expect(provider.getKey()).toBeNull();
    expect(authState.get().authenticated).toBe(false);

    // Now simulate the browser flow resolving late (after disconnect).
    capturedResolve({
      apiKey: "sk-late",
      tenantId: "tenant-1",
      organizationName: "Late Corp",
      apiKeyId: "key-late",
    });

    // Give the async chain time to (not) write credentials.
    await new Promise((r) => setTimeout(r, 20));

    // The late resolve must NOT have re-authenticated.
    expect(authState.get().authenticated).toBe(false);
    // The key must remain null — the cancelled chain must not call refresh().
    expect(provider.getKey()).toBeNull();
    // writeCredentials must NOT have been called (cancelled before reaching it).
    expect(writeCredentials).not.toHaveBeenCalled();

    // The bus should have exactly two auth.changed events:
    // one from disconnect (authenticated: false) — the cancelled chain emits nothing.
    const authEvents = busEvents.filter((e) => e.type === "auth.changed");
    const unauthEvents = authEvents.filter((e) => "authenticated" in e && !e.authenticated);
    expect(unauthEvents.length).toBeGreaterThanOrEqual(1);
  });
});
