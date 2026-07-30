import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import * as browserAutomation from "./index.js";
import { BrowserAutomationHttpError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers
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
// sessions.create / createSession()
// ---------------------------------------------------------------------------

describe("browserAutomation.sessions.create()", () => {
  it("POSTs /v1/sessions with empty body, sends credential, returns mapped BrowserSession", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          sessionId: "sess-123",
          cdpUrl: "ws://cdp.example.com/session/sess-123",
          liveViewUrl: "https://live.example.com/sess-123",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        }),
    ]);

    const result = await browserAutomation.createSession(transport, BASE);

    expect(calls[0]!.url).toBe(`${BASE}/v1/sessions`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});

    expect(result.sessionId).toBe("sess-123");
    expect(result.cdpUrl).toBe("ws://cdp.example.com/session/sess-123");
    expect(result.liveViewUrl).toBe("https://live.example.com/sess-123");
    expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(result.maxDurationSec).toBe(1200);
  });

  it("maps snake_case response fields to camelCase", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          session_id: "sess-snake",
          cdp_url: "ws://cdp.example.com/snake",
          live_view_url: "https://live.example.com/snake",
          expires_at: "2099-01-01T00:00:00Z",
          max_duration_sec: 600,
        }),
    ]);

    const result = await browserAutomation.createSession(transport, BASE);

    expect(result.sessionId).toBe("sess-snake");
    expect(result.cdpUrl).toBe("ws://cdp.example.com/snake");
    expect(result.liveViewUrl).toBe("https://live.example.com/snake");
    expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(result.maxDurationSec).toBe(600);
  });

  it("omits liveViewUrl when not in the response", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          sessionId: "sess-nolive",
          cdpUrl: "ws://cdp.example.com/nolive",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        }),
    ]);

    const result = await browserAutomation.createSession(transport, BASE);
    expect(result.liveViewUrl).toBeUndefined();
  });

  it("passes extra response fields through via [k: string]: unknown", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          sessionId: "sess-extra",
          cdpUrl: "ws://cdp.example.com/extra",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
          someNewField: "hello",
        }),
    ]);

    const result = await browserAutomation.createSession(transport, BASE);
    expect((result as Record<string, unknown>)["someNewField"]).toBe("hello");
  });

  it("throws BrowserAutomationHttpError on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
        }),
    ]);

    await expect(
      browserAutomation.createSession(transport, BASE),
    ).rejects.toMatchObject({
      name: "BrowserAutomationHttpError",
      status: 401,
      body: { message: "unauthorized" },
    });
  });
});

// ---------------------------------------------------------------------------
// sessions.createWithIdentity / createSessionWithIdentity()
// ---------------------------------------------------------------------------

describe("browserAutomation.sessions.createWithIdentity()", () => {
  it("POSTs /v1/sessions/with-identity with identityId in body", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          sessionId: "sess-ident",
          cdpUrl: "ws://cdp.example.com/ident",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        }),
    ]);

    const result = await browserAutomation.createSessionWithIdentity(
      { identityId: "id-abc" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/sessions/with-identity`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      identityId: "id-abc",
    });
    expect(result.sessionId).toBe("sess-ident");
  });

  it("throws BrowserAutomationHttpError (before fetch) when identityId is empty", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      browserAutomation.createSessionWithIdentity(
        { identityId: "" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws BrowserAutomationHttpError (before fetch) when identityId is missing", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      browserAutomation.createSessionWithIdentity(
        { identityId: undefined as unknown as string },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws BrowserAutomationHttpError on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () => new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    ]);

    await expect(
      browserAutomation.createSessionWithIdentity(
        { identityId: "id-gone" },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 404 });
  });
});

// ---------------------------------------------------------------------------
// sessions.close / closeSession()
// ---------------------------------------------------------------------------

describe("browserAutomation.sessions.close()", () => {
  it("DELETEs /v1/sessions/:sessionId and returns mapped SessionSettlement", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          sessionId: "sess-123",
          settled: true,
          capturedAmountUsd: "0.05",
          creditsUsed: 5,
        }),
    ]);

    const result = await browserAutomation.closeSession(
      "sess-123",
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/sessions/sess-123`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");

    expect(result.sessionId).toBe("sess-123");
    expect(result.settled).toBe(true);
    expect(result.capturedAmountUsd).toBe("0.05");
    expect(result.creditsUsed).toBe(5);
  });

  it("URL-encodes the sessionId in the path", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ sessionId: "sess/slash", settled: true }),
    ]);

    await browserAutomation.closeSession("sess/slash", transport, BASE);
    expect(calls[0]!.url).toBe(`${BASE}/v1/sessions/sess%2Fslash`);
  });

  it("maps snake_case settlement fields to camelCase", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          session_id: "sess-snake",
          settled: true,
          captured_amount_usd: "0.10",
          credits_used: 10,
        }),
    ]);

    const result = await browserAutomation.closeSession(
      "sess-snake",
      transport,
      BASE,
    );

    expect(result.sessionId).toBe("sess-snake");
    expect(result.capturedAmountUsd).toBe("0.10");
    expect(result.creditsUsed).toBe(10);
    expect((result as Record<string, unknown>)["captured_amount_usd"]).toBeUndefined();
    expect((result as Record<string, unknown>)["credits_used"]).toBeUndefined();
  });

  it("omits capturedAmountUsd and creditsUsed when not in the response", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ sessionId: "sess-min", settled: false }),
    ]);

    const result = await browserAutomation.closeSession(
      "sess-min",
      transport,
      BASE,
    );
    expect(result.capturedAmountUsd).toBeUndefined();
    expect(result.creditsUsed).toBeUndefined();
  });

  it("throws BrowserAutomationHttpError on 404 (session not found)", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "session not found" }), {
          status: 404,
        }),
    ]);

    await expect(
      browserAutomation.closeSession("no-such-session", transport, BASE),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 404 });
  });
});

// ---------------------------------------------------------------------------
// screenshot() — one-shot and session modes
// ---------------------------------------------------------------------------

describe("browserAutomation.screenshot() — one-shot mode", () => {
  it("POSTs /v1/tools/screenshot with url and returns mapped Screenshot", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          url: "/v1/tools/screenshots/abc123.png",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
    ]);

    const result = await browserAutomation.screenshot(
      { url: "https://example.com" },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/tools/screenshot`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.url).toBe("https://example.com");

    // Relative URL resolved to absolute:
    expect(result.url).toBe(`${BASE}/v1/tools/screenshots/abc123.png`);
    expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
  });

  it("passes an already-absolute url through unchanged", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          url: "https://cdn.example.com/screenshots/abc123.png",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
    ]);

    const result = await browserAutomation.screenshot(
      { url: "https://example.com" },
      transport,
      BASE,
    );
    expect(result.url).toBe("https://cdn.example.com/screenshots/abc123.png");
  });

  it("maps fullPage → scroll_all_content + capture_full_height in the request body", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      { url: "https://example.com", fullPage: true },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.scroll_all_content).toBe(true);
    expect(body.capture_full_height).toBe(true);
    expect(body).not.toHaveProperty("fullPage");
  });

  it("does NOT send scroll_all_content when fullPage is false/omitted", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      { url: "https://example.com", fullPage: false },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty("scroll_all_content");
    expect(body).not.toHaveProperty("capture_full_height");
  });

  it("maps imageQuality → image_quality in the request body", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      { url: "https://example.com", imageQuality: 85, format: "jpeg" },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.image_quality).toBe(85);
    expect(body).not.toHaveProperty("imageQuality");
  });

  it("maps waitMs → wait in the request body", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      { url: "https://example.com", waitMs: 500 },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.wait).toBe(500);
    expect(body).not.toHaveProperty("waitMs");
  });

  it("passes width, height, format through as-is", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      {
        url: "https://example.com",
        width: 1280,
        height: 800,
        format: "jpeg",
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.width).toBe(1280);
    expect(body.height).toBe(800);
    expect(body.format).toBe("jpeg");
  });

  it("spreads params FIRST so they cannot clobber the url field", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      {
        url: "https://real.example.com",
        params: { url: "https://injected.example.com", extraFlag: true },
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.url).toBe("https://real.example.com");
    expect(body.extraFlag).toBe(true);
  });

  it("throws BrowserAutomationHttpError (before fetch) when url is missing in one-shot mode", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      browserAutomation.screenshot({}, transport, BASE),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws BrowserAutomationHttpError (before fetch) when url is empty in one-shot mode", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      browserAutomation.screenshot({ url: "" }, transport, BASE),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws BrowserAutomationHttpError on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "bad url" }), { status: 400 }),
    ]);

    await expect(
      browserAutomation.screenshot({ url: "https://example.com" }, transport, BASE),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
  });
});

describe("browserAutomation.screenshot() — session mode", () => {
  it("sends sessionId in the body and does NOT require url", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          url: "/v1/tools/screenshots/session-shot.png",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
    ]);

    const result = await browserAutomation.screenshot(
      { sessionId: "sess-123" },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.sessionId).toBe("sess-123");
    expect(body.url).toBeUndefined();
    expect(result.url).toBe(`${BASE}/v1/tools/screenshots/session-shot.png`);
  });

  it("sends both sessionId and url when both are provided", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({ url: "/v1/tools/screenshots/abc.png", expiresAt: "2099-01-01T00:00:00Z" }),
    ]);

    await browserAutomation.screenshot(
      { sessionId: "sess-123", url: "https://example.com/page" },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.sessionId).toBe("sess-123");
    expect(body.url).toBe("https://example.com/page");
  });
});

// ---------------------------------------------------------------------------
// identities.create / createIdentity()
// ---------------------------------------------------------------------------

describe("browserAutomation.identities.create()", () => {
  it("POSTs /v1/identities with the input and returns mapped Identity", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          id: "ident-abc",
          status: "active",
          name: "My Account",
        }),
    ]);

    const result = await browserAutomation.createIdentity(
      {
        source: "https://app.example.com/login",
        name: "My Account",
        credentials: [
          {
            type: "username_password",
            username: "user@example.com",
            password: "secret",
          },
        ],
      },
      transport,
      BASE,
    );

    expect(calls[0]!.url).toBe(`${BASE}/v1/identities`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.source).toBe("https://app.example.com/login");
    expect(body.name).toBe("My Account");
    expect(body.credentials).toHaveLength(1);

    expect(result.id).toBe("ident-abc");
    expect(result.status).toBe("active");
    expect(result.name).toBe("My Account");
  });

  it("omits optional fields from the body when not provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ id: "ident-min", status: "pending" }),
    ]);

    await browserAutomation.createIdentity(
      {
        source: "https://app.example.com/login",
        credentials: [{ type: "profile", name: "default" }],
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("shouldCache");
    expect(body).not.toHaveProperty("metadata");
  });

  it("includes optional fields when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ id: "ident-full", status: "active" }),
    ]);

    await browserAutomation.createIdentity(
      {
        source: "https://app.example.com/login",
        credentials: [{ type: "profile", name: "default" }],
        shouldCache: true,
        metadata: { env: "test" },
      },
      transport,
      BASE,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.shouldCache).toBe(true);
    expect(body.metadata).toEqual({ env: "test" });
  });

  it("throws BrowserAutomationHttpError (before fetch) when source is empty", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      browserAutomation.createIdentity(
        { source: "", credentials: [] },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws BrowserAutomationHttpError (before fetch) when source is missing", async () => {
    const { transport, calls } = makeTransport([() => jsonResponse({})]);

    await expect(
      browserAutomation.createIdentity(
        { source: undefined as unknown as string, credentials: [] },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
    expect(calls.length).toBe(0);
  });

  it("throws BrowserAutomationHttpError on a non-2xx response", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ message: "bad request" }), { status: 400 }),
    ]);

    await expect(
      browserAutomation.createIdentity(
        {
          source: "https://app.example.com/login",
          credentials: [{ type: "profile", name: "default" }],
        },
        transport,
        BASE,
      ),
    ).rejects.toMatchObject({ name: "BrowserAutomationHttpError", status: 400 });
  });
});

// ---------------------------------------------------------------------------
// withSession()
// ---------------------------------------------------------------------------

describe("browserAutomation.withSession()", () => {
  function makeSessionTransport(sessionId = "sess-ws") {
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

      if (url.endsWith("/v1/sessions") && init.method === "POST") {
        return jsonResponse({
          sessionId,
          cdpUrl: `ws://cdp.example.com/${sessionId}`,
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        });
      }
      if (url.includes("/v1/sessions/") && init.method === "DELETE") {
        return jsonResponse({ sessionId, settled: true, capturedAmountUsd: "0.05" });
      }
      if (url.endsWith("/v1/tools/screenshot") && init.method === "POST") {
        return jsonResponse({
          url: "/v1/tools/screenshots/shot.png",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
    }) as typeof globalThis.fetch;

    return {
      transport: new Transport({ apiKey: "test-key", fetch: fetchMock }),
      calls,
    };
  }

  it("opens a session, calls fn with an ActiveSession, closes on success", async () => {
    const { transport, calls } = makeSessionTransport("sess-ws-ok");

    const result = await browserAutomation.withSession(
      async (session) => {
        expect(session.sessionId).toBe("sess-ws-ok");
        expect(typeof session.screenshot).toBe("function");
        return "done";
      },
      undefined,
      transport,
      BASE,
    );

    expect(result).toBe("done");
    // open + close
    expect(calls.some((c) => c.url.endsWith("/v1/sessions") && c.init.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/v1/sessions/") && c.init.method === "DELETE")).toBe(true);
  });

  it("closes the session even when fn throws", async () => {
    const { transport, calls } = makeSessionTransport("sess-ws-throw");

    await expect(
      browserAutomation.withSession(
        async () => {
          throw new Error("step failed");
        },
        undefined,
        transport,
        BASE,
      ),
    ).rejects.toThrow("step failed");

    // close was still called
    expect(calls.some((c) => c.url.includes("/v1/sessions/sess-ws-throw") && c.init.method === "DELETE")).toBe(true);
  });

  it("session-bound screenshot injects sessionId automatically", async () => {
    const { transport, calls } = makeSessionTransport("sess-ws-shot");

    await browserAutomation.withSession(
      async (session) => {
        await session.screenshot({ url: "https://example.com" });
      },
      undefined,
      transport,
      BASE,
    );

    const shotCall = calls.find((c) => c.url.endsWith("/v1/tools/screenshot"));
    expect(shotCall).toBeDefined();
    const body = JSON.parse(shotCall!.init.body as string);
    expect(body.sessionId).toBe("sess-ws-shot");
  });

  it("uses createSessionWithIdentity when identityId is provided", async () => {
    let createUrl: string | undefined;
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

      if (url.includes("/v1/sessions") && init.method === "POST") {
        createUrl = url;
        return jsonResponse({
          sessionId: "sess-ident",
          cdpUrl: "ws://cdp.example.com/ident",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        });
      }
      if (url.includes("/v1/sessions/") && init.method === "DELETE") {
        return jsonResponse({ sessionId: "sess-ident", settled: true });
      }
      throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
    }) as typeof globalThis.fetch;

    const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });

    await browserAutomation.withSession(
      async (session) => {
        expect(session.sessionId).toBe("sess-ident");
      },
      { identityId: "id-xyz" },
      transport,
      BASE,
    );

    expect(createUrl).toBe(`${BASE}/v1/sessions/with-identity`);
  });

  it("propagates the original error even if close also fails", async () => {
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
      if (url.endsWith("/v1/sessions") && init.method === "POST") {
        return jsonResponse({
          sessionId: "sess-err",
          cdpUrl: "ws://cdp.example.com/err",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        });
      }
      if (url.includes("/v1/sessions/") && init.method === "DELETE") {
        return new Response("server error", { status: 500 });
      }
      throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
    }) as typeof globalThis.fetch;

    const transport = new Transport({ apiKey: "test-key", fetch: fetchMock });

    await expect(
      browserAutomation.withSession(
        async () => {
          throw new Error("original error");
        },
        undefined,
        transport,
        BASE,
      ),
    ).rejects.toThrow("original error");
  });
});

// ---------------------------------------------------------------------------
// Client wiring + credential
// ---------------------------------------------------------------------------

describe("browserAutomation — client wiring + credential", () => {
  it("createClient().browserAutomation routes all operations with the credential", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      if (url.endsWith("/v1/sessions") && init.method === "POST") {
        return jsonResponse({
          sessionId: "s",
          cdpUrl: "ws://x",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        });
      }
      if (url.includes("/v1/sessions/") && init.method === "DELETE") {
        return jsonResponse({ sessionId: "s", settled: true });
      }
      if (url.includes("/v1/sessions/with-identity")) {
        return jsonResponse({
          sessionId: "s",
          cdpUrl: "ws://x",
          expiresAt: "2099-01-01T00:00:00Z",
          maxDurationSec: 1200,
        });
      }
      if (url.endsWith("/v1/tools/screenshot")) {
        return jsonResponse({
          url: "/v1/tools/screenshots/abc.png",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      if (url.endsWith("/v1/identities")) {
        return jsonResponse({ id: "ident", status: "active" });
      }
      throw new Error(`Unmatched mock fetch: ${init.method ?? "GET"} ${url}`);
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "my-key", fetch: fetchMock });
    await sapiom.browserAutomation.sessions.create();
    await sapiom.browserAutomation.sessions.createWithIdentity({ identityId: "id-1" });
    await sapiom.browserAutomation.sessions.close("s");
    await sapiom.browserAutomation.screenshot({ url: "https://example.com" });
    await sapiom.browserAutomation.identities.create({
      source: "https://app.example.com/login",
      credentials: [{ type: "profile", name: "default" }],
    });

    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(headerOf(c, "x-sapiom-api-key")).toBe("my-key");
    }

    expect(calls.some((c) => c.url.includes("/v1/sessions"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/v1/tools/screenshot"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/v1/identities"))).toBe(true);
  });

  it("throws a clear error when no tenant credential is configured", async () => {
    const saved = process.env["SAPIOM_API_KEY"];
    delete process.env["SAPIOM_API_KEY"];
    try {
      const transport = new Transport({
        fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
      });
      await expect(
        browserAutomation.createSession(transport, BASE),
      ).rejects.toThrow(/no tenant credential/i);
    } finally {
      if (saved !== undefined) process.env["SAPIOM_API_KEY"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Namespace exports
// ---------------------------------------------------------------------------

describe("browserAutomation — namespace exports", () => {
  it("sessions.create is the same function as createSession", () => {
    expect(browserAutomation.sessions.create).toBe(
      browserAutomation.createSession,
    );
  });

  it("sessions.createWithIdentity is the same function as createSessionWithIdentity", () => {
    expect(browserAutomation.sessions.createWithIdentity).toBe(
      browserAutomation.createSessionWithIdentity,
    );
  });

  it("sessions.close is the same function as closeSession", () => {
    expect(browserAutomation.sessions.close).toBe(
      browserAutomation.closeSession,
    );
  });

  it("identities.create is the same function as createIdentity", () => {
    expect(browserAutomation.identities.create).toBe(
      browserAutomation.createIdentity,
    );
  });
});

// ---------------------------------------------------------------------------
// BrowserAutomationHttpError
// ---------------------------------------------------------------------------

describe("BrowserAutomationHttpError", () => {
  it("carries status and body and is instanceof Error", () => {
    const err = new BrowserAutomationHttpError("something went wrong", 422, {
      message: "invalid",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BrowserAutomationHttpError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ message: "invalid" });
    expect(err.name).toBe("BrowserAutomationHttpError");
  });
});
