import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as vault from "./index.js";
import { VaultHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers — capability fns are tested directly with a real Transport wired to a
// scripted fetch mock (so URL/method/header assertions are exact, and we verify
// the Transport itself injects the tenant credential). Mirrors memory/index.spec.
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

const BASE = "https://vault.test";

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

describe("vault — base URL resolution", () => {
  it("defaults to the production vault service origin (v2 path appended)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ API_KEY: "sk-1" }),
    ]);
    await vault.getAll("my-creds", transport);
    expect(calls[0]!.url).toBe(
      "https://vault.services.sapiom.ai/v2/secrets/my-creds",
    );
  });
});

// ---------------------------------------------------------------------------
// getAll / getMany / list
// ---------------------------------------------------------------------------

describe("vault.getAll", () => {
  it("GETs /v2/secrets/:ref (ref URL-encoded) and returns the flat map", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ API_KEY: "sk-1", DB_URL: "postgres://x" }),
    ]);
    const all = await vault.getAll("team/creds", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v2/secrets/team%2Fcreds`);
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(all).toEqual({ API_KEY: "sk-1", DB_URL: "postgres://x" });
  });

  it("throws VaultHttpError with status/body on a non-2xx", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ error: "forbidden" }, { status: 403 }),
    ]);
    await expect(vault.getAll("my-creds", transport, BASE)).rejects.toMatchObject({
      name: "VaultHttpError",
      status: 403,
    });
  });
});

describe("vault.getMany", () => {
  it("passes the keys subset as a comma-joined query param", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ A: "1", B: "2" }),
    ]);
    const subset = await vault.getMany("my-creds", ["A", "B"], transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v2/secrets/my-creds?keys=A%2CB`);
    expect(subset).toEqual({ A: "1", B: "2" });
  });

  it("sends keys= for an empty subset (API returns the empty map)", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);
    await expect(vault.getMany("my-creds", [], transport, BASE)).resolves.toEqual({});
    expect(calls[0]!.url).toBe(`${BASE}/v2/secrets/my-creds?keys=`);
  });
});

describe("vault.list", () => {
  it("returns only the sorted key names, never the values", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ ZEBRA: "z", API_KEY: "sk-1" }),
    ]);
    await expect(vault.list("my-creds", transport, BASE)).resolves.toEqual([
      "API_KEY",
      "ZEBRA",
    ]);
  });
});

// ---------------------------------------------------------------------------
// get (single value; 404 → null)
// ---------------------------------------------------------------------------

describe("vault.get", () => {
  it("GETs /v2/secrets/:ref/:key (both segments URL-encoded) and unwraps value", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ value: "sk-live-123" }),
    ]);
    const value = await vault.get("my creds", "API/KEY", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v2/secrets/my%20creds/API%2FKEY`);
    expect(value).toBe("sk-live-123");
  });

  it("returns null on a 404 (missing key is an expected lookup outcome)", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ error: "not found" }, { status: 404 }),
    ]);
    await expect(vault.get("my-creds", "MISSING", transport, BASE)).resolves.toBeNull();
  });

  it("rethrows non-404 failures as VaultHttpError", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ error: "nope" }, { status: 403 }),
    ]);
    await expect(vault.get("my-creds", "API_KEY", transport, BASE)).rejects.toBeInstanceOf(
      VaultHttpError,
    );
  });
});

// ---------------------------------------------------------------------------
// client binding (ctx.sapiom.vault)
// ---------------------------------------------------------------------------

describe("createClient().vault", () => {
  it("binds the read-only surface and injects the client credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      return jsonResponse({ value: "sk-1" });
    }) as typeof globalThis.fetch;

    const client = createClient({ apiKey: "client-key", fetch: fetchMock });
    await expect(client.vault.get("my-creds", "API_KEY")).resolves.toBe("sk-1");
    const headers = calls[0]!.init.headers as Record<string, string>;
    const headerNames = Object.keys(headers).map((h) => h.toLowerCase());
    expect(headerNames.some((h) => h.includes("key") || h.includes("authorization"))).toBe(true);
  });
});
