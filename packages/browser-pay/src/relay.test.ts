import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  RELAY_REFUSAL_REASONS,
  parseRelayResponse,
  type RelayRequest,
} from "./contract";
import { relayRefusalFixtures, shopifyCardSessionRoundTrip } from "./fixtures";
import { matchHeldPlaceholderInBody } from "./detect";
import { httpPaymentRelay, stubPaymentRelay } from "./relay";

const REQUEST: RelayRequest = shopifyCardSessionRoundTrip.request;

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

describe("T7 fixtures", () => {
  it("round-trips a Shopify card session and matches the placeholder", () => {
    const { request, response } = shopifyCardSessionRoundTrip;
    expect(request.url).toBe("https://checkout.pci.shopifyinc.com/sessions");
    expect(request.merchantOrigin).toBe("https://shop.example");
    expect(Object.keys(response).sort()).toEqual([
      "body",
      "bodyEncoding",
      "headers",
      "ok",
      "status",
    ]);
    expect(response.headers.filter(([name]) => name === "set-cookie")).toEqual([
      ["set-cookie", "session=a"],
      ["set-cookie", "session=b"],
    ]);
    expect(
      matchHeldPlaceholderInBody(request.body, {
        number: "4242424242424242",
        expMonth: 12,
        expYear: 2028,
        cvc: "123",
        injectionRef: request.injectionRef,
      }),
    ).toEqual({ kind: "match", injectionRef: "inj_fixture_shopify" });
    expect(response.body).not.toMatch(/\d(?:[\s-]*\d){12,18}/);
  });

  it("has one refusal per reason and does not echo a request", () => {
    expect(Object.keys(relayRefusalFixtures).sort()).toEqual(
      [...RELAY_REFUSAL_REASONS].sort(),
    );
    for (const reason of RELAY_REFUSAL_REASONS) {
      expect(relayRefusalFixtures[reason]).toEqual({ ok: false, reason });
      expect(parseRelayResponse(relayRefusalFixtures[reason])).toEqual({
        ok: false,
        reason,
      });
    }
  });
});

describe("httpPaymentRelay", () => {
  it("POSTs the T7 body to David's route with the API key and does not retry", async () => {
    const seen: {
      url?: string;
      headers?: http.IncomingHttpHeaders;
      body?: string;
      count: number;
    } = {
      count: 0,
    };
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
        timeoutMs: 1000,
      });
      await expect(relay.relay(REQUEST)).rejects.toThrow(
        "Payment relay failed (HTTP 500)",
      );
      expect(seen.count).toBe(1);
      expect(seen.url).toBe(
        "/v1/transactions/tx_fixture_shopify/payment/relay",
      );
      expect(seen.headers?.["x-api-key"]).toBe("test-key");
      expect(seen.headers?.["idempotency-key"]).toBe(REQUEST.idempotencyKey);
      expect(JSON.parse(seen.body ?? "")).toEqual(REQUEST);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns a provider response and a typed refusal", async () => {
    const payloads = [
      shopifyCardSessionRoundTrip.response,
      relayRefusalFixtures.cancelled,
    ];
    const server = await listen((_req, res) => {
      const payload = payloads.shift();
      res.writeHead(payload && "ok" in payload && payload.ok ? 200 : 403, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(payload));
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: `${origin(server)}/`,
        apiKey: "test-key",
      });
      await expect(relay.relay(REQUEST)).resolves.toEqual(
        shopifyCardSessionRoundTrip.response,
      );
      await expect(relay.relay(REQUEST)).resolves.toEqual({
        ok: false,
        reason: "cancelled",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("aborts when the caller signal fires and does not keep its own timer", async () => {
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
        timeoutMs: 30_000,
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

  it("times out without including a response body", async () => {
    const server = await listen(() => {
      // Never respond.
    });
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        timeoutMs: 50,
      });
      await expect(relay.relay(REQUEST)).rejects.toThrow(
        "Payment relay timed out",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("stubPaymentRelay", () => {
  it("returns the handler's response", async () => {
    const relay = stubPaymentRelay(async () => relayRefusalFixtures.replay);
    await expect(relay.relay(REQUEST)).resolves.toEqual({
      ok: false,
      reason: "replay",
    });
  });
});
