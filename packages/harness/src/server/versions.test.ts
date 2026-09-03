import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";

import {
  createVersionsRouter,
  orderVersions,
  isNewestReady,
  humanError,
  type AgentVersion,
} from "./versions.js";

const CORE = "http://core.test";

function version(over: Partial<AgentVersion> & { sha: string }): AgentVersion {
  return {
    subject: "",
    author: "",
    committedAt: "2026-01-01T00:00:00.000Z",
    buildStatus: "ready",
    deployedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    isActive: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Ordering: labelled releases first, then recent unlabelled
// ---------------------------------------------------------------------------

describe("orderVersions", () => {
  it("puts labelled releases above unlabelled ones", () => {
    const rows = [
      version({ sha: "new-untagged", deployedAt: "2026-03-01T00:00:00.000Z" }),
      version({
        sha: "old-tagged",
        tags: ["0.0.1"],
        deployedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual([
      "old-tagged",
      "new-untagged",
    ]);
  });

  it("orders within each group by recency", () => {
    const rows = [
      version({ sha: "t-old", tags: ["0.0.1"], deployedAt: "2026-01-01T00:00:00.000Z" }),
      version({ sha: "t-new", tags: ["0.0.2"], deployedAt: "2026-02-01T00:00:00.000Z" }),
      version({ sha: "u-old", deployedAt: "2026-01-15T00:00:00.000Z" }),
      version({ sha: "u-new", deployedAt: "2026-02-15T00:00:00.000Z" }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual([
      "t-new",
      "t-old",
      "u-new",
      "u-old",
    ]);
  });

  /**
   * `latest` outranks everything, even a labelled release — it is the row
   * people look for first, and it used to sink below an older tagged version
   * whenever the newest build carried no label of its own.
   */
  it("pins the `latest` row to the top, above a labelled release", () => {
    const rows = [
      version({ sha: "real-label", tags: ["0.0.1"], deployedAt: "2026-01-01T00:00:00.000Z" }),
      version({ sha: "only-latest", tags: ["latest"], deployedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual([
      "only-latest",
      "real-label",
    ]);
  });

  /** Even when `latest` is the OLDEST build — position beats recency here. */
  it("keeps `latest` on top even if it is not the most recent row", () => {
    const rows = [
      version({ sha: "newer-tagged", tags: ["0.0.9"], deployedAt: "2026-05-01T00:00:00.000Z" }),
      version({ sha: "older-latest", tags: ["latest"], deployedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual([
      "older-latest",
      "newer-tagged",
    ]);
  });

  /**
   * `latest` still does not make a build count as "labelled" for the second
   * group — otherwise the labelled/unlabelled split would be meaningless.
   */
  it("does not let `latest` promote unlabelled builds into the labelled group", () => {
    const rows = [
      version({ sha: "has-latest", tags: ["latest"], deployedAt: "2026-05-01T00:00:00.000Z" }),
      version({ sha: "plain-new", deployedAt: "2026-04-01T00:00:00.000Z" }),
      version({ sha: "tagged-old", tags: ["0.0.1"], deployedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual([
      "has-latest",
      "tagged-old",
      "plain-new",
    ]);
  });

  it("puts a version carrying latest AND a label first", () => {
    const rows = [
      version({ sha: "plain", deployedAt: "2026-04-01T00:00:00.000Z" }),
      version({ sha: "both", tags: ["latest", "0.0.2"], deployedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual(["both", "plain"]);
  });

  it("caps the list at the page size", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      version({ sha: `v${i}`, deployedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    expect(orderVersions(rows)).toHaveLength(10);
  });

  it("falls back to committedAt when a build was never deployed", () => {
    const rows = [
      version({ sha: "a", deployedAt: null, committedAt: "2026-05-01T00:00:00.000Z" }),
      version({ sha: "b", deployedAt: null, committedAt: "2026-04-01T00:00:00.000Z" }),
    ];
    expect(orderVersions(rows).map((v) => v.sha)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Confirm gating: pinning older has consequences, returning to newest does not
// ---------------------------------------------------------------------------

describe("isNewestReady", () => {
  const rows = [
    version({ sha: "newest", deployedAt: "2026-03-01T00:00:00.000Z" }),
    version({ sha: "older", deployedAt: "2026-01-01T00:00:00.000Z" }),
  ];

  it("is true for the newest ready build (activating it resumes latest)", () => {
    expect(isNewestReady(rows, "newest")).toBe(true);
  });

  it("is false for an older build (activating it pins, so confirm)", () => {
    expect(isNewestReady(rows, "older")).toBe(false);
  });

  /** A failed build is not a candidate, so the newest READY one still wins. */
  it("ignores builds that are not ready", () => {
    const withFailed = [
      version({ sha: "broken", buildStatus: "failed", deployedAt: "2026-04-01T00:00:00.000Z" }),
      ...rows,
    ];
    expect(isNewestReady(withFailed, "newest")).toBe(true);
    expect(isNewestReady(withFailed, "broken")).toBe(false);
  });

  it("is false when there are no ready builds at all", () => {
    expect(isNewestReady([version({ sha: "x", buildStatus: "building" })], "x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * A real express server on an ephemeral port, driven with `fetch` — the same
 * shape runs.test.ts uses, so these routes are exercised through express's
 * routing and body parsing rather than a stubbed request object.
 */
let server: Server | undefined;
let origin = "";

function start(fetchImpl: typeof fetch, apiKey: string | null = "sk-test"): void {
  const a = express();
  a.use(express.json());
  a.use(createVersionsRouter({ apiKey, baseUrl: CORE, fetchImpl }));
  server = a.listen(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (!server) return;
  const s = server;
  server = undefined;
  await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe("GET /api/versions/:definitionId", () => {
  it("returns ordered versions plus the active sha and pin state", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        version({ sha: "aaa", tags: ["latest", "0.0.2"], deployedAt: "2026-03-01T00:00:00.000Z" }),
        version({
          sha: "bbb",
          tags: ["0.0.1"],
          isActive: true,
          source: "pinned",
          deployedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    ) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.versions.map((v: AgentVersion) => v.sha)).toEqual(["aaa", "bbb"]);
    expect(body.activeSha).toBe("bbb");
    expect(body.pinned).toBe(true);
    expect(body.total).toBe(2);
  });

  it("reports pinned=false when the active version is just following latest", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([version({ sha: "aaa", tags: ["latest"], isActive: true })]),
    ) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45`);
    const body = await res.json();
    expect(body.pinned).toBe(false);
  });

  it("sends Core's header, not the gateway's", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    start(fetchImpl);
    await fetch(`${origin}/api/versions/45`);

    expect(seen[0]["x-api-key"]).toBe("sk-test");
    expect(seen[0]["x-sapiom-api-key"]).toBeUndefined();
  });

  it("503s when the harness is not signed in", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    start(fetchImpl, null);
    const res = await fetch(`${origin}/api/versions/45`);
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes Core's status through on failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "nope" }, 404),
    ) as unknown as typeof fetch;
    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45`);
    expect(res.status).toBe(404);
  });
});

describe("writes", () => {
  it("activates a version", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return jsonResponse({ buildRunId: "55" });
    }) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: "abc" }),
    });

    expect(res.status).toBe(200);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${CORE}/v1/workflows/definitions/45/versions/abc/activate`);
  });

  it("rejects an activate with no sha", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resumes following latest by deleting the pin", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45/pin`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`${CORE}/v1/workflows/definitions/45/version-pin`);
  });

  it("sets or moves a label onto a version", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45/labels/0.0.3`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: "abc" }),
    });

    expect(res.status).toBe(200);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(`${CORE}/v1/workflows/definitions/45/tags/0.0.3`);
    expect(JSON.parse(String(calls[0].body))).toEqual({ sha: "abc" });
  });

  /**
   * Core owns the rules — 1–64 chars, and `latest` is refused by a DB CHECK.
   * The router must relay that verdict rather than pre-judging names, so the
   * two layers can never disagree about what is legal.
   */
  it("relays Core's rejection of a reserved label", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "'latest' is reserved" }, 400),
    ) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45/labels/latest`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: "abc" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    // Relayed as `{error}` — the one error shape this router speaks, so the
    // panel's banner shows Core's sentence and not its envelope.
    expect(body.error).toContain("reserved");
  });

  it("removes a label", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/45/labels/0.0.3`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`${CORE}/v1/workflows/definitions/45/tags/0.0.3`);
  });
});

// ---------------------------------------------------------------------------
// Error normalisation: Core's sentence, not its envelope
// ---------------------------------------------------------------------------

describe("humanError", () => {
  /**
   * The exact body Core returned when the panel tried to set `latest` — the
   * useful sentence is in `message`, while `error` is the bare HTTP phrase.
   * Reading `error` first put "Bad Request" on screen; forwarding the whole
   * object put a request id there.
   */
  it("prefers Core's message over its HTTP phrase", () => {
    expect(
      humanError(
        {
          statusCode: 400,
          code: "bad_request",
          message:
            "'latest' is computed from the newest ready build and cannot be set.",
          error: "Bad Request",
          requestId: "0d543081-8184-4760-814f-1c319555918c",
        },
        400,
      ),
    ).toBe("'latest' is computed from the newest ready build and cannot be set.");
  });

  it("joins Nest's validation array", () => {
    expect(humanError({ message: ["sha must be a string", "sha is required"] }, 400)).toBe(
      "sha must be a string; sha is required",
    );
  });

  it("falls back to `error` when there is no message", () => {
    expect(humanError({ error: "not signed in to Sapiom" }, 503)).toBe(
      "not signed in to Sapiom",
    );
  });

  it("passes a plain-text body through", () => {
    expect(humanError("upstream exploded", 502)).toBe("upstream exploded");
  });

  it("names the status when the body says nothing usable", () => {
    expect(humanError({}, 404)).toBe("request failed (404)");
    expect(humanError(null, 500)).toBe("request failed (500)");
    expect(humanError({ message: "   " }, 400)).toBe("request failed (400)");
  });
});

describe("error bodies reaching the browser", () => {
  /**
   * End to end through express: what the panel's error banner actually shows.
   * The client reads `{error}` and nothing else, so a route that forwards
   * Core's envelope leaves a JSON blob on screen.
   */
  it("forwards Core's sentence as {error} from a label write", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          statusCode: 400,
          message:
            "'latest' is computed from the newest ready build and cannot be set.",
          error: "Bad Request",
          requestId: "abc",
        },
        400,
      ),
    ) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/46/labels/latest`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: "aaa" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      error: "'latest' is computed from the newest ready build and cannot be set.",
    });
    // No envelope leftovers on screen.
    expect(body.requestId).toBeUndefined();
    expect(body.statusCode).toBeUndefined();
  });

  it("normalises an activate failure the same way", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "build is not ready", error: "Conflict" }, 409),
    ) as unknown as typeof fetch;

    start(fetchImpl);
    const res = await fetch(`${origin}/api/versions/46/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: "aaa" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "build is not ready" });
  });

  it("leaves a successful body untouched", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([version({ sha: "aaa", tags: ["latest"], isActive: true })]),
    ) as unknown as typeof fetch;

    start(fetchImpl);
    const body = await (await fetch(`${origin}/api/versions/45`)).json();
    expect(body.versions[0].sha).toBe("aaa");
  });
});
