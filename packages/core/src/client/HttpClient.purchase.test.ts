import { SapiomApiError } from "../errors/SapiomApiError.js";
import { HttpClient } from "./HttpClient.js";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "response-request",
    },
  });
const client = () =>
  new HttpClient({
    baseURL: "https://api.example",
    timeout: 1000,
    headers: {},
    credential: { header: "x-api-key", value: "test-only-key" },
    retry: { maxAttempts: 3, baseDelayMs: 0 },
  });

describe("Purchase request transport", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(["network", "server"])(
    "does not replay a mutation after an uncertain %s failure when retries are disabled",
    async (failure) => {
      const fetch = jest.spyOn(globalThis, "fetch");
      if (failure === "network")
        fetch.mockRejectedValue(new TypeError("connection closed after write"));
      else
        fetch.mockResolvedValue(reply(503, { code: "merchant_unavailable" }));
      await expect(
        client().request({
          method: "PUT",
          url: "/transactions/purchase/ucp/checkout",
          body: { line_items: [] },
          headers: { "Idempotency-Key": "same-purchase-change" },
          retry: false,
        }),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("retains ordinary retries and one caller key/body across attempts", async () => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => reply(503, {}));
    await expect(
      client().request({
        method: "POST",
        url: "/ordinary-operation",
        body: { name: "same" },
        headers: { "X-Idempotency-Key": "caller-key" },
      }),
    ).rejects.toBeInstanceOf(SapiomApiError);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get("x-idempotency-key")).toBe(
        "caller-key",
      );
      expect(new Headers(init?.headers).get("idempotency-key")).toBeNull();
      expect(init?.body).toBe('{"name":"same"}');
    }
  });

  it("exposes status, public refusal and request ID while preserving Error compatibility", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        reply(409, {
          code: "RULE_VERSION_CONFLICT",
          requestId: "body-request",
          message: "Read current settings",
        }),
      );
    const error = await client()
      .request({
        method: "PUT",
        url: "/payment-methods/method/spending-limits",
        retry: false,
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SapiomApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "RULE_VERSION_CONFLICT",
      requestId: "body-request",
      body: { message: "Read current settings" },
    });
    expect((error as Error).message).toContain(
      "Request failed with status 409:",
    );
  });

  it("uses the response request ID when the body has none", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reply(403, { code: "permission_denied" }));
    await expect(
      client().request({ url: "/payment-methods" }),
    ).rejects.toMatchObject({ status: 403, requestId: "response-request" });
  });
});
