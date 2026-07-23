import { Transport } from "./index.js";
import { capabilityCall, resolveCoreBaseUrl } from "./capability-call.js";

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
  response: (call: FetchCall) => Response,
  apiKey: string | undefined = "test-key",
): { transport: Transport; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return response({ url, init });
  }) as typeof globalThis.fetch;
  return { transport: new Transport({ apiKey, fetch: fetchMock }), calls };
}

const headerOf = (c: FetchCall, k: string) =>
  (c.init.headers as Record<string, string>)[k];

class FakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "FakeError";
  }
}
const makeError = (m: string, s: number, b: unknown): Error =>
  new FakeError(m, s, b);

// ---------------------------------------------------------------------------
// resolveCoreBaseUrl — call-time resolution from client config, single knob
// ---------------------------------------------------------------------------

describe("resolveCoreBaseUrl()", () => {
  const KEYS = ["SAPIOM_BASE_URL", "SAPIOM_API_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to the production Core base URL", () => {
    expect(resolveCoreBaseUrl()).toBe("https://api.sapiom.ai");
  });

  it("prefers SAPIOM_BASE_URL, then SAPIOM_API_URL", () => {
    process.env.SAPIOM_API_URL = "https://api-url.example";
    expect(resolveCoreBaseUrl()).toBe("https://api-url.example");
    process.env.SAPIOM_BASE_URL = "https://base-url.example";
    expect(resolveCoreBaseUrl()).toBe("https://base-url.example");
  });

  it("is resolved at call time — a value set after import is honored", () => {
    expect(resolveCoreBaseUrl()).toBe("https://api.sapiom.ai");
    process.env.SAPIOM_BASE_URL = "http://localhost:3000";
    // No module-level freeze: the very next call reflects the new env.
    expect(resolveCoreBaseUrl()).toBe("http://localhost:3000");
  });
});

// ---------------------------------------------------------------------------
// capabilityCall — the single routed-call seam
// ---------------------------------------------------------------------------

describe("capabilityCall()", () => {
  it("POSTs /v1/capabilities/<id> on the given base URL with x-api-key and a JSON body", async () => {
    const { transport, calls } = makeTransport(() =>
      jsonResponse({ ok: true }),
    );

    const out = await capabilityCall<{ ok: boolean }>(
      "web.scrape",
      { url: "https://example.com" },
      {
        transport,
        baseUrl: "https://api.test",
        makeError,
        errorPrefix: "Failed to scrape",
      },
    );

    expect(out).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://api.test/v1/capabilities/web.scrape");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // Every request carries the SDK client marker so the gateway can tell SDK
    // traffic from raw HTTP (bins to client:sdk on its /v2 metrics).
    expect(headerOf(calls[0]!, "x-sapiom-client")).toMatch(/^sapiom-tools\//);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      url: "https://example.com",
    });
  });

  it("defaults the base URL to the resolved Core base URL when none is given", async () => {
    const { transport, calls } = makeTransport(() => jsonResponse({}));

    await capabilityCall(
      "email.verify",
      { email: "a@b.com" },
      { transport, makeError, errorPrefix: "x" },
    );

    expect(calls[0]!.url).toBe(
      "https://api.sapiom.ai/v1/capabilities/email.verify",
    );
  });

  it("throws the capability's typed error with the parsed JSON body on a non-2xx", async () => {
    const { transport } = makeTransport(
      () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    await expect(
      capabilityCall(
        "web.scrape",
        {},
        { transport, makeError, errorPrefix: "Failed to scrape" },
      ),
    ).rejects.toMatchObject({
      name: "FakeError",
      status: 500,
      body: { error: "boom" },
    });
  });

  it("falls back to the raw text body when the error response isn't JSON", async () => {
    const { transport } = makeTransport(
      () => new Response("upstream exploded", { status: 502 }),
    );

    await expect(
      capabilityCall(
        "web.scrape",
        {},
        { transport, makeError, errorPrefix: "Failed to scrape" },
      ),
    ).rejects.toMatchObject({ status: 502, body: "upstream exploded" });
  });
});
