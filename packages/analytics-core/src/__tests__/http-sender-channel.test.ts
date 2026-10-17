import { ALLOW_INSECURE_HTTP_ENV } from "../credential.js";
import { HttpSender } from "../http-sender.js";
import type { FetchRequestInit, FetchResponseLike } from "../types.js";

type Call = { url: string; init: FetchRequestInit };

function senderWith(
  endpoint: string,
  responses: FetchResponseLike[],
  apiKey: string | null = "sk_live",
) {
  const calls: Call[] = [];
  const debug: Array<[string, unknown]> = [];
  const sender = new HttpSender({
    endpoint,
    apiKey: apiKey ?? undefined,
    debug: (message, detail) => debug.push([message, detail]),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift() ?? { ok: true, status: 202 };
    },
  });
  return { sender, calls, debug };
}

const redirectTo = (location: string, status = 307): FetchResponseLike => ({
  ok: false,
  status,
  headers: new Headers({ location }),
});

const keyOf = (call: Call) => call.init.headers["x-sapiom-api-key"];

describe("HttpSender credential channel", () => {
  const ORIGINAL = process.env[ALLOW_INSECURE_HTTP_ENV];
  beforeEach(() => {
    delete process.env[ALLOW_INSECURE_HTTP_ENV];
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env[ALLOW_INSECURE_HTTP_ENV];
    else process.env[ALLOW_INSECURE_HTTP_ENV] = ORIGINAL;
  });

  it("sends the batch without the key to an endpoint that is not https or loopback", async () => {
    const { sender, calls, debug } = senderWith(
      "http://collector.internal/v1/analytics/collector?t=secret",
      [{ ok: true, status: 202 }],
    );
    await expect(sender.send([])).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
    expect(keyOf(calls[0])).toBeUndefined();
    expect(calls[0].init.body).toBe('{"events":[]}');
    expect(debug).toEqual([
      [
        "endpoint is not https or loopback; batch sent without the API key",
        "http://collector.internal",
      ],
    ]);
  });

  it.each([
    ["https", "https://collector.example/c"],
    ["loopback", "http://127.0.0.1:4318/c"],
  ])("carries the key over %s", async (_label, endpoint) => {
    const { sender, calls, debug } = senderWith(endpoint, []);
    await expect(sender.send([])).resolves.toBe("ok");
    expect(keyOf(calls[0])).toBe("sk_live");
    expect(calls[0].init.redirect).toBe("manual");
    expect(debug).toEqual([]);
  });

  it("carries the key over plain http once opted in through the env", async () => {
    process.env[ALLOW_INSECURE_HTTP_ENV] = "1";
    const { sender, calls } = senderWith("http://collector.internal/c", []);
    await sender.send([]);
    expect(keyOf(calls[0])).toBe("sk_live");
  });

  it("without a key, sends no header and says nothing", async () => {
    const { sender, calls, debug } = senderWith(
      "http://collector.internal/c",
      [],
      null,
    );
    await expect(sender.send([])).resolves.toBe("ok");
    expect("x-sapiom-api-key" in calls[0].init.headers).toBe(false);
    expect(debug).toEqual([]);
  });

  it("drops the key on a redirect to another origin, resending the body", async () => {
    const { sender, calls } = senderWith("https://collector.example/c", [
      redirectTo("https://other.example/c"),
      { ok: false, status: 429 },
    ]);
    await expect(sender.send([])).resolves.toBe("retry");
    expect(calls.map((c) => c.url)).toEqual([
      "https://collector.example/c",
      "https://other.example/c",
    ]);
    expect(calls.map(keyOf)).toEqual(["sk_live", undefined]);
    expect(calls[1].init.body).toBe('{"events":[]}');
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("keeps the key on a same-origin redirect", async () => {
    const { sender, calls } = senderWith("https://collector.example/c", [
      redirectTo("/v2/c"),
      { ok: true, status: 202 },
    ]);
    await expect(sender.send([])).resolves.toBe("ok");
    expect(calls.map(keyOf)).toEqual(["sk_live", "sk_live"]);
  });

  it("drops the batch, without a second call, when a redirect leaves https", async () => {
    const { sender, calls, debug } = senderWith("https://collector.example/c", [
      redirectTo("http://evil.internal/c"),
    ]);
    await expect(sender.send([])).resolves.toBe("drop");
    expect(calls).toHaveLength(1);
    expect(debug).toHaveLength(1);
    expect(debug[0][0]).toBe("collector redirect refused; batch dropped");
    expect(String(debug[0][1])).toContain("http://evil.internal");
  });

  it("treats a redirect status with no headers as the final response", async () => {
    const { sender, calls } = senderWith("https://collector.example/c", [
      { ok: false, status: 307 },
    ]);
    await expect(sender.send([])).resolves.toBe("drop");
    expect(calls).toHaveLength(1);
  });

  it("still retries a failed connection", async () => {
    const sender = new HttpSender({
      endpoint: "https://collector.example/c",
      apiKey: "sk_live",
      debug: () => undefined,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(sender.send([])).resolves.toBe("retry");
  });
});
