import { createClient } from "../index.js";
import { Transport } from "../_client/index.js";
import { scrape, webSearch, SearchHttpError } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers — the capability fn is tested directly with a real Transport wired to
// a scripted fetch mock, so URL/method/header/body assertions are exact and we
// verify the Transport injects the tenant credential.
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
// search.scrape()
// ---------------------------------------------------------------------------

describe("search.scrape()", () => {
  it("POSTs just the url + credential (default formats omitted) and maps the wire result", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          success: true,
          data: {
            markdown: "# Hello\n\nworld",
            metadata: {
              title: "Hello",
              description: "a page",
              language: "en",
              sourceURL: "https://example.com",
              statusCode: 200,
              error: null,
            },
          },
        }),
    ]);

    const out = await scrape({ url: "https://example.com" }, transport, BASE);

    // metadata.sourceURL → sourceUrl; the {success} wrapper is dropped; url echoes input.
    expect(out).toEqual({
      url: "https://example.com",
      markdown: "# Hello\n\nworld",
      metadata: {
        title: "Hello",
        description: "a page",
        language: "en",
        sourceUrl: "https://example.com",
        statusCode: 200,
      },
    });
    expect(calls[0]!.url).toBe(`${BASE}/v2/scrape`);
    expect(calls[0]!.init.method).toBe("POST");
    // scrape sends the default credential header, NOT x-api-key (guards against
    // regression from the per-destination auth-header change).
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // formats is omitted entirely when the caller didn't pass it.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      url: "https://example.com",
    });
  });

  it("forwards formats, onlyMainContent, and waitFor when provided", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ success: true, data: { metadata: {} } }),
    ]);

    await scrape(
      {
        url: "https://example.com",
        formats: ["markdown", "html", "links"],
        onlyMainContent: true,
        waitFor: 1500,
      },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      url: "https://example.com",
      formats: ["markdown", "html", "links"],
      onlyMainContent: true,
      waitFor: 1500,
    });
  });

  it("forwards onlyMainContent: false (a meaningful value, not dropped)", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ success: true, data: { metadata: {} } }),
    ]);

    await scrape(
      { url: "https://example.com", onlyMainContent: false },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      url: "https://example.com",
      onlyMainContent: false,
    });
  });

  it("treats null optionals (JS caller bypassing types) as absent in the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ success: true, data: { metadata: {} } }),
    ]);

    await scrape(
      {
        url: "https://example.com",
        formats: null as unknown as undefined,
        onlyMainContent: null as unknown as undefined,
        waitFor: null as unknown as undefined,
      },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      url: "https://example.com",
    });
  });

  it("maps every requested format and the page links", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          success: true,
          data: {
            markdown: "md",
            html: "<p>h</p>",
            rawHtml: "<html>raw</html>",
            screenshot: "https://shots/x.png",
            links: ["https://a", "https://b"],
            metadata: { title: "T", sourceURL: "https://example.com" },
          },
        }),
    ]);

    const out = await scrape(
      {
        url: "https://example.com",
        formats: ["markdown", "html", "rawHtml", "screenshot", "links"],
      },
      transport,
      BASE,
    );

    expect(out.html).toBe("<p>h</p>");
    expect(out.rawHtml).toBe("<html>raw</html>");
    expect(out.screenshot).toBe("https://shots/x.png");
    expect(out.links).toEqual(["https://a", "https://b"]);
  });

  it("collapses array-valued title/description to a single string", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          success: true,
          data: {
            markdown: "x",
            metadata: {
              title: ["First Title", "Second Title"],
              description: ["First desc", "Second desc"],
              sourceURL: "https://example.com",
            },
          },
        }),
    ]);

    const out = await scrape({ url: "https://example.com" }, transport, BASE);

    expect(out.metadata.title).toBe("First Title");
    expect(out.metadata.description).toBe("First desc");
  });

  it("drops the success wrapper and extra fields; omits absent metadata fields", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          success: true,
          data: {
            markdown: "x",
            // extra fields that must not surface on the result
            branding: { foo: "bar" },
            changeTracking: null,
            warning: null,
            actions: null,
            metadata: { sourceURL: "https://example.com", statusCode: 200 },
          },
        }),
    ]);

    const out = await scrape({ url: "https://example.com" }, transport, BASE);

    expect(out).toEqual({
      url: "https://example.com",
      markdown: "x",
      metadata: { sourceUrl: "https://example.com", statusCode: 200 },
    });
    // no leaked extras and no `success` key on the result.
    expect(out).not.toHaveProperty("success");
    expect(out).not.toHaveProperty("branding");
    expect(out).not.toHaveProperty("changeTracking");
    // title/description were absent on the wire → absent on the surface.
    expect(out.metadata).not.toHaveProperty("title");
    expect(out.metadata).not.toHaveProperty("description");
  });

  it("returns an empty metadata object when the wire omits data/metadata entirely", async () => {
    const { transport } = makeTransport([
      () => jsonResponse({ success: true }),
    ]);

    const out = await scrape({ url: "https://example.com" }, transport, BASE);

    expect(out).toEqual({
      url: "https://example.com",
      metadata: {},
    });
  });

  it("treats null fields (unrequested formats / empty metadata) as absent, not null", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          success: true,
          data: {
            markdown: "# Hello",
            // unrequested formats arrive explicitly null
            html: null,
            rawHtml: null,
            screenshot: null,
            links: null,
            metadata: {
              title: "Hello",
              description: null,
              language: null,
              sourceURL: "https://example.com",
              statusCode: 200,
              error: null,
            },
          },
        }),
    ]);

    const out = await scrape({ url: "https://example.com" }, transport, BASE);

    // null formats are omitted, not surfaced as `field: null`.
    expect(out).toEqual({
      url: "https://example.com",
      markdown: "# Hello",
      metadata: {
        title: "Hello",
        sourceUrl: "https://example.com",
        statusCode: 200,
      },
    });
    expect(out).not.toHaveProperty("html");
    expect(out).not.toHaveProperty("links");
    expect(out.metadata).not.toHaveProperty("description");
    expect(out.metadata).not.toHaveProperty("language");
  });

  it("throws SearchHttpError (with status + body) on a non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ success: false, error: "Bad Request" }), {
          status: 400,
        }),
    ]);

    await expect(
      scrape({ url: "https://example.com" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "SearchHttpError",
      status: 400,
      body: { error: "Bad Request" },
    });
    await expect(
      scrape({ url: "https://example.com" }, transport, BASE),
    ).rejects.toBeInstanceOf(SearchHttpError);
  });
});

// ---------------------------------------------------------------------------
// createClient().search.scrape — binding
// ---------------------------------------------------------------------------

describe("createClient().search.scrape", () => {
  it("binds to the client's credential + default host, mapping the result", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        success: true,
        data: {
          markdown: "ok",
          metadata: { sourceURL: "https://example.com" },
        },
      });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
    const out = await sapiom.search.scrape({ url: "https://example.com" });

    expect(out.markdown).toBe("ok");
    expect(out.metadata.sourceUrl).toBe("https://example.com");
    expect(calls[0]!.url).toBe(
      "https://firecrawl.services.sapiom.ai/v2/scrape",
    );
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBe("client-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      url: "https://example.com",
    });
  });
});

// ---------------------------------------------------------------------------
// search.webSearch()
// ---------------------------------------------------------------------------

describe("search.webSearch()", () => {
  it("POSTs query + default intent, sends x-api-key (not x-sapiom-api-key), and maps the result", async () => {
    const { transport, calls } = makeTransport([
      () =>
        jsonResponse({
          query: "llm agents",
          answer: "An LLM agent is …",
          results: [
            {
              title: "Agents 101",
              url: "https://example.com/a",
              snippet: "intro",
            },
          ],
        }),
    ]);

    const out = await webSearch({ query: "llm agents" }, transport, BASE);

    expect(out).toEqual({
      query: "llm agents",
      answer: "An LLM agent is …",
      results: [
        { title: "Agents 101", url: "https://example.com/a", snippet: "intro" },
      ],
    });
    expect(calls[0]!.url).toBe(`${BASE}/v1/capabilities/web.search`);
    expect(calls[0]!.init.method).toBe("POST");
    // This destination authenticates via x-api-key — the SDK must send that
    // header here, and must NOT send the default x-sapiom-api-key for this call.
    expect(headerOf(calls[0]!, "x-api-key")).toBe("test-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    // intent defaults to "answer"; depth omitted when not provided.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "llm agents",
      intent: "answer",
    });
  });

  it("forwards depth and an explicit intent", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ query: "q", results: [] }),
    ]);

    await webSearch(
      { query: "q", depth: "deep", intent: "links" },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      depth: "deep",
      intent: "links",
    });
  });

  it("defaults intent to answer even when depth is set", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ query: "q", results: [] }),
    ]);

    await webSearch({ query: "q", depth: "standard" }, transport, BASE);

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      depth: "standard",
      intent: "answer",
    });
  });

  it("treats a null depth (JS caller bypassing types) as absent in the body", async () => {
    const { transport, calls } = makeTransport([
      () => jsonResponse({ query: "q", results: [] }),
    ]);

    await webSearch(
      { query: "q", depth: null as unknown as undefined },
      transport,
      BASE,
    );

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      intent: "answer",
    });
  });

  it("omits answer when the wire has none (intent:'links') and defaults missing results to []", async () => {
    const { transport } = makeTransport([() => jsonResponse({ query: "q" })]);

    const out = await webSearch(
      { query: "q", intent: "links" },
      transport,
      BASE,
    );

    expect(out).toEqual({ query: "q", results: [] });
    expect(out).not.toHaveProperty("answer");
  });

  it("drops unknown extra fields from the response and result rows (defensive)", async () => {
    const { transport } = makeTransport([
      () =>
        jsonResponse({
          query: "q",
          answer: "a",
          // an unexpected top-level field that must never reach a caller
          extraTopLevel: "should-not-surface",
          results: [
            {
              title: "T",
              url: "https://example.com",
              snippet: "s",
              extraOnRow: "should-not-surface",
            },
          ],
        }),
    ]);

    const out = await webSearch({ query: "q" }, transport, BASE);

    // The result is built from known fields only, so any extra field is dropped.
    expect(out).toEqual({
      query: "q",
      answer: "a",
      results: [{ title: "T", url: "https://example.com", snippet: "s" }],
    });
    expect(out).not.toHaveProperty("extraTopLevel");
    expect(out.results[0]).not.toHaveProperty("extraOnRow");
  });

  it("falls back to the input query when the wire omits it", async () => {
    const { transport } = makeTransport([() => jsonResponse({ results: [] })]);

    const out = await webSearch({ query: "fallback" }, transport, BASE);

    expect(out.query).toBe("fallback");
  });

  it("throws SearchHttpError (with status + body) on a non-2xx", async () => {
    const { transport } = makeTransport([
      () =>
        new Response(JSON.stringify({ error: "Bad Request" }), {
          status: 400,
        }),
    ]);

    await expect(
      webSearch({ query: "q" }, transport, BASE),
    ).rejects.toMatchObject({
      name: "SearchHttpError",
      status: 400,
      body: { error: "Bad Request" },
    });
    await expect(
      webSearch({ query: "q" }, transport, BASE),
    ).rejects.toBeInstanceOf(SearchHttpError);
  });
});

// ---------------------------------------------------------------------------
// createClient().search.webSearch — binding
// ---------------------------------------------------------------------------

describe("createClient().search.webSearch", () => {
  it("binds to the client's credential + default host, sending x-api-key", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ): Promise<Response> => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        query: "q",
        answer: "a",
        results: [{ title: "T", url: "https://example.com", snippet: "s" }],
      });
    }) as typeof globalThis.fetch;

    const sapiom = createClient({ apiKey: "client-key", fetch: fetchMock });
    const out = await sapiom.search.webSearch({ query: "q" });

    expect(out.answer).toBe("a");
    expect(out.results[0]!.url).toBe("https://example.com");
    expect(calls[0]!.url).toBe(
      "https://api.sapiom.ai/v1/capabilities/web.search",
    );
    expect(headerOf(calls[0]!, "x-api-key")).toBe("client-key");
    expect(headerOf(calls[0]!, "x-sapiom-api-key")).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "q",
      intent: "answer",
    });
  });
});
