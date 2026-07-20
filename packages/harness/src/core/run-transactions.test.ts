/**
 * Unit tests for run-transactions — the per-call cost drill-down fetcher.
 *
 * Covers the capability-label heuristic (provider-agnostic), the billable-only
 * filter (free orchestration rows dropped), step attribution
 * (workflowStepName ?? actionName), USD summing across active non-estimate
 * cost rows, and every non-throwing error path.
 */
import { describe, expect, it, vi } from "vitest";

import {
  capabilityLabel,
  createRunTransactionsFetcher,
} from "./run-transactions.js";

// ---------------------------------------------------------------------------
// capabilityLabel — provider-agnostic mapping
// ---------------------------------------------------------------------------

describe("capabilityLabel", () => {
  it("maps LLM generation (op or resource) to 'LLM'", () => {
    expect(capabilityLabel("generate", "messages")).toBe("LLM");
    expect(capabilityLabel("create", "chat.completion")).toBe("LLM");
  });

  it("maps sandbox + search resources to their capability", () => {
    expect(capabilityLabel("create", "sandbox")).toBe("sandbox");
    expect(capabilityLabel("execute", "/v1/search")).toBe("web search");
  });

  it("falls back to the operation verb for unknown shapes (never a provider)", () => {
    expect(capabilityLabel("provision", "widget")).toBe("provision");
    expect(capabilityLabel("", "")).toBe("capability");
  });
});

// ---------------------------------------------------------------------------
// fetcher — helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A realistic transactions envelope mirroring the live core shape. */
const TXNS_BODY = {
  data: [
    {
      actionName: "generate",
      resourceName: "messages",
      serviceName: "sapiom_litellm",
      metadata: {},
      costs: [
        { isActive: false, isEstimate: false, fiatAmount: "0.275000" },
        { isActive: true, isEstimate: false, fiatAmount: "0.045289" },
      ],
    },
    {
      actionName: "create",
      resourceName: "sandbox",
      serviceName: "sapiom_blaxel",
      metadata: { workflowStepName: "renderPdfs" },
      costs: [{ isActive: true, isEstimate: false, fiatAmount: "7.948800" }],
    },
    {
      actionName: "execute",
      resourceName: "/v1/search",
      serviceName: "sapiom_linkup",
      metadata: { workflowStepName: "resolveTargets" },
      costs: [{ isActive: true, isEstimate: false, fiatAmount: "0.055000" }],
    },
    // Free orchestration row — must be dropped (no active captured cost).
    {
      actionName: "analyzeTranscripts",
      resourceName: "portal",
      serviceName: "workflows",
      metadata: {},
      costs: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// createRunTransactionsFetcher
// ---------------------------------------------------------------------------

describe("createRunTransactionsFetcher", () => {
  it("returns 503 without touching the network when no apiKey", async () => {
    const fetchImpl = vi.fn();
    const f = createRunTransactionsFetcher({ apiKey: null, fetchImpl });
    const res = await f.fetch("60248");
    expect(res).toEqual({
      ok: false,
      status: 503,
      error: "harness is not signed in to Sapiom",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps billable calls, attributes steps, and drops free rows", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(TXNS_BODY));
    const f = createRunTransactionsFetcher({
      apiKey: "sk_test",
      baseUrl: "https://api.example.com",
      fetchImpl,
    });

    const res = await f.fetch("60248");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The free orchestration row is dropped → 3 billable calls remain.
    expect(res.calls).toEqual([
      { stepName: "generate", capability: "LLM", op: "generate", usd: "0.045289" },
      { stepName: "renderPdfs", capability: "sandbox", op: "create", usd: "7.948800" },
      {
        stepName: "resolveTargets",
        capability: "web search",
        op: "execute",
        usd: "0.055000",
      },
    ]);
  });

  it("uses workflowStepName when present, else the operation verb", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(TXNS_BODY));
    const f = createRunTransactionsFetcher({ apiKey: "sk_test", fetchImpl });
    const res = await f.fetch("60248");
    if (!res.ok) throw new Error("expected ok");
    // litellm generate had no workflowStepName → falls back to op "generate".
    expect(res.calls[0].stepName).toBe("generate");
    // blaxel carried workflowStepName → "renderPdfs".
    expect(res.calls[1].stepName).toBe("renderPdfs");
  });

  it("sums only active, non-estimate cost rows into usd", async () => {
    const body = {
      data: [
        {
          actionName: "create",
          resourceName: "sandbox",
          metadata: { workflowStepName: "s" },
          costs: [
            { isActive: true, isEstimate: false, fiatAmount: "1.5" },
            { isActive: true, isEstimate: false, fiatAmount: "0.5" },
            { isActive: false, isEstimate: false, fiatAmount: "9.9" }, // superseded
            { isActive: true, isEstimate: true, fiatAmount: "9.9" }, // estimate
          ],
        },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    const f = createRunTransactionsFetcher({ apiKey: "sk_test", fetchImpl });
    const res = await f.fetch("60248");
    if (!res.ok) throw new Error("expected ok");
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0].usd).toBe("2.000000");
  });

  it("sends the trace filter + page[limit] with the api key header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [] }));
    const f = createRunTransactionsFetcher({
      apiKey: "sk_test",
      baseUrl: "https://api.example.com",
      fetchImpl,
    });
    await f.fetch("60248");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/v1/transactions");
    expect(url).toContain("filter[trace_external_id]=60248");
    expect(url).toContain("page[limit]=100");
    expect((init as RequestInit).headers).toEqual({ "x-api-key": "sk_test" });
  });

  it("returns 404 / 502 for upstream failures, never throwing", async () => {
    const notFound = createRunTransactionsFetcher({
      apiKey: "sk_test",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404)),
    });
    expect(await notFound.fetch("x")).toEqual({
      ok: false,
      status: 404,
      error: "transactions not found",
    });

    const upstream500 = createRunTransactionsFetcher({
      apiKey: "sk_test",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 500)),
    });
    expect(await upstream500.fetch("x")).toEqual({
      ok: false,
      status: 502,
      error: "gateway responded 500",
    });

    const networkErr = createRunTransactionsFetcher({
      apiKey: "sk_test",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("boom")),
    });
    expect(await networkErr.fetch("x")).toEqual({
      ok: false,
      status: 502,
      error: "gateway unreachable",
    });
  });
});
