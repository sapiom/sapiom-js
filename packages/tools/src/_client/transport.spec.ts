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
