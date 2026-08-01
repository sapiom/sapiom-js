import { Transport } from "../_client/index.js";
import * as keys from "./index.js";
import { KeysHttpError, toTtlSeconds } from "./index.js";

// Capability fns are tested directly with a real Transport plus a scripted fetch
// mock, so URL/method/header/body assertions are exact and we verify the Transport
// injects the tenant credential on the header the /v1 controller guard reads.

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
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

const mintResponse = (overrides: Record<string, unknown> = {}) => ({
  apiKey: {
    id: "child-key-1",
    expiresAt: "2026-09-01T00:00:00Z",
    permissions: ["org.transactions.write"],
    ...overrides,
  },
  plainKey: "sk_live_child-secret",
});

describe("keys.mintScoped()", () => {
  it("POSTs /v1/api-keys/scoped/workflow on x-api-key and maps the response", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(mintResponse()),
    ]);

    const result = await keys.mintScoped({ ttl: 2592000 }, transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/v1/api-keys/scoped/workflow`);
    expect(calls[0]!.init.method).toBe("POST");
    // The /v1 controller guard reads x-api-key — NOT the gateway-direct x-sapiom-api-key.
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ttl: 2592000 });

    expect(result).toEqual({
      key: "sk_live_child-secret",
      id: "child-key-1",
      expiresAt: "2026-09-01T00:00:00Z",
      permissions: ["org.transactions.write"],
    });
  });

  it("accepts a compact duration string for ttl", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(mintResponse()),
    ]);
    await keys.mintScoped({ ttl: "30d" }, transport, BASE);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ttl: 2592000 });
  });

  it("omits scope when not provided (server defaults it)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(mintResponse()),
    ]);
    await keys.mintScoped({ ttl: 3600 }, transport, BASE);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ttl: 3600 });
  });

  it("normalizes a single scope string to an array", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(mintResponse()),
    ]);
    await keys.mintScoped(
      { ttl: 3600, scope: "org.transactions.write" },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      ttl: 3600,
      scope: ["org.transactions.write"],
    });
  });

  it("passes an array scope through unchanged", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse(mintResponse()),
    ]);
    await keys.mintScoped(
      { ttl: 3600, scope: ["org.transactions.write"] },
      transport,
      BASE,
    );
    expect(JSON.parse(calls[0]!.init.body as string).scope).toEqual([
      "org.transactions.write",
    ]);
  });

  it("defaults expiresAt/permissions when the response omits them", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ apiKey: { id: "child-2" }, plainKey: "sk_live_x" }),
    ]);
    const result = await keys.mintScoped({ ttl: 3600 }, transport, BASE);
    expect(result).toEqual({
      key: "sk_live_x",
      id: "child-2",
      expiresAt: null,
      permissions: [],
    });
  });

  it("throws KeysHttpError on a non-2xx response, carrying status + body", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "not a workflow run token" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await expect(
      keys.mintScoped({ ttl: 3600 }, transport, BASE),
    ).rejects.toMatchObject({
      name: "KeysHttpError",
      status: 403,
      body: { message: "not a workflow run token" },
    });
    await expect(
      keys.mintScoped({ ttl: 3600 }, transport, BASE),
    ).rejects.toBeInstanceOf(KeysHttpError);
  });
});

describe("toTtlSeconds()", () => {
  it("passes a positive number of seconds through (floored)", () => {
    expect(toTtlSeconds(3600)).toBe(3600);
    expect(toTtlSeconds(90.9)).toBe(90);
  });

  it("parses compact duration strings", () => {
    expect(toTtlSeconds("45s")).toBe(45);
    expect(toTtlSeconds("45m")).toBe(45 * 60);
    expect(toTtlSeconds("12h")).toBe(12 * 60 * 60);
    expect(toTtlSeconds("30d")).toBe(30 * 60 * 60 * 24);
    expect(toTtlSeconds("3600")).toBe(3600); // bare number → seconds
  });

  it("throws on non-positive or unparseable values", () => {
    expect(() => toTtlSeconds(0)).toThrow(TypeError);
    expect(() => toTtlSeconds(-5)).toThrow(TypeError);
    expect(() => toTtlSeconds("soon")).toThrow(TypeError);
    expect(() => toTtlSeconds("10w")).toThrow(TypeError);
  });
});
