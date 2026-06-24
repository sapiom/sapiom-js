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
// append()
// ---------------------------------------------------------------------------

describe("memory.append()", () => {
  it("POSTs /append with JSON body + credential and returns the camelCase payload as-is", async () => {
    const raw = {
      id: "m-123",
      content: "User prefers dark mode.",
      scope: "user",
      status: "active",
      decision: "ADDED",
      supersededId: null,
      similarityScore: null,
      createdAt: "2026-06-22T12:00:00Z",
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
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/append`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content: "User prefers dark mode.",
      scope: "user",
      metadata: { source: "survey" },
    });
  });

  it("surfaces a SUPERSEDED decision unchanged", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-new",
            content: "c",
            scope: "default",
            status: "active",
            decision: "SUPERSEDED",
            supersededId: "m-old",
            similarityScore: 0.91,
            createdAt: "2026-06-22T12:00:00Z",
            metadata: {},
          },
          { status: 201 },
        ),
    ]);

    const result = await memory.append({ content: "c" }, transport, BASE);
    expect(result.decision).toBe("SUPERSEDED");
    expect(result.supersededId).toBe("m-old");
    expect(result.similarityScore).toBe(0.91);
  });

  it("surfaces a NOOP decision echoing the existing memory (nothing written)", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-existing",
            content: "User prefers dark mode.",
            scope: "user",
            status: "active",
            decision: "NOOP",
            supersededId: null,
            similarityScore: 1,
            createdAt: "2026-06-01T00:00:00Z",
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
    expect(result.supersededId).toBeNull();
  });

  it("sends idempotencyKey in the body and returns NOOP on a re-submit", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse(
          {
            id: "m-existing",
            content: "c",
            scope: "default",
            status: "active",
            decision: "NOOP",
            supersededId: null,
            similarityScore: null,
            createdAt: "2026-06-01T00:00:00Z",
            metadata: {},
          },
          { status: 200 },
        ),
    ]);

    const result = await memory.append(
      { content: "c", idempotencyKey: "import-42" },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      content: "c",
      idempotencyKey: "import-42",
    });
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
            status: "active",
            decision: "ADDED",
            supersededId: null,
            similarityScore: null,
            createdAt: "2026-06-22T12:00:00Z",
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
});

// ---------------------------------------------------------------------------
// recall()
// ---------------------------------------------------------------------------

describe("memory.recall()", () => {
  const match = {
    id: "m-1",
    content: "The project deadline is end of Q3.",
    scope: "project",
    vectorScore: 0.82,
    textScore: 0.4,
    combinedScore: 0.71,
    status: "active",
    createdAt: "2026-06-01T00:00:00Z",
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
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/recall`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "deadline",
    });
  });

  it("includes scope, topK, and minSimilarity in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ results: [], query: "q", topK: 5, count: 0 }),
    ]);

    await memory.recall(
      { query: "q", scope: "project", topK: 5, minSimilarity: 0.5 },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      scope: "project",
      topK: 5,
      minSimilarity: 0.5,
    });
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
// get()
// ---------------------------------------------------------------------------

describe("memory.get()", () => {
  const record = {
    id: "m-1",
    content: "c",
    scope: "default",
    status: "superseded",
    supersededBy: "m-2",
    supersededReason: "near-duplicate",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-02T00:00:00Z",
    metadata: {},
  };

  it("GETs /:id and returns the record (including supersession chain)", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(record)]);

    const result = await memory.get("m-1", transport, BASE);

    expect(result).toEqual(record);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/m-1`);
    expect(calls[0]!.init.method).toBeUndefined(); // default GET
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
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

  it("encodes special characters in the id", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);

    await memory.forget("id/with slash", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/id%2Fwith%20slash`);
  });

  it("throws MemoryHttpError with status 404 on a second forget (hard delete, not idempotent)", async () => {
    // forget is a hard DELETE: a second forget of an already-deleted id is a 404,
    // NOT a 409 — there is no "already superseded" state for forget.
    const { transport } = makeTransport([
      () =>
        new Response(
          JSON.stringify({
            statusCode: 404,
            error: "Not Found",
            message: "Memory not found",
          }),
          { status: 404 },
        ),
    ]);

    await expect(
      memory.forget("m-abc", transport, BASE),
    ).rejects.toBeInstanceOf(MemoryHttpError);
    // Also assert the parsed body: forget() has its own inline error-body parser
    // (the 204 path can't use ensureOk), so exercise its JSON-parse branch here.
    await expect(
      memory.forget("m-abc", transport, BASE),
    ).rejects.toMatchObject({
      status: 404,
      body: { statusCode: 404, error: "Not Found", message: "Memory not found" },
    });
  });

  it("throws MemoryHttpError on 404 (unknown / cross-owner id, non-JSON body)", async () => {
    const { transport } = makeTransport([
      () => new Response("not found", { status: 404 }),
    ]);

    await expect(
      memory.forget("bad-id", transport, BASE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Client wiring + auth
// ---------------------------------------------------------------------------

describe("memory — client wiring + credential", () => {
  it("createClient().memory routes all four methods with the credential", async () => {
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
      if (url.endsWith("/append"))
        return jsonResponse(
          {
            id: "m",
            content: "c",
            scope: "default",
            status: "active",
            decision: "ADDED",
            supersededId: null,
            similarityScore: null,
            createdAt: "2026-06-22T12:00:00Z",
            metadata: {},
          },
          { status: 201 },
        );
      // GET /:id
      return jsonResponse({
        id: "m",
        content: "c",
        scope: "default",
        status: "active",
        supersededBy: null,
        supersededReason: null,
        createdAt: "2026-06-22T12:00:00Z",
        updatedAt: "2026-06-22T12:00:00Z",
        metadata: {},
      });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.memory.append({ content: "c" });
    await sapiom.memory.recall({ query: "q" });
    await sapiom.memory.get("m");
    await sapiom.memory.forget("m");

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
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
