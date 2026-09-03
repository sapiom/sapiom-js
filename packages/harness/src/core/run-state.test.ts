import { describe, it, expect, vi } from "vitest";

import {
  createRunStateFetcher,
  isAuthRejection,
  resolveAgentsBaseUrl,
} from "./run-state.js";
import { staticApiKeyProvider } from "./api-key-provider.js";
import type { ApiKeyProvider } from "./api-key-provider.js";

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

/** One mock Response for a given status/body — sequenced by makeSequencedFetch. */
function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response;
}

/** A fetch that returns each queued Response in order across successive calls
 *  (the last one repeats if called more times than queued). Lets a test drive
 *  a 401-then-200 refresh+retry sequence. */
function makeSequencedFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve(res);
  });
}

/** A provider whose refresh() swaps to `refreshedKey` exactly once, recording
 *  how many times refresh was invoked — models the shared credential store
 *  handing back a newer key after a re-login. */
function refreshingProvider(
  initialKey: string | null,
  refreshedKey: string | null,
): ApiKeyProvider & { refreshCalls: number } {
  let current = initialKey;
  let refreshed = false;
  const provider = {
    refreshCalls: 0,
    getKey: () => current,
    refresh: () => {
      provider.refreshCalls += 1;
      if (!refreshed) {
        refreshed = true;
        current = refreshedKey;
      }
      return Promise.resolve(current);
    },
    clear: () => {
      current = null;
    },
  };
  return provider;
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

describe("isAuthRejection", () => {
  it("treats 401 and 403 as auth rejections, nothing else", () => {
    expect(isAuthRejection(401)).toBe(true);
    expect(isAuthRejection(403)).toBe(true);
    expect(isAuthRejection(404)).toBe(false);
    expect(isAuthRejection(500)).toBe(false);
    expect(isAuthRejection(200)).toBe(false);
  });
});

describe("createRunStateFetcher — refresh-on-401", () => {
  it("refreshes the key and retries once on a 401, recovering when a newer key exists", async () => {
    // First call (stale key) → 401; refresh yields a new key; retry → 200.
    const mockFetch = makeSequencedFetch([
      response(401, { error: "unauthorized" }),
      response(200, RAW_SUCCESS_DOC),
    ]);
    const provider = refreshingProvider("sk-stale", "sk-fresh");
    const fetcher = createRunStateFetcher({
      apiKey: provider,
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    // Recovered: the retry's 200 mapped to a RunView.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runView.executionId).toBe("exec_invoice_001");

    // Exactly one refresh, exactly two upstream calls (original + retry).
    expect(provider.refreshCalls).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt used the stale key…
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://agents.test/agents/v1/executions/exec_invoice_001",
      { headers: { "x-sapiom-api-key": "sk-stale" } },
    );
    // …the retry used the refreshed key.
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://agents.test/agents/v1/executions/exec_invoice_001",
      { headers: { "x-sapiom-api-key": "sk-fresh" } },
    );
  });

  it("also refreshes + retries on a 403 (key valid but lost authorization)", async () => {
    const mockFetch = makeSequencedFetch([
      response(403, { error: "forbidden" }),
      response(200, RAW_SUCCESS_DOC),
    ]);
    const provider = refreshingProvider("sk-old-org", "sk-new-org");
    const fetcher = createRunStateFetcher({
      apiKey: provider,
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    expect(result.ok).toBe(true);
    expect(provider.refreshCalls).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry when refresh yields the same key (nothing to recover with)", async () => {
    const mockFetch = makeSequencedFetch([
      response(401, { error: "unauthorized" }),
      response(200, RAW_SUCCESS_DOC),
    ]);
    // refresh returns the same stale key — the store had nothing newer.
    const provider = refreshingProvider("sk-stale", "sk-stale");
    const fetcher = createRunStateFetcher({
      apiKey: provider,
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    // Refresh was attempted, but with no newer key the original 401 stands and
    // maps to the honest upstream-error status (502) — no wasted retry.
    expect(provider.refreshCalls).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway responded 401",
    });
  });

  it("does not refresh a plain static key on 401 (bare string never refreshes)", async () => {
    const mockFetch = makeSequencedFetch([
      response(401, { error: "unauthorized" }),
      response(200, RAW_SUCCESS_DOC),
    ]);
    const fetcher = createRunStateFetcher({
      apiKey: "sk-static",
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    // Static key has a no-op refresh → same key → no retry; the 401 stands.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway responded 401",
    });
  });

  it("does not refresh when the first call already succeeds", async () => {
    const mockFetch = makeSequencedFetch([response(200, RAW_SUCCESS_DOC)]);
    const provider = refreshingProvider("sk-good", "sk-should-not-use");
    const fetcher = createRunStateFetcher({
      apiKey: provider,
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    expect(result.ok).toBe(true);
    expect(provider.refreshCalls).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on a non-auth error (404/500 fall straight through)", async () => {
    const mockFetch = makeFetch(500, { error: "boom" });
    const provider = refreshingProvider("sk-key", "sk-new");
    const fetcher = createRunStateFetcher({
      apiKey: provider,
      baseUrl: "https://agents.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec_invoice_001");

    expect(provider.refreshCalls).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway responded 500",
    });
  });

  it("returns 503 without any network call when the provider holds no key", async () => {
    const mockFetch = vi.fn();
    const fetcher = createRunStateFetcher({
      apiKey: staticApiKeyProvider(null),
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

// ---------------------------------------------------------------------------
// Core fallback: a gateway 404 is ambiguous — route missing, or execution missing
// ---------------------------------------------------------------------------

describe("createRunStateFetcher — Core fallback on a gateway 404", () => {
  /**
   * The case this exists for. On a local stack `GET /agents/v1/executions/:id`
   * is not mounted, so the gateway answers 404 for a cloud run that completed
   * perfectly well — and Studio reported "execution not found" for a run whose
   * output was sitting in Core the whole time.
   */
  it("renders the execution from Core when the gateway has no such route", async () => {
    const mockFetch = makeSequencedFetch([
      response(404, { message: "Cannot GET /agents/v1/executions/58" }),
      response(200, RAW_SUCCESS_DOC),
    ]);
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("58");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runView.status).toBe("completed");
  });

  it("asks Core with Core's header, not the gateway's", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return Promise.resolve(
        calls.length === 1 ? response(404, {}) : response(200, RAW_SUCCESS_DOC),
      );
    }) as unknown as typeof fetch;

    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });
    await fetcher.fetch("58");

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://agents.test/agents/v1/executions/58");
    expect(calls[0].headers["x-sapiom-api-key"]).toBe("sk-test-key");
    // Core rejects the gateway's header with a 401, so it must not be reused.
    expect(calls[1].url).toBe("https://core.test/v1/workflows/executions/58");
    expect(calls[1].headers["x-api-key"]).toBe("sk-test-key");
    expect(calls[1].headers["x-sapiom-api-key"]).toBeUndefined();
  });

  /** Both surfaces disclaim it: now "not found" is the honest answer. */
  it("keeps the 404 when Core has not heard of it either", async () => {
    const mockFetch = makeFetch(404, { error: "not found" });
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("nope");

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "execution not found",
    });
  });

  it("keeps the 404 when Core itself is unreachable", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(response(404, {}));
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof fetch;

    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("58");
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "execution not found",
    });
  });

  /**
   * `decodeExecutionProjection` is lenient — it accepts an unfamiliar object
   * rather than throwing — so the only way this path is reached is a body that
   * will not parse at all. A truncated response, say.
   */
  it("reports a decode failure rather than claiming the run is missing", async () => {
    const unparseable = {
      status: 200,
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    } as Response;
    const mockFetch = makeSequencedFetch([response(404, {}), unparseable]);
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("58");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
  });

  /**
   * The gateway remains the owner of deployed runs in production: a 200 there
   * must never trigger a second call.
   */
  it("does not touch Core when the gateway answers", async () => {
    const mockFetch = makeFetch(200, RAW_SUCCESS_DOC);
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });

    await fetcher.fetch("58");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not touch Core for a non-404 gateway failure", async () => {
    const mockFetch = makeFetch(500, { error: "boom" });
    const fetcher = createRunStateFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://agents.test",
      coreBaseUrl: "https://core.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("58");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});
