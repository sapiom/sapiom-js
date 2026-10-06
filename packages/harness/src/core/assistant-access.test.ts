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

  it("stays on with no further check until the next interval", async () => {
    await access.refresh();
    const revision = access.getBrowserState().authorityRevision;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(access.getBrowserState()).toEqual({
      enabled: true,
      authorityRevision: revision,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rechecks every five minutes, so turning the flag off takes effect", async () => {
    const listener = vi.fn();
    access.subscribe(listener);
    await access.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    request.mockImplementation(async () =>
      Response.json({ ...enabled, assistant: false }),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("access_denied");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer through network, 5xx and transient refresh failures", async () => {
    await access.refresh();
    request.mockRejectedValueOnce(new Error("offline"));
    await access.refresh();
    expect(access.get()).not.toBeNull();
    request.mockImplementationOnce(async () => new Response("", { status: 503 }));
    await access.refresh();
    expect(access.get()).not.toBeNull();
    const transient = new AssistantAccess({
      enabled: true,
      harnessVersion: "0.16.0",
      getApiKey: () => key,
      loadEnvironment: load,
      refreshCredentials: async () => {
        throw new StudioCredentialRefreshError("transient", "offline");
      },
      fetch: request,
    });
    await transient.refresh();
    expect(transient.getFailureCode()).toBe("transport_unavailable");
    transient.close();
  });

  it("does no network work in no-auth mode or without Studio credentials", async () => {
    const off = new AssistantAccess({
      enabled: false,
      harnessVersion: "0.16.0",
      getApiKey: () => key,
      loadEnvironment: load,
      fetch: request,
    });
    await off.refresh();
    expect(off.get()).toBeNull();
    off.close();
    delete env.credentials!.studioCredentials;
    await access.refresh();
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("authentication_required");
    expect(request).not.toHaveBeenCalled();
  });

  it("turns off on 401/403, a malformed or denied answer, or another org's answer", async () => {
    for (const response of [
      new Response("", { status: 401 }),
      new Response("not json"),
      Response.json({ assistant: true }),
      Response.json({ ...enabled, tenantId: "another-tenant" }),
    ]) {
      await access.refresh();
      expect(access.get()).not.toBeNull();
      request.mockImplementationOnce(async () => response);
      await access.refresh();
      expect(access.get()).toBeNull();
    }
  });

  it("rotates the browser revision only when the account changes", async () => {
    await access.refresh();
    const first = access.getBrowserState().authorityRevision;
    await access.refresh();
    expect(access.getBrowserState().authorityRevision).toBe(first);
    request.mockImplementation(async () =>
      Response.json({ ...enabled, userId: "user-two" }),
    );
    await access.refresh();
    expect(access.getBrowserState().authorityRevision).not.toBe(first);
  });

  it("drops access when the harness key no longer matches the grant", async () => {
    await access.refresh();
    key = "sk_other";
    expect(access.get()).toBeNull();
    expect(access.getFailureCode()).toBe("authentication_required");
  });

  it("ignores an older check that finishes after a newer one or after sign-out", async () => {
    let release!: (response: Response) => void;
    request.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const slow = access.refresh();
    await vi.advanceTimersByTimeAsync(0);
    access.clear();
    release(Response.json(enabled));
    await slow;
    expect(access.get()).toBeNull();
  });
});
