import { describe, it, expect, vi } from "vitest";

import { createRunStateFetcher, resolveAgentsBaseUrl } from "./run-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Response with a given status and JSON body. */
function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

/**
 * A realistic raw execution projection for a generic "invoice-sync" agent.
 * Uses `status:"succeeded"` on the passing step to exercise the real prod
 * engine vocabulary end-to-end (the key gotcha this module fixes).
 */
const RAW_SUCCESS_DOC = {
  id: "exec_invoice_001",
  name: "invoice-sync",
  status: "completed",
  currentStep: null,
  startedAt: "2026-07-01T10:00:00.000Z",
  finishedAt: "2026-07-01T10:00:30.000Z",
  steps: [
    {
      id: "step_0",
      stepName: "validateInput",
      stepOrder: 0,
      attempt: 1,
      status: "succeeded", // real prod engine vocabulary — NOT "completed"
      spanId: "span_validate",
      startedAt: "2026-07-01T10:00:00.000Z",
      finishedAt: "2026-07-01T10:00:10.000Z",
      logs: [
        {
          ts: "2026-07-01T10:00:01.000Z",
          level: "info",
          msg: "Validating invoice payload",
        },
        {
          ts: "2026-07-01T10:00:09.000Z",
          level: "info",
          msg: "Validation passed",
        },
      ],
      error: null,
    },
    {
      id: "step_1",
      stepName: "chargeCard",
      stepOrder: 1,
      attempt: 1,
      status: "failed",
      spanId: "span_charge",
      startedAt: "2026-07-01T10:00:10.000Z",
      finishedAt: "2026-07-01T10:00:30.000Z",
      logs: [],
      error: { message: "Card declined: insufficient funds" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveAgentsBaseUrl", () => {
  it("defaults to the tools base when no env vars are set", () => {
    const saved = {
      agents: process.env.SAPIOM_AGENTS_URL,
      tools: process.env.SAPIOM_TOOLS_BASE,
    };
    delete process.env.SAPIOM_AGENTS_URL;
    delete process.env.SAPIOM_TOOLS_BASE;
    expect(resolveAgentsBaseUrl()).toBe("https://tools.sapiom.ai");
    if (saved.agents !== undefined)
      process.env.SAPIOM_AGENTS_URL = saved.agents;
    if (saved.tools !== undefined) process.env.SAPIOM_TOOLS_BASE = saved.tools;
  });

  it("prefers SAPIOM_AGENTS_URL over SAPIOM_TOOLS_BASE", () => {
    const saved = {
      agents: process.env.SAPIOM_AGENTS_URL,
      tools: process.env.SAPIOM_TOOLS_BASE,
    };
    process.env.SAPIOM_AGENTS_URL = "https://agents.example.com";
    process.env.SAPIOM_TOOLS_BASE = "https://tools.example.com";
    expect(resolveAgentsBaseUrl()).toBe("https://agents.example.com");
    if (saved.agents !== undefined)
      process.env.SAPIOM_AGENTS_URL = saved.agents;
    else delete process.env.SAPIOM_AGENTS_URL;
    if (saved.tools !== undefined) process.env.SAPIOM_TOOLS_BASE = saved.tools;
    else delete process.env.SAPIOM_TOOLS_BASE;
  });
});

describe("createRunStateFetcher — no apiKey", () => {
  it("returns 503 without calling the network when apiKey is null", async () => {
    const mockFetch = vi.fn();
    const fetcher = createRunStateFetcher({
      apiKey: null,
      fetchImpl: mockFetch,
    });
    const result = await fetcher.fetch("exec_invoice_001");
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "harness is not signed in to Sapiom",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("createRunStateFetcher — success path (proves succeeded→passed fix end-to-end)", () => {
  it("maps a two-step doc with succeeded+failed steps to a correct RunView", async () => {
    const mockFetch = makeFetch(200, RAW_SUCCESS_DOC);
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing

    const { runView } = result;
    expect(runView.executionId).toBe("exec_invoice_001");
    expect(runView.status).toBe("completed");

    // Step 0: succeeded → passed (the critical real-vocab mapping)
    expect(runView.steps[0].status).toBe("passed");
    expect(runView.steps[0].name).toBe("validateInput");
    expect(runView.steps[0].latencyMs).toBe(10_000); // 10:00:00 → 10:00:10
    expect(runView.steps[0].logSlice).toContain("Validation passed");
    expect(runView.steps[0]).not.toHaveProperty("error");

    // Step 1: failed → failed
    expect(runView.steps[1].status).toBe("failed");
    expect(runView.steps[1].name).toBe("chargeCard");
    expect(runView.steps[1].error).toBe("Card declined: insufficient funds");
  });

  it("uses the correct URL and x-sapiom-api-key header", async () => {
    const mockFetch = makeFetch(200, RAW_SUCCESS_DOC);
    const fetcher = createRunStateFetcher({
      apiKey: "sk-my-key",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    await fetcher.fetch("exec_invoice_001");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://agents.test/agents/v1/executions/exec_invoice_001",
      { headers: { "x-sapiom-api-key": "sk-my-key" } },
    );
  });
});

describe("createRunStateFetcher — error paths", () => {
  it("returns 404 when the gateway responds 404", async () => {
    const mockFetch = makeFetch(404, { error: "not found" });
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_missing");
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "execution not found",
    });

    // Verify URL construction with the correct execution id
    expect(mockFetch).toHaveBeenCalledWith(
      "https://agents.test/agents/v1/executions/exec_missing",
      expect.objectContaining({ headers: { "x-sapiom-api-key": "sk-test" } }),
    );
  });

  it("returns 502 when the gateway responds with a non-2xx non-404 status", async () => {
    const mockFetch = makeFetch(500, { error: "internal server error" });
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway responded 500",
    });
  });

  it("returns 502 when fetch throws a network error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway unreachable",
    });
  });

  it("returns 502 when the response body is malformed JSON (json() throws)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    } as unknown as Response);

    const fetcher = createRunStateFetcher({
      apiKey: "sk-test",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "could not decode execution",
    });
  });
});
