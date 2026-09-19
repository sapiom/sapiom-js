import { runInNewContext } from "node:vm";

import { Transport } from "./index.js";
import { SapiomCallError, readSapiomCall } from "./sapiom-call.js";

const transportWith = (
  impl: (url: string, init: RequestInit) => Promise<Response>,
): Transport =>
  new Transport({
    apiKey: "test-key",
    fetch: ((input: unknown, init: RequestInit = {}) =>
      impl(String(input), init)) as typeof globalThis.fetch,
  });

describe("Transport.request()", () => {
  it("parses a 2xx JSON body", async () => {
    const transport = transportWith(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await expect(
      transport.request("https://api.sapiom.ai/v2/sessions"),
    ).resolves.toEqual({ ok: true });
  });

  it("throws a SapiomCallError on a non-2xx, message byte-for-byte unchanged", async () => {
    const url = "https://api.sapiom.ai/v2/anthropic/v1/messages";
    const transport = transportWith(
      async () => new Response("upstream down", { status: 502 }),
    );

    const err = await transport
      .request(url, { method: "POST" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SapiomCallError);
    expect(err).toBeInstanceOf(Error);
    expect((err as SapiomCallError).message).toBe(
      `POST ${url} → 502 upstream down`,
    );
    expect((err as SapiomCallError).status).toBe(502);
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "anthropic",
      status: 502,
    });
  });

  it("records a deterministic status too", async () => {
    const transport = transportWith(
      async () => new Response("no such session", { status: 404 }),
    );

    const err = await transport
      .request("https://api.sapiom.ai/v2/sessions/abc")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "sessions",
      status: 404,
    });
  });
});

describe("Transport.fetch()", () => {
  it("records a connection that never produced a response", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const thrown = Object.assign(new TypeError("fetch failed"), { cause });
    const transport = transportWith(async () => {
      throw thrown;
    });

    const err = await transport
      .fetch("https://api.sapiom.ai/v1/capabilities/web.search")
      .then(() => null)
      .catch((e: unknown) => e);

    // The same instance propagates: nothing is wrapped, so an author's
    // `catch` sees exactly what fetch threw.
    expect(err).toBe(thrown);
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "web.search",
      network: true,
    });
    expect(readSapiomCall(err)).not.toHaveProperty("status");
  });

  it("leaves a local serialization failure unmarked", async () => {
    // `attributionToHeaders` JSON-stringifies caller metadata. A circular value
    // throws a TypeError before fetch is ever called: deterministic, so marking
    // it transient would buy three attempts at something that cannot succeed.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const transport = new Transport({
      apiKey: "test-key",
      attribution: { metadata: circular },
      fetch: (async () => new Response("{}")) as typeof globalThis.fetch,
    });

    const err = await transport
      .fetch("https://api.sapiom.ai/v1/memory")
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe("TypeError");
    expect(readSapiomCall(err)).toBeUndefined();
  });

  it.each([
    ["a GET with a body", { method: "GET", body: "x" }],
    ["an invalid method", { method: "BAD METHOD" }],
  ])("leaves %s unmarked", async (_label, init) => {
    // `fetch` rejects these while CONSTRUCTING the request, with the same bare
    // TypeError a dead connection gives. They carry no `cause`; a transport
    // failure always does.
    const transport = transportWith(async () => {
      throw Object.assign(
        new TypeError("Request with GET/HEAD method cannot have body."),
        {},
      );
    });

    const err = await transport
      .fetch("https://api.sapiom.ai/v1/memory", init)
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe("TypeError");
    expect(readSapiomCall(err)).toBeUndefined();
  });

  it("leaves an abort whose reason is a TypeError unmarked", async () => {
    const controller = new AbortController();
    controller.abort(new TypeError("cancelled"));
    const transport = transportWith(async () => {
      throw controller.signal.reason as Error;
    });

    const err = await transport
      .fetch("https://api.sapiom.ai/v1/memory", { signal: controller.signal })
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as Error).message).toBe("cancelled");
    expect(readSapiomCall(err)).toBeUndefined();
  });

  it("records a network rejection minted in another realm", async () => {
    // The artifact bundle is handed an injected fetch, so the rejection can come
    // from a different realm, where `instanceof TypeError` is false. Recognition
    // has to be structural or the fact is silently never recorded.
    const foreign = runInNewContext(
      'Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED") })',
    ) as Error;
    expect(foreign).not.toBeInstanceOf(TypeError);
    const transport = transportWith(async () => {
      throw foreign;
    });

    const err = await transport
      .fetch("https://api.sapiom.ai/v1/capabilities/web.search")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBe(foreign);
    expect(readSapiomCall(err)).toEqual({
      version: 1,
      capability: "web.search",
      network: true,
    });
  });

  // `fetch` rejects with a bare TypeError for a malformed request AND for a dead
  // connection. Anything deterministic has to be raised before the call, or it
  // ships as SAPIOM_CALL_TRANSIENT and buys three attempts at the impossible.
  it.each([
    ["a malformed URL", "not a url", {}],
    [
      "an invalid header name",
      "https://api.sapiom.ai/v1/memory",
      { "bad header": "v" },
    ],
    [
      "an invalid header value",
      "https://api.sapiom.ai/v1/memory",
      { "x-a": "bad\nvalue" },
    ],
  ])("leaves %s unmarked", async (_label, url, headers) => {
    let called = false;
    const transport = new Transport({
      apiKey: "test-key",
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof globalThis.fetch,
    });

    const err = await transport
      .fetch(url, { headers })
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe("TypeError");
    expect(readSapiomCall(err)).toBeUndefined();
    // Raised before the call, so nothing was ever sent.
    expect(called).toBe(false);
  });

  it("still sends a request whose URL and headers are valid", async () => {
    const transport = transportWith(
      async () => new Response("{}", { status: 200 }),
    );

    await expect(
      transport.fetch("https://api.sapiom.ai/v1/memory", {
        headers: { "x-custom": "ok" },
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("leaves a deliberate abort unmarked", async () => {
    const transport = transportWith(async () => {
      throw new DOMException("Aborted", "AbortError");
    });

    const err = await transport
      .fetch("https://api.sapiom.ai/v1/memory")
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe("AbortError");
    expect(readSapiomCall(err)).toBeUndefined();
  });

  it("returns a non-2xx response for the caller to inspect, unmarked", async () => {
    const transport = transportWith(
      async () => new Response("nope", { status: 503 }),
    );

    const res = await transport.fetch("https://api.sapiom.ai/v1/memory");

    expect(res.status).toBe(503);
  });
});
