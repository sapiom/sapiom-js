import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRunsRouter } from "./runs.js";
import type { ApiKeyProvider } from "../core/api-key-provider.js";

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

/** One mock Response for a given status/body. */
function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response;
}

/** A fetch that returns each queued Response in order (last one repeats). */
function makeSequencedFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve(res);
  });
}

/** A provider whose refresh() swaps to `refreshedKey` exactly once. */
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
 * A realistic raw execution projection with one succeeded step (real prod
 * engine vocabulary) and one failed step.
 */
const VALID_EXECUTION_DOC = {
  id: "exec_invoice_002",
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
      status: "succeeded",
      spanId: "span_validate",
      startedAt: "2026-07-01T10:00:00.000Z",
      finishedAt: "2026-07-01T10:00:10.000Z",
      logs: [],
      error: null,
    },
  ],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createRunsRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;

  function start(opts: Parameters<typeof createRunsRouter>[0]) {
    const app = express();
    // The boot-token middleware is not mounted here — we test the router in
    // isolation (pure routing behaviour), same pattern as rest.test.ts.
    app.use(express.json());
    app.use(createRunsRouter(opts));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("GET /api/runs/:executionId/state — 200 path", () => {
    it("returns 200 with a RunView when the upstream returns a valid execution", async () => {
      start({
        apiKey: "sk-test-key",
        baseUrl: "https://agents.test",
        fetchImpl: makeFetch(200, VALID_EXECUTION_DOC),
      });

      const res = await fetch(`${baseUrl}/api/runs/exec_invoice_002/state`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.executionId).toBe("exec_invoice_002");
      expect(body.status).toBe("completed");
      const steps = body.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe("validateInput");
      // "succeeded" folds to "passed" — the key real-vocab fix
      expect(steps[0].status).toBe("passed");
    });
  });

  describe("GET /api/runs/:executionId/state — 404 path", () => {
    it("forwards 404 when the upstream says the execution does not exist", async () => {
      start({
        apiKey: "sk-test-key",
        baseUrl: "https://agents.test",
        fetchImpl: makeFetch(404, { error: "not found" }),
      });

      const res = await fetch(`${baseUrl}/api/runs/exec_missing/state`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("execution not found");
    });
  });

  describe("GET /api/runs/:executionId/state — 503 (no credentials)", () => {
    it("returns 503 when the harness has no API key (apiKey: null)", async () => {
      // fetchImpl is not expected to be called — pass a spy to verify that.
      const spy = vi.fn();
      start({ apiKey: null, fetchImpl: spy });

      const res = await fetch(`${baseUrl}/api/runs/exec_invoice_002/state`);
      expect(res.status).toBe(503);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("harness is not signed in to Sapiom");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/runs/:executionId/state — refresh-on-401 via provider", () => {
    it("recovers a 401 by refreshing the API key and retrying, returning 200", async () => {
      // A provider (not a static key) is what the real server passes; a 401 on
      // the first upstream call refreshes to a newer key and the retry succeeds.
      const fetchImpl = makeSequencedFetch([
        response(401, { error: "unauthorized" }),
        response(200, VALID_EXECUTION_DOC),
      ]);
      const provider = refreshingProvider("sk-stale", "sk-fresh");
      start({
        apiKey: provider,
        baseUrl: "https://agents.test",
        fetchImpl,
      });

      const res = await fetch(`${baseUrl}/api/runs/exec_invoice_002/state`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.executionId).toBe("exec_invoice_002");
      expect(provider.refreshCalls).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("authenticates upstream with the provider's held API key (identity.apiKey), not the boot token", async () => {
      const fetchImpl = makeFetch(200, VALID_EXECUTION_DOC);
      const provider = refreshingProvider("sk-held-key", "sk-unused");
      start({
        apiKey: provider,
        baseUrl: "https://agents.test",
        fetchImpl,
      });

      await fetch(`${baseUrl}/api/runs/exec_invoice_002/state`);

      // The upstream call carried the held sk_ key in the API-key header — never
      // the local boot token (which only gates the harness's own /api surface).
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://agents.test/agents/v1/executions/exec_invoice_002",
        { headers: { "x-sapiom-api-key": "sk-held-key" } },
      );
      expect(provider.refreshCalls).toBe(0);
    });
  });
});
