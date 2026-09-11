import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedEnvironment } from "@sapiom/mcp/auth";
import { AssistantAccess } from "./assistant-access.js";

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
    expect(changed).toHaveBeenCalledTimes(2);
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

  it("invalidates on a key change, offline evaluation, and unreadable credentials", async () => {
    await access.refresh();
    key = null;
    expect(access.get()).toBeNull();
    key = "sk_private";
    request.mockRejectedValue(new Error("offline"));
    await access.refresh();
    expect(access.get()).toBeNull();
    load.mockRejectedValue(new Error("unreadable"));
    await access.refresh();
    expect(access.get()).toBeNull();
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
