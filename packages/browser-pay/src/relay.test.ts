import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RelayRequest } from "./contract";
import { httpPaymentRelay } from "./relay";

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

  it("aborts when the caller signal fires before timeoutMs", async () => {
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

  it("times out on its own timeoutMs while the caller signal stays open", async () => {
    const server = await listen(() => {
      // Never respond.
    });
    const controller = new AbortController();
    try {
      const relay = httpPaymentRelay({
        baseUrl: origin(server),
        apiKey: "test-key",
        transactionId: "tx_fixture_shopify",
        timeoutMs: 50,
      });
      const started = Date.now();
      await expect(
        relay.relay(REQUEST, { signal: controller.signal }),
      ).rejects.toThrow("Payment relay timed out");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
