import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as memory from "./index.js";
import { MemoryHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly with a real Transport wired to a
// scripted fetch mock (so URL/method/header/body assertions are exact, and we
// verify the Transport itself injects the tenant credential).
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeTransport(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
  apiKey: string | undefined = "test-key",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = await handler({ url, init });
      if (response) return response;
    }
    throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const BASE = "https://api.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

// ---------------------------------------------------------------------------
// Public contract constants
// ---------------------------------------------------------------------------

describe("memory — public contract constants", () => {
  it("exports the current backend allowlist", () => {
    expect(memory.MEMORY_BACKENDS).toEqual([
      "neon-pgvector",
      "upstash-vector",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Base URL resolution (resolveServiceUrl at module load)
// ---------------------------------------------------------------------------

describe("memory — base URL resolution", () => {
  it("defaults to the production memory service origin when nothing overrides it", async () => {
    // DEFAULT_BASE_URL is captured at module load from process.env; with no
    // SAPIOM_MEMORY_URL / SAPIOM_SERVICES_BASE set in this test run it must be
    // the production origin, and the /v1/memory path prefix is appended per-method.
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-1",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    // Call WITHOUT the baseUrl arg so the module-level default is exercised.
    await memory.append({ content: "c" }, transport);
    expect(calls[0]!.url).toBe(
      "https://memory.services.sapiom.ai/v1/memory/append",
    );
  });

  it("honors an explicit per-call baseUrl override verbatim (path prefix appended)", async () => {
    // An SAPIOM_MEMORY_URL override wins verbatim, but it is read at module load;
    // the per-call baseUrl arg is the same bare-origin knob threaded per request,
    // so we exercise the override shape through it.
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-1",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    await memory.append(
      { content: "c" },
      transport,
      "http://memory.services.localhost:3100",
    );
    expect(calls[0]!.url).toBe(
      "http://memory.services.localhost:3100/v1/memory/append",
    );
  });
});

// ---------------------------------------------------------------------------
// append()
// ---------------------------------------------------------------------------

describe("memory.append()", () => {
  it("POSTs /append with JSON body + credential and returns the camelCase payload as-is", async () => {
    const raw = {
      id: "m-123",
      content: "User prefers dark mode.",
      scope: "user",
      decision: "ADDED",
      createdAt: "2026-06-22T12:00:00Z",
      occurredAt: null,
      metadata: { source: "survey" },
    };
    const { transport, calls } = makeTransport([
      () => jsonResponse(raw, { status: 201 }),
    ]);

    const result = await memory.append(
      {
        content: "User prefers dark mode.",
        scope: "user",
        metadata: { source: "survey" },
      },
      transport,
      BASE,
    );

    expect(result).toEqual(raw);
    expect(result.decision).toBe("ADDED");
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/append`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content: "User prefers dark mode.",
      scope: "user",
      metadata: { source: "survey" },
    });
    // store omitted from the body when not supplied → gateway falls back to its
    // neon-pgvector default store.
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty(
      "store",
    );
  });

  it("includes occurredAt in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-1",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: "2026-05-01T00:00:00Z",
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    const result = await memory.append(
      { content: "c", occurredAt: "2026-05-01T00:00:00Z" },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content: "c",
      occurredAt: "2026-05-01T00:00:00Z",
    });
    // occurredAt echoed back on the result.
    expect(result.occurredAt).toBe("2026-05-01T00:00:00Z");
  });

  it("forwards the store selector (backend) in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-1",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    const store: memory.MemoryStore = { backend: "upstash-vector" };
    await memory.append({ content: "c", store }, transport, BASE);

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content: "c",
      store: { backend: "upstash-vector" },
    });
  });

  it("forwards the full store selector (namespace + embedder) verbatim in the body", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-1",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    const store: memory.MemoryStore = {
      namespace: "tenant-7",
      embedder: {
        provider: "openrouter",
        model: "openai/text-embedding-3-large",
      },
    };
    await memory.append({ content: "c", store }, transport, BASE);

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content: "c",
      store: {
        namespace: "tenant-7",
        embedder: {
          provider: "openrouter",
          model: "openai/text-embedding-3-large",
        },
      },
    });
  });

  it("surfaces a NOOP decision echoing the existing memory (nothing written)", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-existing",
            content: "User prefers dark mode.",
            scope: "user",
            decision: "NOOP",
            createdAt: "2026-06-01T00:00:00Z",
            occurredAt: null,
            metadata: { source: "survey" },
          },
          // NOOP may come back as 200 or 201; either is a success and parses the same.
          { status: 200 },
        ),
    ]);

    const result = await memory.append(
      { content: "User prefers dark mode.", scope: "user" },
      transport,
      BASE,
    );
    expect(result.decision).toBe("NOOP");
    expect(result.id).toBe("m-existing"); // the existing memory's id, echoed
  });

  it("returns NOOP on byte-identical content (no idempotency key sent)", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-existing",
            content: "c",
            scope: "default",
            decision: "NOOP",
            createdAt: "2026-06-01T00:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 200 },
        ),
    ]);

    // NOOP is decided purely on byte-identical content (or a near-exact semantic
    // duplicate) in the same owner + scope — there is no idempotency key on the wire.
    const result = await memory.append({ content: "c" }, transport, BASE);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ content: "c" });
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty(
      "idempotencyKey",
    );
    expect(result.decision).toBe("NOOP");
    expect(result.id).toBe("m-existing");
  });

  it("omits optional fields from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-1",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    await memory.append({ content: "c" }, transport, BASE);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ content: "c" });
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("idempotencyKey");
    expect(body).not.toHaveProperty("occurredAt");
    expect(body).not.toHaveProperty("store");
  });

  it("throws MemoryHttpError carrying the REJECTED body on a 400 SecretDetected", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({
            statusCode: 400,
            error: "SecretDetected",
            decision: "REJECTED",
            message: "Potential secret detected in content or metadata.",
          }),
          { status: 400 },
        ),
    ]);

    // REJECTED is not a success decision — it rides back on the 400 error body, so
    // it must surface via MemoryHttpError.body, never as an AppendResult.decision.
    await expect(
      memory.append({ content: "sk-live-abc" }, transport, BASE),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "SecretDetected", decision: "REJECTED" },
    });
  });

  it("throws MemoryHttpError on a 507 (store full)", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({ statusCode: 507, message: "Memory store full." }),
          { status: 507 },
        ),
    ]);

    await expect(
      memory.append({ content: "c" }, transport, BASE),
    ).rejects.toMatchObject({ status: 507 });
    await expect(
      memory.append({ content: "c" }, transport, BASE),
    ).rejects.toBeInstanceOf(MemoryHttpError);
  });
});

// ---------------------------------------------------------------------------
// recall()
// ---------------------------------------------------------------------------

describe("memory.recall()", () => {
  const match = {
    id: "m-1",
    content: "The project deadline is end of Q3.",
    scope: "project",
    // Provider returns a single canonical [0,1] `score` plus an optional
    // backend-specific `scoreBreakdown` map (some backends fill component scores;
    // opaque/dense-only paths omit it).
    score: 0.71,
    scoreBreakdown: { vector: 0.82, text: 0.4, combined: 0.71 },
    createdAt: "2026-06-01T00:00:00Z",
    occurredAt: "2026-05-15T00:00:00Z",
    lastAccessedAt: "2026-06-20T00:00:00Z",
    metadata: {},
  };

  it("POSTs /recall with the query and returns results + echoed fields", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          results: [match],
          query: "deadline",
          topK: 10,
          count: 1,
        }),
    ]);

    const result = await memory.recall({ query: "deadline" }, transport, BASE);

    expect(result.count).toBe(1);
    expect(result.topK).toBe(10);
    expect(result.query).toBe("deadline");
    expect(result.results[0]).toEqual(match);
    // The match maps the score shape 1:1 — canonical `score` + optional
    // `scoreBreakdown`, plus occurredAt / lastAccessedAt passthrough.
    expect(result.results[0]!.score).toBe(0.71);
    expect(result.results[0]!.scoreBreakdown).toEqual({
      vector: 0.82,
      text: 0.4,
      combined: 0.71,
    });
    expect(result.results[0]!.occurredAt).toBe("2026-05-15T00:00:00Z");
    expect(result.results[0]!.lastAccessedAt).toBe("2026-06-20T00:00:00Z");
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/recall`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "deadline",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty(
      "store",
    );
  });

  it("surfaces a match with null occurredAt/lastAccessedAt and no scoreBreakdown (opaque backend)", async () => {
    const opaqueMatch = {
      id: "m-opaque",
      content: "Opaque-backend match.",
      scope: "default",
      score: 0.66,
      createdAt: "2026-06-01T00:00:00Z",
      occurredAt: null,
      lastAccessedAt: null,
      metadata: {},
    };
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          results: [opaqueMatch],
          query: "q",
          topK: 10,
          count: 1,
        }),
    ]);

    const result = await memory.recall({ query: "q" }, transport, BASE);
    expect(result.results[0]).toEqual(opaqueMatch);
    expect(result.results[0]!.score).toBe(0.66);
    expect(result.results[0]!.scoreBreakdown).toBeUndefined();
    expect(result.results[0]!.occurredAt).toBeNull();
    expect(result.results[0]!.lastAccessedAt).toBeNull();
  });

  it("includes scope, topK, minSimilarity, and strategy in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 5, count: 0 }),
    ]);

    await memory.recall(
      {
        query: "q",
        scope: "project",
        topK: 5,
        minSimilarity: 0.5,
        strategy: "keyword",
      },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      scope: "project",
      topK: 5,
      minSimilarity: 0.5,
      strategy: "keyword",
    });
  });

  it("includes weight and filter in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 5, count: 0 }),
    ]);

    await memory.recall(
      {
        query: "q",
        weight: {
          temporal: { center: "2026-06-01T00:00:00Z", halfLifeDays: 14 },
        },
        filter: { source: "survey" },
      },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      weight: {
        temporal: { center: "2026-06-01T00:00:00Z", halfLifeDays: 14 },
      },
      filter: { source: "survey" },
    });
  });

  it("forwards the store selector (backend) in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 10, count: 0 }),
    ]);

    await memory.recall(
      { query: "q", store: { backend: "upstash-vector" } },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      store: { backend: "upstash-vector" },
    });
  });

  it("forwards the full store selector (namespace + embedder) verbatim in the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 10, count: 0 }),
    ]);

    await memory.recall(
      {
        query: "q",
        store: {
          namespace: "tenant-7",
          embedder: {
            provider: "openrouter",
            model: "openai/text-embedding-3-large",
          },
        },
      },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      store: {
        namespace: "tenant-7",
        embedder: {
          provider: "openrouter",
          model: "openai/text-embedding-3-large",
        },
      },
    });
  });

  it("omits optional fields from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 5, count: 0 }),
    ]);

    await memory.recall({ query: "q" }, transport, BASE);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ query: "q" });
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("topK");
    expect(body).not.toHaveProperty("minSimilarity");
    expect(body).not.toHaveProperty("strategy");
    expect(body).not.toHaveProperty("weight");
    expect(body).not.toHaveProperty("filter");
    expect(body).not.toHaveProperty("store");
  });

  it("returns an empty result set without error", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 10, count: 0 }),
    ]);

    const result = await memory.recall({ query: "q" }, transport, BASE);
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("throws MemoryHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("server error", { status: 503 }),
    ]);

    await expect(
      memory.recall({ query: "q" }, transport, BASE),
    ).rejects.toMatchObject({ status: 503 });
  });
});

// ---------------------------------------------------------------------------
// sweep()
// ---------------------------------------------------------------------------

describe("memory.sweep()", () => {
  it("POSTs /sweep with an empty body by default (dryRun omitted, server defaults it true)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ evicted: 0, candidates: [] }),
    ]);

    const result = await memory.sweep(undefined, transport, BASE);

    expect(result.evicted).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/sweep`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    // dryRun now defaults to true SERVER-side; the client only sends it when the
    // caller provides it, so an unspecified sweep sends no dryRun at all.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty("dryRun");
  });

  it("includes count, strategy, and the store selector in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ evicted: 2 }),
    ]);

    await memory.sweep(
      {
        count: 2,
        strategy: "oldest",
        store: {
          backend: "upstash-vector",
          namespace: "tenant-7",
          embedder: {
            provider: "openrouter",
            model: "openai/text-embedding-3-large",
          },
        },
      },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      count: 2,
      strategy: "oldest",
      store: {
        backend: "upstash-vector",
        namespace: "tenant-7",
        embedder: {
          provider: "openrouter",
          model: "openai/text-embedding-3-large",
        },
      },
    });
  });

  it("returns the candidates a dryRun would evict (evicted: 0)", async () => {
    const candidate = {
      id: "m-old",
      content: "stale note",
      scope: "default",
      createdAt: "2026-01-01T00:00:00Z",
      lastAccessedAt: null,
    };
    const { transport, calls } = makeTransport([
      () => jsonResponse({ evicted: 0, candidates: [candidate] }),
    ]);

    // dryRun:true is the server default, but when the caller passes it explicitly
    // the client forwards it in the body.
    const result = await memory.sweep({ dryRun: true }, transport, BASE);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ dryRun: true });
    expect(result.evicted).toBe(0);
    expect(result.candidates).toEqual([candidate]);
    expect(result.candidates![0]!.lastAccessedAt).toBeNull();
  });

  it("sends dryRun:false in the body when the caller opts into a real eviction", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ evicted: 4 }),
    ]);

    const result = await memory.sweep({ dryRun: false }, transport, BASE);
    // Only sent because the caller provided it; the client never injects a default.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      dryRun: false,
    });
    expect(result.evicted).toBe(4);
  });

  it("throws MemoryHttpError on non-2xx", async () => {
    const { transport } = makeTransport([
      () => new Response("server error", { status: 500 }),
    ]);

    await expect(memory.sweep({}, transport, BASE)).rejects.toMatchObject({
      status: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("memory.get()", () => {
  const record = {
    id: "m-1",
    content: "c",
    scope: "default",
    createdAt: "2026-06-01T00:00:00Z",
    occurredAt: "2026-05-15T00:00:00Z",
    lastAccessedAt: "2026-06-20T00:00:00Z",
    metadata: {},
  };

  it("GETs /:id and returns the record", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    const result = await memory.get("m-1", transport, BASE);

    expect(result).toEqual(record);
    expect(result.occurredAt).toBe("2026-05-15T00:00:00Z");
    expect(result.lastAccessedAt).toBe("2026-06-20T00:00:00Z");
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-1`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("returns a record with null occurredAt/lastAccessedAt", async () => {
    const bare = {
      id: "m-2",
      content: "c",
      scope: "default",
      createdAt: "2026-06-01T00:00:00Z",
      occurredAt: null,
      lastAccessedAt: null,
      metadata: {},
    };
    const { transport } = makeTransport([() => jsonResponse(bare)]);

    const result = await memory.get("m-2", transport, BASE);
    expect(result).toEqual(bare);
    expect(result.occurredAt).toBeNull();
    expect(result.lastAccessedAt).toBeNull();
  });

  it("appends the flat storeBackend query param when the option is provided", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    await memory.get("m-1", transport, BASE, {
      store: { backend: "upstash-vector" },
    });
    const expected = new URLSearchParams();
    expected.set("storeBackend", "upstash-vector");
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-1?${expected.toString()}`);
  });

  it("omits the store query params when the option is absent", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    await memory.get("m-1", transport, BASE, {});
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-1`);
    expect(calls[0]!.url).not.toContain("store");
  });

  it("appends flat store query params (namespace + embedder)", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    await memory.get("m-1", transport, BASE, {
      store: {
        namespace: "tenant-7",
        embedder: {
          provider: "openrouter",
          model: "openai/text-embedding-3-large",
        },
      },
    });
    const query = new URLSearchParams(calls[0]!.url.split("?")[1]);
    expect(query.get("storeNamespace")).toBe("tenant-7");
    expect(query.get("storeEmbedderProvider")).toBe("openrouter");
    expect(query.get("storeEmbedderModel")).toBe(
      "openai/text-embedding-3-large",
    );
  });

  it("omits the flat store query params when the store option is absent", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    await memory.get("m-1", transport, BASE, {});
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-1`);
    expect(calls[0]!.url).not.toContain("store");
  });

  it("encodes special characters in the id", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    await memory.get("id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/id%2Fwith%20slash`);
  });

  it("throws MemoryHttpError on 404", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(memory.get("bad-id", transport, BASE)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// forget()
// ---------------------------------------------------------------------------

describe("memory.forget()", () => {
  it("DELETEs /:id and resolves void on 204", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    const result = await memory.forget("m-abc", transport, BASE);
    expect(result).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-abc`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("appends the flat storeBackend query param when the option is provided", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await memory.forget("m-abc", transport, BASE, {
      store: { backend: "upstash-vector" },
    });
    const expected = new URLSearchParams();
    expected.set("storeBackend", "upstash-vector");
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/memory/m-abc?${expected.toString()}`,
    );
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("omits the store query params when the option is absent", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await memory.forget("m-abc", transport, BASE, {});
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-abc`);
    expect(calls[0]!.url).not.toContain("store");
  });

  it("appends flat store query params (namespace + embedder)", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await memory.forget("m-abc", transport, BASE, {
      store: {
        namespace: "tenant-7",
        embedder: {
          provider: "openrouter",
          model: "openai/text-embedding-3-large",
        },
      },
    });
    const query = new URLSearchParams(calls[0]!.url.split("?")[1]);
    expect(query.get("storeNamespace")).toBe("tenant-7");
    expect(query.get("storeEmbedderProvider")).toBe("openrouter");
    expect(query.get("storeEmbedderModel")).toBe(
      "openai/text-embedding-3-large",
    );
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("omits the flat store query params when the store option is absent", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await memory.forget("m-abc", transport, BASE, {});
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-abc`);
    expect(calls[0]!.url).not.toContain("store");
  });

  it("encodes special characters in the id", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await memory.forget("id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/id%2Fwith%20slash`);
  });

  it("is idempotent: a second forget of an already-gone id resolves (204, no throw)", async () => {
    // forget is a hard DELETE but idempotent: the gateway always returns
    // 204 No Content, whether or not the id existed. Deleting an already-gone
    // (or never-existed / other-owner) id is success — NOT a 404. Mirror the
    // gateway by returning 204 on every call.
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 }),
    ]);

    await expect(
      memory.forget("m-abc", transport, BASE),
    ).resolves.toBeUndefined();
    // Second forget of the now-gone id still succeeds (idempotent).
    await expect(
      memory.forget("m-abc", transport, BASE),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.init.method === "DELETE")).toBe(true);
  });

  it("surfaces a real transport error as MemoryHttpError with status + parsed JSON body", async () => {
    // Idempotency only covers gone-already ids (→ 204). Genuine failures must
    // still throw, exercising forget()'s inline error parser (not ensureOk).
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "boom", code: "internal" }), {
          status: 500,
        }),
    ]);

    await expect(
      memory.forget("bad-id", transport, BASE),
    ).rejects.toMatchObject({
      status: 500,
      body: { message: "boom", code: "internal" },
    });
  });

  it("surfaces a real transport error as MemoryHttpError (non-JSON body)", async () => {
    const { transport } = makeTransport([
      () => new Response("upstream boom", { status: 500 }),
    ]);

    await expect(
      memory.forget("bad-id", transport, BASE),
    ).rejects.toMatchObject({ status: 500, body: "upstream boom" });
    await expect(
      memory.forget("bad-id", transport, BASE),
    ).rejects.toBeInstanceOf(MemoryHttpError);
  });
});

// ---------------------------------------------------------------------------
// Client wiring + auth
// ---------------------------------------------------------------------------

describe("memory — client wiring + credential", () => {
  it("createClient().memory routes all five methods with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/recall"))
        return jsonResponse({ results: [], query: "q", topK: 10, count: 0 });
      if (url.endsWith("/sweep")) return jsonResponse({ evicted: 0 });
      if (url.endsWith("/append"))
        return jsonResponse(
          {
            id: "m",
            content: "c",
            scope: "default",
            decision: "ADDED",
            createdAt: "2026-06-22T12:00:00Z",
            occurredAt: null,
            metadata: {},
          },
          { status: 201 },
        );
      // GET /:id
      return jsonResponse({
        id: "m",
        content: "c",
        scope: "default",
        createdAt: "2026-06-22T12:00:00Z",
        occurredAt: null,
        lastAccessedAt: null,
        metadata: {},
      });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.memory.append({ content: "c" });
    await sapiom.memory.recall({ query: "q" });
    await sapiom.memory.sweep();
    await sapiom.memory.get("m", { store: { namespace: "tenant-7" } });
    await sapiom.memory.forget("m", { store: { namespace: "tenant-7" } });

    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
    const expected = new URLSearchParams();
    expected.set("storeNamespace", "tenant-7");
    expect(calls[3]!.url).toBe(
      `https://memory.services.sapiom.ai/v1/memory/m?${expected.toString()}`,
    );
    expect(calls[4]!.url).toBe(
      `https://memory.services.sapiom.ai/v1/memory/m?${expected.toString()}`,
    );
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
      });
      await expect(
        memory.recall({ query: "q" }, transport, BASE),
      ).rejects.toThrow(/no tenant credential/i);
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// MemoryHttpError
// ---------------------------------------------------------------------------

describe("MemoryHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new MemoryHttpError("something went wrong", 422, {
      code: "authorization_denied",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ code: "authorization_denied" });
    expect(err.name).toBe("MemoryHttpError");
  });
});
