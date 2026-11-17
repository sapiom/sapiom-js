import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RelayRequest } from "./contract";
import {
  httpPaymentRelay,
  isRetryableRelayError,
  RelayHttpError,
} from "./relay";

const REQUEST: RelayRequest = {
  injectionRef: "inj_fixture_shopify",
  profileId: "shopify-card-vault",
  pageOrigin: "https://shop.example",
  request: {
    method: "POST",
    url: "https://checkout.pci.shopifyinc.com/sessions",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "shopify-identification-signature": "fixture-signature",
    },
    body: '{"credit_card":{"number":"4242424242424242"}}',
  },
  idempotencyKey: "a".repeat(64),
};

const RELAYED = {
  outcome: "relayed",
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"id":"west-fixture-session"}',
  },
};

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function origin(server: http.Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("httpPaymentRelay", () => {
  it("accepts https and loopback http, and rejects other http base URLs", () => {
    const options = {
      apiKey: "test-key",
      transactionId: "tx_fixture_shopify",
    };
    expect(() =>
      httpPaymentRelay({ ...options, baseUrl: "https://api.sapiom.ai" }),
    ).not.toThrow();
    expect(() =>
      httpPaymentRelay({ ...options, baseUrl: "http://localhost:3000" }),
    ).not.toThrow();
    expect(() =>
      httpPaymentRelay({ ...options, baseUrl: "http://127.0.0.1:3000" }),
    ).not.toThrow();
    expect(() =>
      httpPaymentRelay({ ...options, baseUrl: "http://[::1]:3000" }),
    ).not.toThrow();
    expect(() =>
      httpPaymentRelay({ ...options, baseUrl: "http://example.com" }),
    ).toThrow(
      "@sapiom/browser-pay: refusing plaintext HTTP to http://example.com",
    );
    for (const baseUrl of [
      "https://api.sapiom.ai#/payment/relay",
      "https://api.sapiom.ai/#",
      "https://api.sapiom.ai?",
      "https://api.sapiom.ai?x=1",
    ]) {
      expect(() => httpPaymentRelay({ ...options, baseUrl })).toThrow(
        "Payment relay baseUrl must not contain a query or fragment",
      );
    }
  });

  it("POSTs David's body to the transaction path and does not retry", async () => {
    const seen: {
      url?: string;
      headers?: http.IncomingHttpHeaders;
      body?: string;
      count: number;
    } = { count: 0 };
    const server = await listen((req, res) => {
      seen.count += 1;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.url = req.url;
        seen.headers = req.headers;
        seen.body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ reason: "not-a-refusal", echo: seen.body }));
      });
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      await expect(relay.relay(REQUEST)).rejects.toThrow(
        "Payment relay failed (HTTP 500)",
      );
      expect(seen.count).toBe(1);
      expect(seen.url).toBe(
        "/v1/transactions/tx_fixture_shopify/payment/relay",
      );
      expect(seen.headers?.["x-api-key"]).toBe("test-key");
      expect(seen.headers?.["idempotency-key"]).toBeUndefined();
      expect(JSON.parse(seen.body ?? "")).toEqual(REQUEST);
      expect(JSON.parse(seen.body ?? "")).not.toHaveProperty("transactionId");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns a relayed response, a preserved refusal reason, and outcome unknown", async () => {
    const payloads = [
      RELAYED,
      { outcome: "refused", reason: "merchant_mismatch" },
      {
        outcome: "refused",
        reason: "future_reason",
        body: REQUEST.request.body,
      },
      { outcome: "unknown" },
    ];
    const server = await listen((_req, res) => {
      const payload = payloads.shift();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: `${origin(server)}/`,
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      await expect(relay.relay(REQUEST)).resolves.toEqual(RELAYED);
      await expect(relay.relay(REQUEST)).resolves.toEqual({
        outcome: "refused",
        reason: "merchant_mismatch",
      });
      await expect(relay.relay(REQUEST)).resolves.toEqual({
        outcome: "refused",
        reason: "future_reason",
      });
      await expect(relay.relay(REQUEST)).resolves.toEqual({
        outcome: "unknown",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps boolean retryable and string requestId on a refusal and drops other keys", async () => {
    const cases = [
      {
        sent: {
          outcome: "refused",
          reason: "future_reason",
          retryable: false,
          requestId: "req_future",
        },
        seen: {
          outcome: "refused",
          reason: "future_reason",
          retryable: false,
          requestId: "req_future",
        },
      },
      {
        sent: {
          outcome: "refused",
          reason: "future_reason",
          retryable: "true",
          requestId: 42,
        },
        seen: { outcome: "refused", reason: "future_reason" },
      },
      {
        sent: {
          outcome: "refused",
          reason: "future_reason",
          requestId: "",
        },
        seen: { outcome: "refused", reason: "future_reason" },
      },
      {
        sent: {
          outcome: "refused",
          reason: "future_reason",
          echo: "not-forwarded",
        },
        seen: { outcome: "refused", reason: "future_reason" },
      },
    ];
    let index = 0;
    const server = await listen((_req, res) => {
      const payload = cases[index];
      index += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload?.sent));
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      for (const entry of cases) {
        await expect(relay.relay(REQUEST)).resolves.toStrictEqual(entry.seen);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps a setCookies string array and rejects any other setCookies type", async () => {
    const withCookies = {
      outcome: "relayed",
      response: {
        ...RELAYED.response,
        setCookies: ["a=1; Path=/", "b=2; Path=/, c=3"],
      },
    };
    const payloads = [
      RELAYED,
      withCookies,
      { ...withCookies, response: { ...RELAYED.response, setCookies: [] } },
      ...["a=1", [1], ["a=1", null], { a: "1" }, null].map((setCookies) => ({
        outcome: "relayed",
        response: { ...RELAYED.response, setCookies },
      })),
    ];
    const server = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payloads.shift()));
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      await expect(relay.relay(REQUEST)).resolves.toStrictEqual(RELAYED);
      await expect(relay.relay(REQUEST)).resolves.toStrictEqual(withCookies);
      await expect(relay.relay(REQUEST)).resolves.toStrictEqual({
        outcome: "relayed",
        response: { ...RELAYED.response, setCookies: [] },
      });
      for (let i = 0; i < 5; i += 1) {
        await expect(relay.relay(REQUEST)).rejects.toThrow(
          "Payment relay failed (HTTP 200)",
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("aborts when the caller signal fires", async () => {
    let arrived: () => void = () => {};
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = await listen((_req, res) => {
      arrived();
      res.writeHead(200);
    });
    const controller = new AbortController();
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      const pending = relay.relay(REQUEST, { signal: controller.signal });
      await requestArrived;
      const expectation = expect(pending).rejects.toThrow(
        "Payment relay timed out",
      );
      controller.abort();
      await expectation;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not read an outcome from a non-2xx body", async () => {
    const payloads = [
      { status: 401, body: { outcome: "unknown" } },
      {
        status: 500,
        body: { outcome: "refused", reason: "already_relayed" },
      },
    ];
    const server = await listen((_req, res) => {
      const payload = payloads.shift();
      res.writeHead(payload?.status ?? 500, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(payload?.body));
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      await expect(relay.relay(REQUEST)).rejects.toThrow(
        "Payment relay failed (HTTP 401)",
      );
      await expect(relay.relay(REQUEST)).rejects.toThrow(
        "Payment relay failed (HTTP 500)",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses a redirect", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(302, { location: "https://evil.example/steal" });
      res.end();
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      await expect(relay.relay(REQUEST)).rejects.toThrow(
        "Payment relay refused a redirect",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("aborts a stalled body when the caller signal fires after headers", async () => {
    const controller = new AbortController();
    const relay = httpPaymentRelay({
      baseUrl: "https://relay.example",
      apiKey: "test-key",
      transactionId: "tx_fixture_shopify",
      fetchImpl: stalledBody,
    });
    const pending = relay.relay(REQUEST, { signal: controller.signal });
    const expectation = expect(pending).rejects.toThrow(
      "Payment relay timed out",
    );
    controller.abort();
    await expectation;
  });

  it("retries only router gateway statuses", async () => {
    const statuses = [502, 503, 504, 500, 401];
    const server = await listen((_req, res) => {
      const status = statuses.shift() ?? 500;
      res.writeHead(status);
      res.end();
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
      });
      for (const status of [502, 503, 504, 500, 401]) {
        const error = await relay
          .relay(REQUEST)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RelayHttpError);
        expect((error as RelayHttpError).status).toBe(status);
        expect(isRetryableRelayError(error)).toBe(
          status === 502 || status === 503 || status === 504,
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

function stalledBody(
  _input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const stream = new ReadableStream({
    start(controller) {
      const fail = () => {
        try {
          controller.error(
            new DOMException("The operation was aborted.", "AbortError"),
          );
        } catch {
          // The stream may already be cancelled.
        }
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail, { once: true });
    },
  });
  return Promise.resolve(new Response(stream, { status: 200 }));
}

describe("httpPaymentRelay adyenEncrypt", () => {
  const ENCRYPT = {
    injectionRef: "inj_fixture_adyen",
    clientKey: "test_FIXTUREKEY123",
    pageOrigin: "https://shop.example",
  };
  const BLOBS = {
    encryptedCardNumber: "eyJ.real-number",
    encryptedExpiryMonth: "eyJ.real-month",
    encryptedExpiryYear: "eyJ.real-year",
    encryptedSecurityCode: "eyJ.real-cvc",
  };

  it("POSTs the injection, client key and page origin to the encrypt path with the api key", async () => {
    const seen: {
      method?: string;
      url?: string;
      headers?: http.IncomingHttpHeaders;
      body?: string;
    } = {};
    const server = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.headers = req.headers;
        seen.body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...BLOBS, extra: "ignored" }));
      });
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_adyen",
      });
      await expect(relay.adyenEncrypt!(ENCRYPT)).resolves.toStrictEqual({
        outcome: "encrypted",
        fields: BLOBS,
      });
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/v1/transactions/tx_adyen/payment/adyen/encrypt");
      expect(seen.headers?.["x-api-key"]).toBe("test-key");
      expect(seen.headers?.["content-type"]).toBe("application/json");
      expect(JSON.parse(seen.body ?? "")).toStrictEqual(ENCRYPT);
    } finally {
      server.close();
    }
  });

  it("throws without the response text on an error status or an unreadable body", async () => {
    const replies: [number, string][] = [
      [403, '{"secret":"eyJ.leaked"}'],
      [200, '{"encryptedCardNumber":"eyJ.leaked"}'],
      [200, "eyJ.leaked not json"],
    ];
    for (const [status, body] of replies) {
      const server = await listen((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
      try {
        const relay = httpPaymentRelay({
          baseUrl: origin(server),
          apiKey: "test-key",
          transactionId: "tx_adyen",
        });
        const error = await relay.adyenEncrypt!(ENCRYPT).catch(
          (caught: unknown) => caught as Error,
        );
        expect(error).toBeInstanceOf(Error);
        if (status !== 200) expect(error).toBeInstanceOf(RelayHttpError);
        expect(
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
        ).not.toContain("leaked");
      } finally {
        server.close();
      }
    }
  });

  it("reads the backend's typed not-enabled answer as off, on an error status or a 200", async () => {
    const replies: [number, string][] = [
      [403, '{"code":"adyen_encryption_not_enabled","message":"off"}'],
      [503, '{"code":"adyen_encryption_not_enabled"}'],
      [200, '{"reason":"adyen_encryption_not_enabled"}'],
    ];
    for (const [status, body] of replies) {
      const server = await listen((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
      try {
        const relay = httpPaymentRelay({
          baseUrl: origin(server),
          apiKey: "test-key",
          transactionId: "tx_adyen",
        });
        await expect(relay.adyenEncrypt!(ENCRYPT)).resolves.toStrictEqual({
          outcome: "not_enabled",
        });
      } finally {
        server.close();
      }
    }
  });

  it("does not read another error code as not enabled", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"code":"merchant_mismatch"}');
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_adyen",
      });
      await expect(relay.adyenEncrypt!(ENCRYPT)).rejects.toBeInstanceOf(
        RelayHttpError,
      );
    } finally {
      server.close();
    }
  });
});
