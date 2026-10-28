import http from "http";
import { AddressInfo } from "net";
import { createFetch } from "./fetch";
import { SapiomClient, TransactionAPI, TransactionStatus } from "@sapiom/core";

describe("createFetch", () => {
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    const mockTransactionAPI: jest.Mocked<TransactionAPI> = {
      create: jest.fn(),
      get: jest.fn(),
      reauthorizeWithPayment: jest.fn(),
      list: jest.fn(),
      isAuthorized: jest.fn(),
      isCompleted: jest.fn(),
      requiresPayment: jest.fn(),
      getPaymentDetails: jest.fn(),
    } as any;

    mockSapiomClient = {
      transactions: mockTransactionAPI,
    } as any;
  });

  it("should create a fetch function", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
    });

    expect(typeof fetch).toBe("function");
  });

  it("should attach sapiomClient to fetch function", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
    });

    expect((fetch as any).__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create fetch with default metadata", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      agentName: "test-agent",
      agentId: "agent-123",
      serviceName: "test-service",
    });

    expect(typeof fetch).toBe("function");
  });
});

const PAYMENT_REQUIRED = JSON.stringify({
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "base",
      maxAmountRequired: "1000000",
      resource: "http://127.0.0.1/paid",
      payTo: "0x123",
      asset: "0xUSDC",
    },
  ],
});

const servers: http.Server[] = [];
const received: Record<string, http.IncomingHttpHeaders[]> = {};

async function listen(
  name: string,
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  received[name] = [];
  const server = http.createServer((req, res) => {
    received[name]!.push(req.headers);
    handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))),
  );
});

function createSapiomClient() {
  const transactions = {
    create: jest.fn().mockResolvedValue({
      id: "tx-1",
      status: TransactionStatus.AUTHORIZED,
    }),
    complete: jest.fn().mockResolvedValue({}),
    reauthorizeWithPayment: jest.fn().mockResolvedValue({
      id: "tx-1",
      status: TransactionStatus.AUTHORIZED,
      payment: { authorizationPayload: "payment-token" },
    }),
  };
  const identity = {
    getHeaderIfMatch: jest.fn(async (url: string) =>
      new URL(url).hostname === "127.0.0.1"
        ? { "Sapiom-Identity": "identity-jwt" }
        : {},
    ),
  };
  return {
    client: { transactions, identity } as unknown as SapiomClient,
    transactions,
    identity,
  };
}

describe("createFetch per-request metadata", () => {
  it("honours __sapiom.enabled false set on a Request", async () => {
    const origin = await listen("a", (_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(PAYMENT_REQUIRED);
    });
    const { client, transactions, identity } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });
    const request = new Request(`${origin}/paid`);
    (request as any).__sapiom = { enabled: false };

    const response = await fetch(request);

    expect(response.status).toBe(402);
    expect(transactions.create).not.toHaveBeenCalled();
    expect(transactions.reauthorizeWithPayment).not.toHaveBeenCalled();
    expect(identity.getHeaderIfMatch).not.toHaveBeenCalled();
    expect(received.a![0]!["sapiom-identity"]).toBeUndefined();
  });

  it("honours __sapiom.enabled false passed in init", async () => {
    const origin = await listen("a", (_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(PAYMENT_REQUIRED);
    });
    const { client, transactions } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });

    const response = await fetch(`${origin}/paid`, {
      __sapiom: { enabled: false },
    } as RequestInit);

    expect(response.status).toBe(402);
    expect(transactions.create).not.toHaveBeenCalled();
    expect(transactions.reauthorizeWithPayment).not.toHaveBeenCalled();
  });

  it("forwards per-request metadata set on a Request", async () => {
    const origin = await listen("a", (_req, res) => res.end("ok"));
    const { client, transactions } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });
    const request = new Request(`${origin}/x`);
    (request as any).__sapiom = { serviceName: "svc" };

    await fetch(request);

    expect(transactions.create).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: "svc" }),
    );
  });
});

describe("createFetch identity across redirects", () => {
  it("drops Sapiom-Identity on a redirect to another origin", async () => {
    const target = await listen("b", (_req, res) => res.end("ok"));
    const origin = await listen("a", (_req, res) => {
      res.writeHead(302, { location: `${target}/landing` });
      res.end();
    });
    const { client } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });

    const response = await fetch(`${origin}/start`);

    expect(response.status).toBe(200);
    expect(received.a![0]!["sapiom-identity"]).toBe("identity-jwt");
    expect(received.b![0]!["sapiom-identity"]).toBeUndefined();
  });

  it("drops Sapiom-Identity when the paid retry is redirected to another origin", async () => {
    const target = await listen("b", (_req, res) => res.end("paid"));
    const origin = await listen("a", (req, res) => {
      if (req.headers["x-payment"]) {
        res.writeHead(302, { location: `${target}/receipt` });
        res.end();
      } else {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(PAYMENT_REQUIRED);
      }
    });
    const { client, transactions } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });

    const response = await fetch(`${origin}/paid`);

    expect(transactions.reauthorizeWithPayment).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(received.a).toHaveLength(2);
    expect(received.a![1]!["sapiom-identity"]).toBe("identity-jwt");
    expect(received.b).toHaveLength(1);
    expect(received.b![0]!["sapiom-identity"]).toBeUndefined();
  });

  it("sends the caller's request with its dispatcher", async () => {
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("ok"));
    try {
      const { client } = createSapiomClient();
      const fetch = createFetch({ sapiomClient: client });
      const dispatcher = { name: "proxy-agent" };

      await fetch("http://127.0.0.1:9/upload", {
        method: "POST",
        body: "payload",
        dispatcher,
      } as unknown as RequestInit);

      const [sent, init] = spy.mock.calls[0]! as [
        Request,
        RequestInit & { dispatcher?: unknown },
      ];
      expect(sent.headers.get("sapiom-identity")).toBe("identity-jwt");
      expect(await sent.text()).toBe("payload");
      expect(init.dispatcher).toBe(dispatcher);
    } finally {
      spy.mockRestore();
    }
  });

  it("sends a keepalive Request input with a string body", async () => {
    const server = await listen("a", (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => res.end(body));
    });
    const { client } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });

    const response = await fetch(
      new Request(`${server}/beacon`, {
        method: "POST",
        body: "payload",
        keepalive: true,
      }),
    );

    expect(await response.text()).toBe("payload");
    expect(received.a![0]!["sapiom-identity"]).toBe("identity-jwt");
  });

  it("resends a Request input's body on a 307 to another origin", async () => {
    const target = await listen("b", (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => res.end(body));
    });
    const origin = await listen("a", (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(307, { location: `${target}/next` });
        res.end();
      });
    });
    const { client } = createSapiomClient();
    const fetch = createFetch({ sapiomClient: client });

    const response = await fetch(
      new Request(`${origin}/start`, { method: "POST", body: "payload" }),
    );

    expect(await response.text()).toBe("payload");
    expect(received.b![0]!["sapiom-identity"]).toBeUndefined();
  });

  const streamed = (body: ReadableStream): RequestInit =>
    ({ method: "POST", body, duplex: "half" }) as RequestInit;
  const calls: [
    string,
    (url: string, body: ReadableStream) => [string | Request, RequestInit?],
  ][] = [
    ["a Request input", (url, body) => [new Request(url, streamed(body))]],
    [
      "a Request input with `body: null`",
      (url, body) => [new Request(url, streamed(body)), { body: null }],
    ],
    ["a URL with a stream body", (url, body) => [url, streamed(body)]],
  ];

  it.each(calls)(
    "starts sending the stream body of %s before it ends",
    async (_label, args) => {
      let firstChunk: () => void;
      const chunkArrived = new Promise<void>(
        (resolve) => (firstChunk = resolve),
      );
      const server = await listen("a", (req, res) => {
        req.once("data", () => {
          firstChunk();
        });
        req.on("end", () => res.end("ok"));
      });
      const { client } = createSapiomClient();
      const fetch = createFetch({ sapiomClient: client });
      let close: () => void;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          close = () => controller.close();
        },
      });

      const pending = fetch(...args(`${server}/upload`, body));
      await chunkArrived;
      close!();
      const response = await pending;

      expect(response.status).toBe(200);
      expect(received.a![0]!["sapiom-identity"]).toBe("identity-jwt");
    },
  );
});
