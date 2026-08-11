import { describe, expect, it, vi } from "vitest";

import { createAccountPlanReader, extractBalance, extractLimit, extractPlan } from "./account-plan.js";
import type { ApiKeyProvider } from "./api-key-provider.js";

const BASE = "http://localhost:3000";

/** `GET /v1/dashboard/plan` as core serves it (envelope: `{ data: … }`). */
function planBody(over: Record<string, unknown> = {}): unknown {
  return {
    data: {
      plan: { key: "free_v0", name: "Free", status: "active" },
      subscriptionStatus: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      overageSpendCap: null,
      ...over,
    },
  };
}

/** `GET /v1/spending-rules/spend-limit-summary` (JSON:API envelope). */
function limitBody(attrs: Record<string, unknown>): unknown {
  return {
    data: { type: "spend-limit-summary", id: "tenant-1", attributes: attrs },
    meta: { organizationId: "org-1", queriedAt: "2026-08-11T00:00:00Z" },
  };
}

/** `GET /v1/accounts/spend` (read-model envelope: `{ data: … }`). */
function spendBody(over: Record<string, unknown> = {}): unknown {
  return {
    data: {
      availableBalanceUsd: 37.6,
      spend: { "24h": 1.2, "7d": 8.4, "30d": 12.4 },
      burnPerDayUsd: 1.2,
      runwayDays: 31,
      ...over,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route the three core paths to canned bodies; anything else 404s. */
function fetchFor(routes: Record<string, () => Response>): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [suffix, make] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return make();
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

/** A provider whose key can change, so refresh-on-401 is observable. */
function provider(keys: Array<string | null>): ApiKeyProvider & { refreshCalls: number } {
  let index = 0;
  const state = {
    refreshCalls: 0,
    getKey: () => keys[Math.min(index, keys.length - 1)],
    refresh: async () => {
      state.refreshCalls += 1;
      index += 1;
      return keys[Math.min(index, keys.length - 1)];
    },
    setKey: () => {},
  };
  return state as unknown as ApiKeyProvider & { refreshCalls: number };
}

describe("extractPlan / extractLimit / extractBalance", () => {
  it("narrows the happy shapes", () => {
    expect(extractPlan(planBody())).toEqual({ name: "Free", status: "active" });
    expect(extractLimit(limitBody({ limitUsd: 50, windowSpendUsd: 12.4 }))).toEqual({
      usedUsd: 12.4,
      limitUsd: 50,
    });
    expect(extractBalance(spendBody())).toBe(37.6);
  });

  it("accepts decimal STRINGS for money (the ledger's decimal(36,18) habit)", () => {
    expect(extractLimit(limitBody({ limitUsd: "50", windowSpendUsd: "12.40" }))).toEqual({
      usedUsd: 12.4,
      limitUsd: 50,
    });
    expect(extractBalance({ data: { availableBalanceUsd: "37.60" } })).toBe(37.6);
  });

  it("returns null on every drifted or empty shape rather than throwing", () => {
    expect(extractPlan(planBody({ plan: null }))).toBeNull();
    expect(extractPlan({ data: {} })).toBeNull();
    expect(extractPlan(undefined)).toBeNull();
    expect(extractPlan([1, 2])).toBeNull();
    // The no-rule answer: attributes present, every value null.
    expect(
      extractLimit(limitBody({ limitUsd: null, windowSpendUsd: null, ruleId: null })),
    ).toBeNull();
    expect(extractLimit({ data: "wat" })).toBeNull();
    expect(extractBalance({ data: { availableBalanceUsd: "not-a-number" } })).toBeNull();
    expect(extractBalance(null)).toBeNull();
  });

  it("maps a non-active plan status to 'inactive' instead of trusting the string", () => {
    expect(extractPlan(planBody({ plan: { name: "Free", status: "paused" } }))).toEqual({
      name: "Free",
      status: "inactive",
    });
  });
});

describe("createAccountPlanReader", () => {
  it("assembles the limit readout with a Bearer token against /v1 paths", async () => {
    const fetchImpl = fetchFor({
      "/v1/dashboard/plan": () => jsonResponse(planBody()),
      "/v1/spending-rules/spend-limit-summary": () =>
        jsonResponse(limitBody({ limitUsd: 50, windowSpendUsd: 12.4 })),
      "/v1/accounts/spend": () => jsonResponse(spendBody()),
    });
    const reader = createAccountPlanReader({ apiKey: "sk_live", baseUrl: BASE, fetchImpl });

    const view = await reader.view();

    expect(view).toEqual({
      plan: { name: "Free", status: "active" },
      readout: { kind: "limit", usedUsd: 12.4, limitUsd: 50 },
      source: "live",
    });
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(
      expect.arrayContaining([
        `${BASE}/v1/dashboard/plan`,
        `${BASE}/v1/spending-rules/spend-limit-summary`,
        `${BASE}/v1/accounts/spend`,
      ]),
    );
    for (const call of fetchImpl.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({ Authorization: "Bearer sk_live" });
    }
  });

  it("falls back to the prepaid balance when no spend-limit rule exists", async () => {
    const reader = createAccountPlanReader({
      apiKey: "sk_live",
      baseUrl: BASE,
      fetchImpl: fetchFor({
        "/v1/dashboard/plan": () => jsonResponse(planBody()),
        "/v1/spending-rules/spend-limit-summary": () =>
          jsonResponse(limitBody({ limitUsd: null, windowSpendUsd: null, ruleId: null })),
        "/v1/accounts/spend": () => jsonResponse(spendBody()),
      }),
    });

    expect((await reader.view()).readout).toEqual({ kind: "balance", availableUsd: 37.6 });
  });

  it("keeps a partial view when only some reads answer (plan null, numbers live)", async () => {
    const reader = createAccountPlanReader({
      apiKey: "sk_live",
      baseUrl: BASE,
      fetchImpl: fetchFor({
        "/v1/dashboard/plan": () => jsonResponse({ error: "boom" }, 500),
        "/v1/spending-rules/spend-limit-summary": () =>
          jsonResponse(limitBody({ limitUsd: 50, windowSpendUsd: 12.4 })),
        "/v1/accounts/spend": () => jsonResponse({ error: "boom" }, 500),
      }),
    });

    expect(await reader.view()).toEqual({
      plan: null,
      readout: { kind: "limit", usedUsd: 12.4, limitUsd: 50 },
      source: "live",
    });
  });

  it("answers signed-out without touching the network", async () => {
    const fetchImpl = fetchFor({});
    const reader = createAccountPlanReader({ apiKey: null, baseUrl: BASE, fetchImpl });

    expect(await reader.view()).toEqual({
      plan: null,
      readout: { kind: "none" },
      source: "fallback",
      reason: "signed-out",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers unreachable when nothing answers, and does NOT cache it", async () => {
    let up = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (!up) throw new Error("ECONNREFUSED");
      const url = String(input);
      if (url.endsWith("/v1/dashboard/plan")) return jsonResponse(planBody());
      if (url.endsWith("/v1/spending-rules/spend-limit-summary"))
        return jsonResponse(limitBody({ limitUsd: 50, windowSpendUsd: 12.4 }));
      return jsonResponse(spendBody());
    }) as unknown as typeof fetch;
    const reader = createAccountPlanReader({ apiKey: "sk_live", baseUrl: BASE, fetchImpl });

    expect(await reader.view()).toEqual({
      plan: null,
      readout: { kind: "none" },
      source: "fallback",
      reason: "unreachable",
    });

    // Core comes back → the very next view() is live, because failures are
    // deliberately not TTL-cached.
    up = true;
    expect((await reader.view()).source).toBe("live");
  });

  it("caches a live view for the TTL (one fetch burst, not one per call)", async () => {
    const fetchImpl = fetchFor({
      "/v1/dashboard/plan": () => jsonResponse(planBody()),
      "/v1/spending-rules/spend-limit-summary": () =>
        jsonResponse(limitBody({ limitUsd: 50, windowSpendUsd: 12.4 })),
      "/v1/accounts/spend": () => jsonResponse(spendBody()),
    });
    const reader = createAccountPlanReader({ apiKey: "sk_live", baseUrl: BASE, fetchImpl });

    await reader.view();
    await reader.view();

    expect(fetchImpl.mock.calls.length).toBe(3);
  });

  it("refreshes the key once on a 401 and retries", async () => {
    const keys = provider(["sk_stale", "sk_fresh"]);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Bearer sk_stale") return jsonResponse({ error: "unauthorized" }, 401);
      const url = String(input);
      if (url.endsWith("/v1/dashboard/plan")) return jsonResponse(planBody());
      if (url.endsWith("/v1/spending-rules/spend-limit-summary"))
        return jsonResponse(limitBody({ limitUsd: 50, windowSpendUsd: 12.4 }));
      return jsonResponse(spendBody());
    }) as unknown as typeof fetch;
    const reader = createAccountPlanReader({ apiKey: keys, baseUrl: BASE, fetchImpl });

    const view = await reader.view();

    expect(view.source).toBe("live");
    expect(view.readout).toEqual({ kind: "limit", usedUsd: 12.4, limitUsd: 50 });
    expect(keys.refreshCalls).toBeGreaterThanOrEqual(1);
  });
});
