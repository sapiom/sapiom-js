import { Transport } from "../_client/index.js";
import * as searchindex from "./index.js";
import { SearchIndexContractError, SearchIndexHttpError } from "./index.js";
import type { SearchDocument, SearchIndex } from "./index.js";

/**
 * Wire-contract fixtures rather than invented empty mocks:
 *
 * - Gateway index/list values follow `SearchDatabaseResponse` and
 *   `SearchService.list()` in
 *   `sapiom/Sapiom@4ba50cd31f7ec36d141f28174a22e211ddc19bd4`.
 * - Provider query/range/fetch values follow the raw REST envelopes consumed by
 *   Upstash's official `search-js` client. The range value also matches the live
 *   response captured while provisioning the Assistant corpus on 2026-08-03.
 */
const gatewayIndexFixture = {
  id: "res_abc123",
  type: "search",
  name: "docs-corpus",
  status: "active",
  url: "https://res_abc123.search.data.test",
  region: "us-central1",
  expiresAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
} as const;

const gatewayListFixture = {
  databases: [{ ...gatewayIndexFixture, region: null }],
} as const;

const providerQueryFixture = {
  result: [
    {
      id: "getting-started",
      content: { title: "Get Started" },
      metadata: { url: "https://docs.example.com/" },
      score: 0.92,
    },
  ],
} as const;

const providerRangeFixture = {
  result: {
    nextCursor: "42",
    vectors: [
      { id: "a", metadata: { contentHash: "h1" } },
      { id: "b", content: { title: "Second" } },
    ],
  },
} as const;

const providerFetchFixture = {
  result: [{ id: "a", metadata: { contentHash: "h1" } }, null],
} as const;

// Capability fns are tested directly with a real Transport plus a scripted fetch
// mock, so URL/method/header/body assertions are exact and we verify the Transport
// injects the tenant credential on the gateway-direct default header
// (x-sapiom-api-key) for BOTH planes — control (management gateway) and data
// (the index's own URL).

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

const BASE = "https://upstash.test";
const DATA_URL = "https://res_abc123.search.data.test";
const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];
const bodyOf = (c: FetchCall) => JSON.parse(c.init.body as string);

const indexDto = (overrides: Record<string, unknown> = {}) => ({
  ...gatewayIndexFixture,
  ...overrides,
});

/** Build a bound handle by round-tripping `create` against a mocked gateway. */
async function makeHandle(
  handlers: Array<
    (call: FetchCall) => Response | Promise<Response> | null | undefined
  >,
): Promise<{ idx: SearchIndex; calls: FetchCall[] }> {
  const { transport, calls } = makeTransport([
    (c) =>
      c.url === `${BASE}/v1/search/indexes` && c.init.method === "POST"
        ? jsonResponse(indexDto(), { status: 201 })
        : undefined,
    ...handlers,
  ]);
  const idx = await searchindex.create(
    { name: "docs-corpus" },
    transport,
    BASE,
  );
  calls.length = 0; // drop the create call; tests assert data-plane calls only
  return { idx, calls };
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

describe("searchindex.create()", () => {
  it("POSTs /v1/search/indexes on x-sapiom-api-key and returns a bound handle", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto(), { status: 201 }),
    ]);

    const idx = await searchindex.create(
      { name: "docs-corpus", region: "us-central1", ttl: "7d" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes`);
    expect(calls[0]!.init.method).toBe("POST");
    // Gateway-direct surface — credential rides the default x-sapiom-api-key.
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({
      name: "docs-corpus",
      region: "us-central1",
      ttl: "7d",
    });

    expect(idx.id).toBe("res_abc123");
    expect(idx.name).toBe("docs-corpus");
    expect(idx.status).toBe("active");
    expect(idx.url).toBe(DATA_URL);
    expect(idx.expiresAt).toBeNull();
    expect(typeof idx.upsert).toBe("function");
    expect(typeof idx.query).toBe("function");
    expect(typeof idx.range).toBe("function");
    expect(typeof idx.fetchDocuments).toBe("function");
    expect(typeof idx.deleteDocuments).toBe("function");
  });

  it("omits region/ttl from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto(), { status: 201 }),
    ]);
    await searchindex.create({ name: "docs-corpus" }, transport, BASE);
    expect(bodyOf(calls[0]!)).toEqual({ name: "docs-corpus" });
  });

  it("throws before fetching on a missing name", async () => {
    const { transport, calls } = makeTransport([]);
    await expect(
      searchindex.create({ name: "" }, transport, BASE),
    ).rejects.toBeInstanceOf(SearchIndexHttpError);
    expect(calls).toHaveLength(0);
  });

  it("throws before fetching on a malformed ttl", async () => {
    const { transport, calls } = makeTransport([]);
    await expect(
      searchindex.create({ name: "x", ttl: "1 week" }, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("rejects a ttl over 30 days before fetching", async () => {
    const { transport, calls } = makeTransport([]);
    await expect(
      searchindex.create({ name: "x", ttl: "31d" }, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("throws a contract error when a successful create body is malformed", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ id: "res_bad" }),
    ]);
    await expect(
      searchindex.create({ name: "docs-corpus" }, transport, BASE),
    ).rejects.toBeInstanceOf(SearchIndexContractError);
  });

  it("throws SearchIndexHttpError with status + body on a non-2xx (e.g. 422 limit)", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({
            error: "resource_limit_exceeded",
            message: "Maximum 50 Search databases per account",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
    ]);
    await expect(
      searchindex.create({ name: "docs-corpus" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "SearchIndexHttpError",
      status: 422,
      body: { error: "resource_limit_exceeded" },
    });
  });
});

describe("searchindex.get() / list() / update() / delete()", () => {
  it("GETs /v1/search/indexes/:id (URL-encoded) and binds the handle", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto()),
    ]);
    const idx = await searchindex.get("res_abc123", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes/res_abc123`);
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(idx.url).toBe(DATA_URL);
    expect(typeof idx.range).toBe("function");
  });

  it("parses the canonical { databases } fixture into bound handles", async () => {
    const { transport } = makeTransport([
      (c) =>
        c.url === `${BASE}/v1/search/indexes`
          ? jsonResponse({
              databases: [
                ...gatewayListFixture.databases,
                indexDto({ id: "res_def456", name: "other" }),
              ],
            })
          : undefined,
    ]);
    const all = await searchindex.list(transport, BASE);
    expect(all).toHaveLength(2);
    expect(all[0]!.name).toBe("docs-corpus");
    expect(all[0]!.region).toBeNull();
    expect(typeof all[1]!.upsert).toBe("function");
  });

  it("retains the explicitly documented bare-array list compatibility shape", async () => {
    const { transport } = makeTransport([() => jsonResponse([indexDto()])]);
    await expect(searchindex.list(transport, BASE)).resolves.toHaveLength(1);
  });

  it("fails closed for unknown list envelopes and malformed entries", async () => {
    const { transport } = makeTransport([() => jsonResponse({})]);
    await expect(searchindex.list(transport, BASE)).rejects.toMatchObject({
      name: "SearchIndexContractError",
      operation: "list",
    });

    const { transport: malformedEntry } = makeTransport([
      () => jsonResponse({ databases: [{ id: "res_only" }] }),
    ]);
    await expect(searchindex.list(malformedEntry, BASE)).rejects.toBeInstanceOf(
      SearchIndexContractError,
    );
  });

  it("PATCHes only the provided fields on update", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto({ expiresAt: "2099-01-01T00:00:00.000Z" })),
    ]);
    const idx = await searchindex.update(
      "res_abc123",
      { expiresAt: "2099-01-01T00:00:00.000Z" },
      transport,
      BASE,
    );
    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes/res_abc123`);
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(bodyOf(calls[0]!)).toEqual({
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(idx.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("accepts a future ISO-8601 calendar date like the gateway DTO", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(indexDto({ expiresAt: "2099-01-01T00:00:00.000Z" })),
    ]);
    await searchindex.update(
      "res_abc123",
      { expiresAt: "2099-01-01" },
      transport,
      BASE,
    );
    expect(bodyOf(calls[0]!)).toEqual({ expiresAt: "2099-01-01" });
  });

  it("shares fail-fast id/update validation across control-plane calls", async () => {
    const { transport, calls } = makeTransport([]);
    await expect(searchindex.get("", transport, BASE)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      searchindex.update("res_abc123", { name: "" }, transport, BASE),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      searchindex.update(
        "res_abc123",
        { expiresAt: "January 1, 2099" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(searchindex.delete("", transport, BASE)).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    expect(calls).toHaveLength(0);
  });

  it("DELETEs the index and accepts a 204 with no body", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      searchindex.delete("res_abc123", transport, BASE),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/search/indexes/res_abc123`);
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("surfaces control-plane not-found / ownership mismatch as 404", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const calls = [
      () => searchindex.get("res_missing", transport, BASE),
      () =>
        searchindex.update(
          "res_missing",
          { name: "still-missing" },
          transport,
          BASE,
        ),
      () => searchindex.delete("res_missing", transport, BASE),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: "SearchIndexHttpError",
        status: 404,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Data plane (via the bound handle)
// ---------------------------------------------------------------------------

describe("SearchIndex.upsert()", () => {
  it("POSTs the documents ARRAY verbatim to {url}/upsert/default", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ result: "Success" }),
    ]);
    const docs = [
      {
        id: "getting-started",
        content: { title: "Get Started", body: "…" },
        metadata: { url: "https://docs.example.com/", contentHash: "abc" },
      },
    ];
    await idx.upsert(docs);
    expect(calls[0]!.url).toBe(`${DATA_URL}/upsert/default`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    // The body is the bare array — the gateway forwards it verbatim.
    expect(bodyOf(calls[0]!)).toEqual(docs);
  });

  it("targets a custom indexName namespace", async () => {
    const { idx, calls } = await makeHandle([() => jsonResponse({})]);
    await idx.upsert([{ id: "a", content: { t: 1 } }], {
      indexName: "articles",
    });
    expect(calls[0]!.url).toBe(`${DATA_URL}/upsert/articles`);
  });

  it("throws before fetching on an empty documents array or bad indexName", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.upsert([])).rejects.toMatchObject({ status: 400 });
    await expect(
      idx.upsert([{ id: "a", content: {} }], { indexName: "bad name!" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      idx.upsert([{ id: "a", content: null } as never]),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe("SearchIndex.query()", () => {
  const hits = [
    ...providerQueryFixture.result,
    { id: "verify", content: { title: "Verify Users" } },
  ];

  it("POSTs {url}/search/default with query/limit/reranking/filter and maps hits", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ result: hits }),
    ]);
    const results = await idx.query({
      query: "how do I authenticate?",
      limit: 3,
      reranking: true,
      filter: "tags = 'auth'",
    });
    expect(calls[0]!.url).toBe(`${DATA_URL}/search/default`);
    expect(bodyOf(calls[0]!)).toEqual({
      query: "how do I authenticate?",
      topK: 3,
      includeData: true,
      includeMetadata: true,
      reranking: true,
      filter: "tags = 'auth'",
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "getting-started",
      content: { title: "Get Started" },
      metadata: { url: "https://docs.example.com/" },
      score: 0.92,
    });
    expect(results[1]!.score).toBeUndefined();
  });

  it("retains the documented bare-array query compatibility shape", async () => {
    const { idx, calls } = await makeHandle([() => jsonResponse(hits)]);
    const results = await idx.query({ query: "verify" });
    expect(bodyOf(calls[0]!)).toEqual({
      query: "verify",
      topK: 5,
      includeData: true,
      includeMetadata: true,
    });
    expect(results.map((h) => h.id)).toEqual(["getting-started", "verify"]);
  });

  it("fails closed for unknown query envelopes and malformed hits", async () => {
    const { idx } = await makeHandle([
      () => jsonResponse({ result: [{ notAnId: true }, hits[0]] }),
    ]);
    await expect(idx.query({ query: "x" })).rejects.toBeInstanceOf(
      SearchIndexContractError,
    );

    const { idx: idx2 } = await makeHandle([() => jsonResponse("weird")]);
    await expect(idx2.query({ query: "x" })).rejects.toMatchObject({
      name: "SearchIndexContractError",
      operation: "query",
    });
  });

  it("throws before fetching on invalid query inputs", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.query({ query: "   " })).rejects.toMatchObject({
      status: 400,
    });
    await expect(idx.query({ query: "x", limit: 0 })).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("SearchIndex.range()", () => {
  it("allows an id-only read result without fabricating payload fields", () => {
    const document: SearchDocument = { id: "id-only" };
    expect(document).toEqual({ id: "id-only" });
  });

  it("POSTs {url}/range/default with cursor/limit/include flags and maps the live `vectors` page shape", async () => {
    // Captured live shape (2026-08-03): { result: { nextCursor, vectors } }.
    const { idx, calls } = await makeHandle([
      () => jsonResponse(providerRangeFixture),
    ]);
    const page = await idx.range({
      cursor: "0",
      limit: 100,
      includeMetadata: true,
    });
    expect(calls[0]!.url).toBe(`${DATA_URL}/range/default`);
    expect(bodyOf(calls[0]!)).toEqual({
      cursor: "0",
      limit: 100,
      includeMetadata: true,
    });
    expect(page.nextCursor).toBe("42");
    expect(page.documents.map((d) => d.id)).toEqual(["a", "b"]);
    expect(page.documents[0]!.metadata).toEqual({ contentHash: "h1" });
    expect(page.documents[0]).not.toHaveProperty("content");
  });

  it("falls back to a `documents` page key and maps it identically", async () => {
    const { idx } = await makeHandle([
      () =>
        jsonResponse({
          nextCursor: "7",
          documents: [{ id: "a", content: { t: 1 } }],
        }),
    ]);
    const page = await idx.range();
    expect(page.nextCursor).toBe("7");
    expect(page.documents.map((d) => d.id)).toEqual(["a"]);
  });

  it("sends valid first-page defaults and normalizes an empty nextCursor to null", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ result: { nextCursor: "", vectors: [] } }),
    ]);
    const page = await idx.range();
    expect(bodyOf(calls[0]!)).toEqual({ cursor: "0", limit: 100 });
    expect(page).toEqual({ nextCursor: null, documents: [] });
  });

  it("fails closed for malformed pages/documents", async () => {
    const { idx } = await makeHandle([
      () => jsonResponse({ result: { nextCursor: "", wrong: [] } }),
    ]);
    await expect(idx.range()).rejects.toBeInstanceOf(SearchIndexContractError);

    const { idx: malformedDocument } = await makeHandle([
      () =>
        jsonResponse({
          result: { nextCursor: "", vectors: [{ id: "a", content: null }] },
        }),
    ]);
    await expect(malformedDocument.range()).rejects.toBeInstanceOf(
      SearchIndexContractError,
    );
  });

  it("rejects undocumented range envelope combinations", async () => {
    const { idx: topLevelVectors } = await makeHandle([
      () => jsonResponse({ nextCursor: "", vectors: [] }),
    ]);
    await expect(topLevelVectors.range()).rejects.toBeInstanceOf(
      SearchIndexContractError,
    );

    const { idx: nestedDocuments } = await makeHandle([
      () => jsonResponse({ result: { nextCursor: "", documents: [] } }),
    ]);
    await expect(nestedDocuments.range()).rejects.toBeInstanceOf(
      SearchIndexContractError,
    );
  });

  it("validates cursor, limit, and include flags before fetching", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.range({ cursor: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(idx.range({ limit: 1001 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      idx.range({ includeMetadata: "yes" } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe("SearchIndex.fetchDocuments() / deleteDocuments()", () => {
  it("POSTs {url}/fetch/default with ids + include flags and preserves nulls for misses", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse(providerFetchFixture),
    ]);
    const docs = await idx.fetchDocuments(["a", "missing"], {
      includeMetadata: true,
    });
    expect(calls[0]!.url).toBe(`${DATA_URL}/fetch/default`);
    expect(bodyOf(calls[0]!)).toEqual({
      ids: ["a", "missing"],
      includeMetadata: true,
    });
    expect(docs[0]!.id).toBe("a");
    expect(docs[0]!.metadata).toEqual({ contentHash: "h1" });
    expect(docs[0]).not.toHaveProperty("content");
    expect(docs[1]).toBeNull();
  });

  it("fails closed for malformed fetch envelopes and positional cardinality", async () => {
    const { idx } = await makeHandle([() => jsonResponse({})]);
    await expect(idx.fetchDocuments(["a"])).rejects.toBeInstanceOf(
      SearchIndexContractError,
    );

    const { idx: short } = await makeHandle([
      () => jsonResponse({ result: [{ id: "a" }] }),
    ]);
    await expect(short.fetchDocuments(["a", "b"])).rejects.toMatchObject({
      name: "SearchIndexContractError",
      operation: "fetchDocuments",
    });
  });

  it("fails closed when non-null fetch results do not match requested ID positions", async () => {
    const { idx: swapped } = await makeHandle([
      () => jsonResponse({ result: [{ id: "b" }, { id: "a" }] }),
    ]);
    await expect(swapped.fetchDocuments(["a", "b"])).rejects.toMatchObject({
      name: "SearchIndexContractError",
      operation: "fetchDocuments",
    });

    const { idx: wrong } = await makeHandle([
      () => jsonResponse({ result: [{ id: "unexpected" }, null] }),
    ]);
    await expect(wrong.fetchDocuments(["a", "missing"])).rejects.toMatchObject({
      name: "SearchIndexContractError",
      operation: "fetchDocuments",
    });

    const { idx: positionalMiss } = await makeHandle([
      () => jsonResponse({ result: [null, { id: "b" }] }),
    ]);
    await expect(
      positionalMiss.fetchDocuments(["missing", "b"]),
    ).resolves.toEqual([null, { id: "b" }]);
  });

  it("DELETEs {url}/delete/default with the ids body", async () => {
    const { idx, calls } = await makeHandle([
      () => jsonResponse({ deleted: 2 }),
    ]);
    await idx.deleteDocuments(["a", "b"]);
    expect(calls[0]!.url).toBe(`${DATA_URL}/delete/default`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(bodyOf(calls[0]!)).toEqual({ ids: ["a", "b"] });
  });

  it("throws before fetching on empty ids", async () => {
    const { idx, calls } = await makeHandle([]);
    await expect(idx.fetchDocuments([])).rejects.toMatchObject({ status: 400 });
    await expect(idx.deleteDocuments([])).rejects.toMatchObject({
      status: 400,
    });
    await expect(idx.fetchDocuments([""])).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toHaveLength(0);
  });

  it("surfaces data-plane not-found / ownership mismatch as 404", async () => {
    const { idx } = await makeHandle([
      () =>
        new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const calls = [
      () => idx.upsert([{ id: "a", content: {} }]),
      () => idx.query({ query: "anything" }),
      () => idx.range(),
      () => idx.fetchDocuments(["a"]),
      () => idx.deleteDocuments(["a"]),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: "SearchIndexHttpError",
        status: 404,
      });
    }
  });
});
