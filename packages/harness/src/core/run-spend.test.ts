import { describe, it, expect, vi } from "vitest";

import { createRunSpendFetcher, resolveCoreBaseUrl } from "./run-spend.js";

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
 * A realistic ExecutionSpendDto response mirroring the real spend endpoint.
 * USD values are strings per the API contract.
 */
const RAW_SPEND_DOC = {
  capability: {
    totalUsd: "28.630476",
    capturedUsd: "28.630476",
    authorizedUsd: "0",
    settleState: "final",
    byStep: [
      {
        stepName: "fetchData",
        totalUsd: "0.809676",
        capturedUsd: "0.809676",
        authorizedUsd: "0",
        entryCount: 1,
        settleState: "final",
      },
      {
        stepName: "processResult",
        totalUsd: "27.820800",
        capturedUsd: "27.820800",
        authorizedUsd: "0",
        entryCount: 3,
        settleState: "final",
      },
    ],
  },
  subtree: {
    totalUsd: "28.630476",
  },
  totalUsd: "28.630476",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveCoreBaseUrl", () => {
  const AGENTS_VARS = ["SAPIOM_CORE_URL", "SAPIOM_AGENTS_URL", "SAPIOM_TOOLS_BASE"];
  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of AGENTS_VARS) saved[k] = process.env[k];
    for (const k of AGENTS_VARS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    try {
      fn();
    } finally {
      for (const k of AGENTS_VARS) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
  }

  it("defaults to api.sapiom.ai (prod core) when no overrides are set", () => {
    withEnv({}, () => expect(resolveCoreBaseUrl()).toBe("https://api.sapiom.ai"));
  });

  it("derives the core host from the agents host so both share an env (tools.<env> → api.<env>)", () => {
    withEnv({ SAPIOM_AGENTS_URL: "https://tools.sapiom.dev" }, () =>
      expect(resolveCoreBaseUrl()).toBe("https://api.sapiom.dev"),
    );
  });

  it("honours an explicit SAPIOM_CORE_URL override", () => {
    withEnv({ SAPIOM_CORE_URL: "https://api.example.com" }, () =>
      expect(resolveCoreBaseUrl()).toBe("https://api.example.com"),
    );
  });

  it("ignores SAPIOM_API_URL (which may point at a different env than the agents surface)", () => {
    const savedApi = process.env.SAPIOM_API_URL;
    process.env.SAPIOM_API_URL = "https://api.sapiom.dev";
    withEnv({}, () => expect(resolveCoreBaseUrl()).toBe("https://api.sapiom.ai"));
    if (savedApi !== undefined) process.env.SAPIOM_API_URL = savedApi;
    else delete process.env.SAPIOM_API_URL;
  });
});

describe("createRunSpendFetcher — no apiKey", () => {
  it("returns 503 without calling the network when apiKey is null", async () => {
    const mockFetch = vi.fn();
    const fetcher = createRunSpendFetcher({
      apiKey: null,
      fetchImpl: mockFetch,
    });
    const result = await fetcher.fetch("exec-001");
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "harness is not signed in to Sapiom",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("createRunSpendFetcher — success path", () => {
  it("maps ExecutionSpendDto to RunSpend correctly (totalUsd + byStep names/entryCount)", async () => {
    const mockFetch = makeFetch(200, RAW_SPEND_DOC);
    const fetcher = createRunSpendFetcher({
      apiKey: "sk-test-key",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec-001");

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing

    const { spend } = result;
    expect(spend.executionId).toBe("exec-001");
    expect(spend.totalUsd).toBe("28.630476");
    expect(spend.settleState).toBe("final");

    // byStep: two entries with correct name/totalUsd/entryCount
    expect(spend.byStep).toHaveLength(2);
    expect(spend.byStep[0]).toEqual({
      name: "fetchData",
      totalUsd: "0.809676",
      entryCount: 1,
    });
    expect(spend.byStep[1]).toEqual({
      name: "processResult",
      totalUsd: "27.820800",
      entryCount: 3,
    });
  });

  it("calls the correct URL with x-api-key header", async () => {
    const mockFetch = makeFetch(200, RAW_SPEND_DOC);
    const fetcher = createRunSpendFetcher({
      apiKey: "sk-my-key",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    await fetcher.fetch("exec-001");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.test/v1/workflows/executions/exec-001/spend",
      { headers: { "x-api-key": "sk-my-key" } },
    );
  });

  it("falls back to top-level totalUsd when capability is absent", async () => {
    // Minimal response with no capability sub-object
    const minimal = { totalUsd: "5.00" };
    const mockFetch = makeFetch(200, minimal);
    const fetcher = createRunSpendFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec-002");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spend.totalUsd).toBe("5.00");
    expect(result.spend.settleState).toBe("pending");
    expect(result.spend.byStep).toEqual([]);
  });
});

describe("createRunSpendFetcher — error paths", () => {
  it("returns 404 when the gateway responds 404", async () => {
    const mockFetch = makeFetch(404, { error: "not found" });
    const fetcher = createRunSpendFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec-missing");
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "spend not found",
    });
  });

  it("returns 502 when the gateway responds with a non-2xx non-404 status", async () => {
    const mockFetch = makeFetch(500, { error: "internal error" });
    const fetcher = createRunSpendFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec-001");
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
    const fetcher = createRunSpendFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec-001");
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway unreachable",
    });
  });

  it("returns 502 when the response body is malformed (json() throws)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    } as unknown as Response);

    const fetcher = createRunSpendFetcher({
      apiKey: "sk-test",
      baseUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    const result = await fetcher.fetch("exec-001");
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "could not decode spend",
    });
  });
});
