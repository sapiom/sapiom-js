import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import { createStubClient } from "../stub/index.js";
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
const bodyOf = (c: FetchCall) => JSON.parse(String(c.init.body)) as unknown;

const APPEND_OK = {
  id: "mem-1",
  content: "User prefers dark mode.",
  createdAt: "2026-07-09T00:00:00Z",
};

const RECALL_OK = {
  results: [],
  query: "ui preferences",
  topK: 5,
  count: 0,
};

// ---------------------------------------------------------------------------
// Base URL resolution (resolveServiceUrl at module load)
// ---------------------------------------------------------------------------

describe("memory — base URL resolution", () => {
  it("defaults to the production memory service origin when nothing overrides it", async () => {
    // DEFAULT_BASE_URL is captured at module load from process.env; with no
    // SAPIOM_MEMORY_URL / SAPIOM_SERVICES_BASE set in this test run it must be
    // the production origin, and the /v1/memory path prefix is appended per-method.
    const { transport, calls } = makeTransport([() => jsonResponse(APPEND_OK)]);
    await memory.append({ content: "x" }, transport);
    expect(calls[0]!.url).toBe(
      "https://memory.services.sapiom.ai/v1/memory/append",
    );
  });
});

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

describe("memory.append", () => {
  it("POSTs only { content } when every optional field is omitted", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(APPEND_OK)]);
    const result = await memory.append({ content: "x" }, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/append`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(bodyOf(calls[0]!)).toEqual({ content: "x" });
    expect(result).toEqual(APPEND_OK);
  });

  it("passes namespace, flat metadata, and occurredAt through verbatim", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(APPEND_OK)]);
    const metadata = {
      team: "sales",
      user_theme: "dark",
      logged_in: true,
      visits: 3,
    };
    await memory.append(
      {
        content: "x",
        namespace: "agent-42",
        metadata,
        occurredAt: "2026-07-01T00:00:00Z",
      },
      transport,
      BASE,
    );
    expect(bodyOf(calls[0]!)).toEqual({
      content: "x",
      namespace: "agent-42",
      metadata,
      occurredAt: "2026-07-01T00:00:00Z",
    });
  });

  it("returns the response as-is, including omitted optionals", async () => {
    const wire = {
      ...APPEND_OK,
      occurredAt: "2026-07-01T00:00:00Z",
    };
    const { transport } = makeTransport([() => jsonResponse(wire)]);
    const result = await memory.append({ content: "x" }, transport, BASE);
    expect(result).toEqual(wire);
    expect(result.metadata).toBeUndefined();
  });

  it("throws MemoryHttpError with status and parsed body on a caller-safe 400", async () => {
    const body = {
      code: "secret_detected",
      message: "content contains a secret",
    };
    const { transport } = makeTransport([
      () => jsonResponse(body, { status: 400 }),
    ]);
    const err = await memory
      .append({ content: "sk-..." }, transport, BASE)
      .then(
        () => null,
        (e: unknown) => e as MemoryHttpError,
      );
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err!.status).toBe(400);
    expect(err!.body).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

describe("memory.recall", () => {
  it("POSTs only { query } when every optional field is omitted", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(RECALL_OK)]);
    const result = await memory.recall({ query: "q" }, transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory/recall`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({ query: "q" });
    expect(result).toEqual(RECALL_OK);
  });

  it("passes namespace, topK, strategy, temporal weight, and filter through verbatim", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse(RECALL_OK)]);
    const filter = {
      team: "sales",
      "user.theme": "dark",
      env: { in: ["prod", "staging"] },
    };
    await memory.recall(
      {
        query: "q",
        namespace: "agent-42",
        topK: 10,
        strategy: "hybrid",
        weight: { temporal: { halfLifeDays: 7 } },
        filter,
      },
      transport,
      BASE,
    );
    expect(bodyOf(calls[0]!)).toEqual({
      query: "q",
      namespace: "agent-42",
      topK: 10,
      strategy: "hybrid",
      weight: { temporal: { halfLifeDays: 7 } },
      filter,
    });
  });

  it("returns matches as-is (nullable metadata/occurredAt)", async () => {
    const wire = {
      results: [
        {
          id: "mem-1",
          content: "c",
          score: 0.92,
          createdAt: "2026-07-09T00:00:00Z",
          occurredAt: null,
          metadata: null,
        },
      ],
      query: "q",
      topK: 5,
      count: 1,
    };
    const { transport } = makeTransport([() => jsonResponse(wire)]);
    const result = await memory.recall({ query: "q" }, transport, BASE);
    expect(result).toEqual(wire);
  });

  it("throws MemoryHttpError on invalid_filter", async () => {
    const body = { code: "invalid_filter", message: "bad key '0key'" };
    const { transport } = makeTransport([
      () => jsonResponse(body, { status: 400 }),
    ]);
    const err = await memory
      .recall({ query: "q", filter: { "0key": "x" } }, transport, BASE)
      .then(
        () => null,
        (e: unknown) => e as MemoryHttpError,
      );
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err!.status).toBe(400);
    expect(err!.body).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

describe("memory.forget", () => {
  it("DELETEs /v1/memory with an { ids } body and resolves void on 204", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      memory.forget({ ids: ["a", "b"] }, transport, BASE),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/v1/memory`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(bodyOf(calls[0]!)).toEqual({ ids: ["a", "b"] });
  });

  it("includes namespace in the body when provided", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await memory.forget({ ids: ["a"], namespace: "agent-42" }, transport, BASE);
    expect(bodyOf(calls[0]!)).toEqual({ ids: ["a"], namespace: "agent-42" });
  });

  it("throws MemoryHttpError with parsed body on failure", async () => {
    const body = { code: "batch_too_large", message: "too many ids" };
    const { transport } = makeTransport([
      () => jsonResponse(body, { status: 400 }),
    ]);
    const err = await memory.forget({ ids: ["a"] }, transport, BASE).then(
      () => null,
      (e: unknown) => e as MemoryHttpError,
    );
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err!.status).toBe(400);
    expect(err!.body).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------

describe("memory.drop", () => {
  it("DELETEs /v1/memory/namespaces/:namespace (URL-encoded) and resolves void on 204", async () => {
    const { transport, calls } = makeTransport([
      () => new Response(null, { status: 204 }),
    ]);
    await expect(
      memory.drop("agent 42/beta", transport, BASE),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(
      `${BASE}/v1/memory/namespaces/agent%2042%2Fbeta`,
    );
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
  });

  it("throws MemoryHttpError with raw-text body when the error body is not JSON", async () => {
    const { transport } = makeTransport([
      () => new Response("upstream exploded", { status: 502 }),
    ]);
    const err = await memory.drop("ns", transport, BASE).then(
      () => null,
      (e: unknown) => e as MemoryHttpError,
    );
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err!.status).toBe(502);
    expect(err!.body).toBe("upstream exploded");
  });
});

// ---------------------------------------------------------------------------
// createClient wiring
// ---------------------------------------------------------------------------

describe("createClient().memory", () => {
  it("routes every verb through the client transport with the tenant credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      if (url.endsWith("/append")) return jsonResponse(APPEND_OK);
      if (url.endsWith("/recall")) return jsonResponse(RECALL_OK);
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.memory.append({ content: "x" });
    await sapiom.memory.recall({ query: "q" });
    await sapiom.memory.forget({ ids: ["a"] });
    await sapiom.memory.drop("ns");

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }
    expect(calls.map((c) => c.init.method ?? "GET")).toEqual([
      "POST",
      "POST",
      "DELETE",
      "DELETE",
    ]);
    expect(calls[3]!.url).toBe(
      "https://memory.services.sapiom.ai/v1/memory/namespaces/ns",
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
// Stub client — semantic fidelity (see stub/index.ts for what is simulated)
// ---------------------------------------------------------------------------

describe("createStubClient().memory", () => {
  it("append → recall round-trips a record within its namespace", async () => {
    const stub = createStubClient();
    const appended = await stub.memory.append({
      content: "User prefers dark mode.",
      namespace: "u1",
      metadata: { source: "onboarding", user_theme: "dark" },
      occurredAt: "2026-07-01T00:00:00Z",
    });
    expect(appended.metadata).toEqual({
      source: "onboarding",
      user_theme: "dark",
    });
    expect(appended.occurredAt).toBe("2026-07-01T00:00:00Z");

    const hit = await stub.memory.recall({ query: "theme", namespace: "u1" });
    expect(hit.count).toBe(1);
    expect(hit.results[0]).toMatchObject({
      id: appended.id,
      content: "User prefers dark mode.",
      metadata: { source: "onboarding", user_theme: "dark" },
    });

    const miss = await stub.memory.recall({ query: "theme" });
    expect(miss.count).toBe(0); // different (default) namespace
  });

  it("matches filters on flat keys and `{in}` sets", async () => {
    const stub = createStubClient();
    await stub.memory.append({
      content: "a",
      metadata: { user_theme: "dark", env: "prod" },
    });
    await stub.memory.append({
      content: "b",
      metadata: { env: "dev" },
    });

    const byKey = await stub.memory.recall({
      query: "q",
      filter: { user_theme: "dark" },
    });
    expect(byKey.results.map((m) => m.content)).toEqual(["a"]);

    const byIn = await stub.memory.recall({
      query: "q",
      filter: { env: { in: ["dev", "staging"] } },
    });
    expect(byIn.results.map((m) => m.content)).toEqual(["b"]);
  });

  it("accepts every valid strategy and defaults fine when omitted", async () => {
    const stub = createStubClient();
    await stub.memory.append({ content: "x" });
    for (const strategy of ["semantic", "keyword", "hybrid"] as const) {
      await expect(
        stub.memory.recall({ query: "q", strategy }),
      ).resolves.toMatchObject({ count: 1 });
    }
    await expect(stub.memory.recall({ query: "q" })).resolves.toMatchObject({
      count: 1,
    });
  });

  it("rejects an invalid recall strategy with the allowed-values message", async () => {
    const stub = createStubClient();
    const err = await stub.memory
      .recall({ query: "q", strategy: "foobar" as never })
      .then(
        () => null,
        (e: unknown) => e as MemoryHttpError,
      );
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err!.status).toBe(400);
    expect(err!.message).toBe(
      "strategy must be one of the following values: semantic, keyword, hybrid",
    );
  });

  it("rejects array, null, nested-object values and dotted keys like the service", async () => {
    const stub = createStubClient();
    for (const metadata of [
      { tags: ["a", "b"] },
      { bad: null },
      { nested: { not: "allowed" } },
      { "dotted.key": "x" },
    ] as unknown[]) {
      const err = await stub.memory
        .append({ content: "x", metadata: metadata as never })
        .then(
          () => null,
          (e: unknown) => e as MemoryHttpError,
        );
      expect(err).toBeInstanceOf(MemoryHttpError);
      expect(err!.status).toBe(400);
      expect((err!.body as { code: string }).code).toBe("invalid_metadata");
    }
  });

  it("rejects metadata with neutral, topology-free messages", async () => {
    const stub = createStubClient();
    const messageFor = (metadata: unknown) =>
      stub.memory
        .append({ content: "x", metadata: metadata as never })
        .then(
          () => "",
          (e: unknown) => (e as MemoryHttpError).message,
        );

    // A dotted key is rejected with a pure constraint message (no internals).
    const dotted = await messageFor({ "dotted.key": "x" });
    expect(dotted).toContain("must not contain '.'");

    // Any other non-identifier key gets the key-grammar message.
    const badKey = await messageFor({ "bad-key": "x" });
    expect(badKey).toContain("must start with a letter");

    for (const message of [dotted, badKey]) {
      expect(message).not.toMatch(/gateway|upstream|engine|backend|proxy/i);
    }
  });

  it("forget is blind-idempotent and drop clears the namespace", async () => {
    const stub = createStubClient();
    const { id } = await stub.memory.append({ content: "x", namespace: "n" });
    await expect(
      stub.memory.forget({ ids: [id, "never-existed"], namespace: "n" }),
    ).resolves.toBeUndefined();
    expect(
      (await stub.memory.recall({ query: "q", namespace: "n" })).count,
    ).toBe(0);

    await stub.memory.append({ content: "y", namespace: "n" });
    await stub.memory.drop("n");
    expect(
      (await stub.memory.recall({ query: "q", namespace: "n" })).count,
    ).toBe(0);
    await expect(stub.memory.drop("n")).resolves.toBeUndefined(); // idempotent
  });
});

// ---------------------------------------------------------------------------
// MemoryHttpError
// ---------------------------------------------------------------------------

describe("MemoryHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new MemoryHttpError("something went wrong", 400, {
      code: "invalid_metadata",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryHttpError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ code: "invalid_metadata" });
    expect(err.name).toBe("MemoryHttpError");
  });
});
