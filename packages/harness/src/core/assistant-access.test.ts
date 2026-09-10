import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import { AssistantAccess } from "./assistant-access.js";
import { StudioCredentialRefreshError } from "./studio-credentials.js";

let access: AssistantAccess;
let env: ResolvedEnvironment;
let key: string | null;
const request = vi.fn();
const load = vi.fn();
const pair = {
  accessToken: "sat_user",
  refreshToken: "srt_user",
  expiresAt: "2030-01-01T00:00:00Z",
};
const enabled = {
  protocol: 1,
  assistant: true,
  userId: "user-one",
  tenantId: "tenant",
  identityRevision: "identity-one",
  maxAgeMs: 60000,
  refreshAfterMs: 30000,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
  key = "sk_private";
  env = {
    name: "staging",
    apiURL: "https://api.sapiom.dev",
    appURL: "https://app.sapiom.dev",
    services: {},
    credentials: {
      apiKey: key,
      tenantId: "tenant",
      organizationName: "Org",
      apiKeyId: "key",
      studioCredentials: pair,
    },
  };
  load.mockReset().mockImplementation(async () => structuredClone(env));
  request.mockReset().mockImplementation(async () => Response.json(enabled));
  access = new AssistantAccess({
    enabled: true,
    harnessVersion: "0.16.0",
    getApiKey: () => key,
    loadEnvironment: load,
    refreshCredentials: async (environment) =>
      environment.credentials!.studioCredentials!,
    fetch: request,
  });
});
afterEach(() => {
  access.close();
  vi.useRealTimers();
});

describe("Assistant access", () => {
  it("starts off and uses the trusted user token, never the org key, for evaluation", async () => {
    expect(access.get()).toBeNull();
    await access.refresh();
    expect(access.get()).toMatchObject({
      userId: "user-one",
      tenantId: "tenant",
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.sapiom.dev/v1/studio/capabilities",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer sat_user",
          "X-Studio-Capability-Version": "1",
          "X-Studio-Harness-Version": "0.16.0",
        },
        redirect: "error",
      }),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain("sk_private");
  });

  it.each([
    {},
    { ...enabled, assistant: false },
    { ...enabled, assistant: "true" },
    { ...enabled, protocol: 2 },
    { ...enabled, tenantId: "other" },
    { ...enabled, maxAgeMs: 0 },
    { ...enabled, userId: 123 },
    { ...enabled, identityRevision: {} },
  ])("denies invalid or ineligible responses", async (result) => {
    request.mockResolvedValue(Response.json(result));
    await access.refresh();
    expect(access.get()).toBeNull();
  });

  it("does no network work in no-auth mode or without trusted user credentials", async () => {
    access.close();
    access = new AssistantAccess({
      enabled: false,
      harnessVersion: "0.16.0",
      getApiKey: () => key,
      loadEnvironment: load,
      fetch: request,
    });
    await access.refresh();
    expect(load).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes independently of analytics, and remote disable removes a running grant", async () => {
    const changed = vi.fn();
    access.subscribe(changed);
    await access.refresh();
    request.mockImplementation(async () => Response.json({ assistant: false }));
    await vi.advanceTimersByTimeAsync(30000);
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("access_denied");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("retains an unchanged verified grant through successive network and 5xx failures only until its original expiry", async () => {
    const changed = vi.fn();
    access.subscribe(changed);
    await access.refresh();
    const grant = access.get()!;
    request.mockRejectedValueOnce(new TypeError("offline"));
    await access.refresh();
    expect(access.get()).toBe(grant);
    request.mockResolvedValueOnce(new Response("", { status: 503 }));
    await access.refresh();
    expect(access.get()).toBe(grant);
    expect(access.get()!.expiresAt).toBe(grant.expiresAt);
    expect(changed).toHaveBeenCalledOnce();
    vi.setSystemTime(grant.expiresAt + 1);
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("access_expired");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("retains a grant through a classified credential-refresh outage without extending it", async () => {
    await access.refresh();
    const grant = access.get()!;
    env.credentials!.studioCredentials = {
      ...pair,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    access.close();
    access = new AssistantAccess({
      enabled: true,
      harnessVersion: "0.16.0",
      getApiKey: () => key,
      loadEnvironment: load,
      refreshCredentials: async () => {
        throw new StudioCredentialRefreshError("transient", "offline");
      },
      fetch: request,
    });
    // A new host must never invent eligibility from an outage.
    await access.refresh();
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("transport_unavailable");

    access.close();
    env.credentials!.studioCredentials = pair;
    let fail = false;
    access = new AssistantAccess({
      enabled: true,
      harnessVersion: "0.16.0",
      getApiKey: () => key,
      loadEnvironment: load,
      refreshCredentials: async (environment) => {
        if (fail)
          throw new StudioCredentialRefreshError("transient", "offline");
        return environment.credentials!.studioCredentials!;
      },
      fetch: request,
    });
    await access.refresh();
    const verified = access.get()!;
    fail = true;
    await access.refresh();
    expect(access.get()).toBe(verified);
    expect(access.get()!.expiresAt).toBe(verified.expiresAt);
    expect(verified.expiresAt).toBe(grant.expiresAt);
  });

  it("expires within 60 seconds even when a refresh is stuck", async () => {
    await access.refresh();
    load.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(60001);
    expect(access.get()).toBeNull();
  });

  it("revokes when another credential in the same organization resolves off", async () => {
    await access.refresh();
    env.credentials!.studioCredentials = {
      ...pair,
      accessToken: "sat_other",
      refreshToken: "srt_other",
    };
    request.mockImplementation(async () => {
      return Response.json({ assistant: false });
    });
    await access.refresh();
    expect(access.get()).toBeNull();
  });

  it("keeps running access through another host's normal token rotation", async () => {
    const changed = vi.fn();
    access.subscribe(changed);
    await access.refresh();
    env.credentials!.studioCredentials = {
      ...pair,
      accessToken: "sat_rotated",
      refreshToken: "srt_rotated",
    };
    await access.refresh();
    expect(access.get()?.identityRevision).toBe("identity-one");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("fences an older response when a newer credential observation is queued", async () => {
    await access.refresh();
    const expiry = access.get()!.expiresAt;
    let complete!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const old = access.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const latest = access.refresh();
    complete(Response.json({ ...enabled, identityRevision: "stale" }));
    await old;
    expect(access.get()?.identityRevision).toBe("identity-one");
    expect(access.get()?.expiresAt).toBe(expiry);
    await latest;
  });

  it("does not adopt a late response after sign-out or shutdown", async () => {
    let complete!: (response: Response) => void;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const refresh = access.refresh();
    await vi.advanceTimersByTimeAsync(0);
    access.clear();
    complete(Response.json(enabled));
    await refresh;
    expect(access.get()).toBeNull();
  });

  it("invalidates on a key change, unreadable credentials, and expired credentials", async () => {
    await access.refresh();
    key = null;
    expect(access.get()).toBeNull();
    key = "sk_private";
    load.mockRejectedValue(new Error("unreadable"));
    await access.refresh();
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("access_denied");
    load.mockImplementation(async () => structuredClone(env));
    env.credentials!.studioCredentials = {
      ...pair,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    await access.refresh();
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("authentication_required");
  });

  it("revokes the old authority before evaluating an identity or tenant crossover", async () => {
    const changed = vi.fn();
    access.subscribe(changed);
    await access.refresh();
    let finish!: (response: Response) => void;
    env.credentials!.tenantId = "other-tenant";
    request.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    );
    const pending = access.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("access_denied");
    expect(changed).toHaveBeenCalledTimes(2);
    finish(Response.json({ ...enabled, tenantId: "other-tenant" }));
    await pending;
    expect(access.get()).toMatchObject({ tenantId: "other-tenant" });
  });

  it("does not extend the lease by slow response delivery", async () => {
    request.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 4000);
      return Response.json({ ...enabled, maxAgeMs: 1000 });
    });
    await access.refresh();
    expect(access.get()).toBeNull();
  });
});
