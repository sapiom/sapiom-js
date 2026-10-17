import {
  ALLOW_INSECURE_HTTP_ENV,
  CredentialChannelError,
} from "@sapiom/analytics-core/credential";

import { SapiomClient } from "./SapiomClient";

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const json = (status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 200 ? '{"ok":true}' : null, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const sentHeaders = (call: number): Record<string, string> =>
  mockFetch.mock.calls[call][1].headers;

// A retry delay would show as a slow test; zero it so only the call count matters.
const RETRY = { maxAttempts: 3, baseDelayMs: 0 };

describe("HttpClient credential channel", () => {
  const ORIGINAL = process.env[ALLOW_INSECURE_HTTP_ENV];
  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env[ALLOW_INSECURE_HTTP_ENV];
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env[ALLOW_INSECURE_HTTP_ENV];
    else process.env[ALLOW_INSECURE_HTTP_ENV] = ORIGINAL;
  });

  it("refuses plaintext to a non-loopback API host before sending, without retrying", async () => {
    const client = new SapiomClient({
      apiKey: "sk_live",
      baseURL: "http://api.internal",
      retry: RETRY,
    });
    const refusal = client.request({ url: "/x" });
    await expect(refusal).rejects.toBeInstanceOf(CredentialChannelError);
    await expect(refusal).rejects.toThrow(
      /^@sapiom\/core: refusing plaintext HTTP to http:\/\/api\.internal\..*new SapiomClient\(\{ allowInsecureHttp: true \}\) or SAPIOM_ALLOW_INSECURE_HTTP=1\.$/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses plaintext to a non-loopback vault host", async () => {
    const client = new SapiomClient({
      apiKey: "sk_live",
      servicesDomain: "http://svc.internal",
      retry: RETRY,
    });
    await expect(client.vault.getAll("demo")).rejects.toBeInstanceOf(
      CredentialChannelError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends to loopback API and vault hosts", async () => {
    mockFetch.mockImplementation(async () => json());
    const client = new SapiomClient({
      apiKey: "sk_live",
      baseURL: "http://localhost:3000",
      servicesDomain: "http://localhost:3999",
    });
    await client.request({ url: "/x" });
    await client.vault.getAll("demo");
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      "http://localhost:3000/v1/x",
      "http://vault.localhost:3999/v2/secrets/demo",
    ]);
    expect(sentHeaders(0)["x-api-key"]).toBe("sk_live");
    expect(sentHeaders(1)["x-sapiom-api-key"]).toBe("sk_live");
  });

  it.each([
    ["the client option", { allowInsecureHttp: true }, undefined],
    ["the env var", {}, "1"],
  ])(
    "sends plaintext to a non-loopback host when opted in by %s",
    async (_label, options, env) => {
      if (env) process.env[ALLOW_INSECURE_HTTP_ENV] = env;
      mockFetch.mockImplementation(async () => json());
      const client = new SapiomClient({
        apiKey: "sk_live",
        baseURL: "http://api.internal",
        ...options,
      });
      await client.request({ url: "/x" });
      expect(sentHeaders(0)["x-api-key"]).toBe("sk_live");
    },
  );

  it("setApiKey changes the key both clients send", async () => {
    mockFetch.mockImplementation(async () => json());
    const client = new SapiomClient({ apiKey: "sk_old" });
    client.setApiKey("sk_new");
    await client.request({ url: "/x" });
    await client.vault.getAll("demo");
    expect(sentHeaders(0)["x-api-key"]).toBe("sk_new");
    expect(sentHeaders(1)["x-sapiom-api-key"]).toBe("sk_new");
  });

  it("drops the key and x-sapiom-* headers on a redirect to another origin", async () => {
    mockFetch
      .mockResolvedValueOnce(
        json(307, { location: "https://other.example/landed" }),
      )
      .mockResolvedValueOnce(json());
    const client = new SapiomClient({
      apiKey: "sk_live",
      headers: { "x-sapiom-trace": "t1" },
    });
    await client.request({ url: "/x" });
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.sapiom.ai/v1/x",
      "https://other.example/landed",
    ]);
    expect(sentHeaders(0)["x-api-key"]).toBe("sk_live");
    expect(sentHeaders(1)).toEqual({ "Content-Type": "application/json" });
  });

  it("keeps the key on a same-origin redirect", async () => {
    mockFetch
      .mockResolvedValueOnce(json(307, { location: "/v2/x" }))
      .mockResolvedValueOnce(json());
    const client = new SapiomClient({ apiKey: "sk_live" });
    await client.request({ url: "/x" });
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.sapiom.ai/v2/x");
    expect(sentHeaders(1)["x-api-key"]).toBe("sk_live");
  });

  it("rejects a redirect to plaintext after one call, without retrying", async () => {
    mockFetch.mockResolvedValue(
      json(302, { location: "http://evil.internal/x" }),
    );
    const client = new SapiomClient({ apiKey: "sk_live", retry: RETRY });
    await expect(client.request({ url: "/x" })).rejects.toBeInstanceOf(
      CredentialChannelError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("still retries a failed connection", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json());
    const client = new SapiomClient({ apiKey: "sk_live", retry: RETRY });
    await expect(client.request({ url: "/x" })).resolves.toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
