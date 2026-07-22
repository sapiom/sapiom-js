import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpStatusRouter } from "./op-status.js";

// ---------------------------------------------------------------------------
// Fixtures + a URL-routed fetch mock (same shape the core test uses).
// ---------------------------------------------------------------------------

const RAW_METRICS = {
  definitionId: "188",
  runCount: 42,
  failedCount: 5,
  successRate: 0.88,
  health: { verdict: "degraded", signals: [] },
};
const RAW_TRIGGERS = [
  { id: "t1", status: "active", nextFireAt: "2026-07-23T06:00:00.000Z" },
];
const RAW_DETAIL = { id: "188", slug: "enrich-lead", activeBuildRunStatus: "ready" };
const RAW_ALERTS = {
  data: [{ id: "a1", severity: "error", status: "open" }],
  meta: { page: { limit: 100 } },
};

function routedFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/metrics")
      ? RAW_METRICS
      : url.includes("/triggers")
        ? RAW_TRIGGERS
        : url.includes("/alerts")
          ? RAW_ALERTS
          : url.includes("/definitions/")
            ? RAW_DETAIL
            : { error: "not found" };
    return {
      status: 200,
      ok: true,
      json: () => Promise.resolve(body),
    } as Response;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Router tests — the router is exercised in isolation (pure routing), the same
// pattern runs.test.ts uses.
// ---------------------------------------------------------------------------

describe("createOpStatusRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;

  function start(opts: Parameters<typeof createOpStatusRouter>[0]) {
    const app = express();
    app.use(express.json());
    app.use(createOpStatusRouter(opts));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("GET /api/agents/:definitionId/op-status — 200 path", () => {
    it("returns the stitched OperationalStatus for a definition id + slug", async () => {
      start({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        fetchImpl: routedFetch(),
      });

      const res = await fetch(
        `${baseUrl}/api/agents/188/op-status?slug=enrich-lead`,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.definitionId).toBe("188");
      expect(body.slug).toBe("enrich-lead");
      expect(body.runCount).toBe(42);
      expect(body.failedCount).toBe(5);
      expect(body.scheduled).toBe(true);
      expect(body.nextFireAt).toBe("2026-07-23T06:00:00.000Z");
      expect(body.deployStatus).toBe("ready");
      expect(body.openAlerts).toBe(1);
      expect(body.highestAlertSeverity).toBe("error");
    });

    it("resolves the slug from detail when the ?slug= query is omitted", async () => {
      start({
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        fetchImpl: routedFetch(),
      });

      const res = await fetch(`${baseUrl}/api/agents/188/op-status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.slug).toBe("enrich-lead");
      expect(body.scheduled).toBe(true);
    });
  });

  describe("GET /api/agents/:definitionId/op-status — 503 (no credentials)", () => {
    it("returns 503 without touching the network when apiKey is null", async () => {
      const spy = vi.fn();
      start({ apiKey: null, fetchImpl: spy });

      const res = await fetch(`${baseUrl}/api/agents/188/op-status`);
      expect(res.status).toBe(503);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("harness is not signed in to Sapiom");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
