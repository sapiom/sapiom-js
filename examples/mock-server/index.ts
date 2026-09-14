/**
 * Local mock server for the HTTP SDK examples (axios / fetch / node-http).
 *
 * Stands in for the hosted demo at https://x402-demo.sapiom.ai, which has been
 * returning 403 (see https://github.com/sapiom/sapiom-js/issues/88). It serves
 * the endpoints those examples call — the free `/api/public/*` and CRM routes,
 * plus the paid `/api/sms` and `/api/campaigns/analytics` routes — with
 * realistic stub JSON, using only Node's built-in `http` module (no deps).
 *
 * Run: `npm start` (listens on http://localhost:3101). Point the examples at it
 * with `DUMMY_SERVER_URL=http://localhost:3101` (now the default in
 * `.env.example`).
 *
 * By default the paid endpoints return `200` directly so the examples "just
 * work" offline. Set `MOCK_X402=1` to have them instead emit a real x402 `402`
 * payment challenge until the SDK retries with a payment header — the faithful
 * flow, which completes only against a funded Sapiom account.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT) || 3101;
const X402_ENABLED = process.env.MOCK_X402 === "1" || process.env.MOCK_X402 === "true";
const STARTED_AT = Date.now();

/** Customers returned by /api/crm/customers, filterable by segment. */
const CUSTOMERS = [
  { id: "cus_001", name: "Acme Corp", email: "ops@acme.example", phone: "+15550100101", segment: "enterprise", revenue: 1_250_000 },
  { id: "cus_002", name: "Globex", email: "hello@globex.example", phone: "+15550100102", segment: "enterprise", revenue: 980_000 },
  { id: "cus_003", name: "Initech", email: "team@initech.example", phone: "+15550100103", segment: "enterprise", revenue: 640_000 },
  { id: "cus_004", name: "Umbrella LLC", email: "contact@umbrella.example", phone: "+15550100104", segment: "midmarket", revenue: 210_000 },
  { id: "cus_005", name: "Hooli", email: "info@hooli.example", phone: "+15550100105", segment: "smb", revenue: 48_000 },
];

/** Per-endpoint price, mirrored from the README endpoint table (USD). */
const PRICES: Record<string, number> = {
  "/api/sms": 0.0075,
  "/api/campaigns/analytics": 0.05,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** True if the request already carries a payment header (x402 V2 or V1). */
function hasPaymentHeader(req: IncomingMessage): boolean {
  return Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
}

/**
 * An x402 V2 payment-required response body, matching X402ResponseV2 from
 * `@sapiom/core`. `amount` is in USDC atomic units (6 decimals) — illustrative.
 */
function x402Challenge(path: string, resourceUrl: string): unknown {
  const usd = PRICES[path] ?? 0;
  const atomic = Math.round(usd * 1_000_000).toString();
  return {
    x402Version: 2,
    error: "payment required",
    resource: {
      url: resourceUrl,
      description: `Mock paid endpoint ${path}`,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "sapiom:main",
        amount: atomic,
        payTo: "0x0000000000000000000000000000000000000000",
        maxTimeoutSeconds: 60,
        asset: "USDC",
        extra: {},
      },
    ],
  };
}

/** Paid endpoints: gate on a payment header only when MOCK_X402 is enabled. */
function paymentGate(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!X402_ENABLED || hasPaymentHeader(req)) return true;
  sendJson(res, 402, x402Challenge(path, `http://localhost:${PORT}${path}`));
  return false;
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    sendJson(res, 500, { error: "internal", detail: String(err) });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Root: a small info blob so the base URL isn't a bare 404.
  if (method === "GET" && path === "/") {
    sendJson(res, 200, {
      name: "sapiom mock x402 demo server",
      x402Mode: X402_ENABLED ? "on (paid endpoints emit 402 until paid)" : "off (paid endpoints return 200)",
      endpoints: [
        "GET /api/public/time",
        "GET /api/public/status",
        "GET /api/crm/customers",
        "POST /api/sms",
        "POST /api/campaigns/analytics",
      ],
    });
    return;
  }

  if (method === "GET" && path === "/api/public/time") {
    sendJson(res, 200, { time: new Date().toISOString(), timezone: "UTC" });
    return;
  }

  if (method === "GET" && path === "/api/public/status") {
    sendJson(res, 200, {
      status: "ok",
      version: "1.0.0",
      uptime: (Date.now() - STARTED_AT) / 1000,
    });
    return;
  }

  if (method === "GET" && path === "/api/crm/customers") {
    const segment = url.searchParams.get("segment");
    const limit = Number(url.searchParams.get("limit")) || CUSTOMERS.length;
    const customers = CUSTOMERS.filter((c) => !segment || c.segment === segment).slice(0, limit);
    sendJson(res, 200, { customers });
    return;
  }

  if (method === "POST" && path === "/api/sms") {
    if (!paymentGate(req, res, path)) return;
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      messageId: `sms_${Math.random().toString(36).slice(2, 10)}`,
      status: "sent",
      price: PRICES[path],
      to: body.phone ?? null,
      campaignId: body.campaignId ?? null,
    });
    return;
  }

  if (method === "POST" && path === "/api/campaigns/analytics") {
    if (!paymentGate(req, res, path)) return;
    const body = await readJsonBody(req);
    const sent = 3;
    const delivered = 3;
    sendJson(res, 200, {
      name: (body.campaignId as string) ?? "campaign",
      status: "completed",
      price: PRICES[path],
      metrics: { sent, delivered, openRate: 42.5 },
    });
    return;
  }

  sendJson(res, 404, { error: "not found", method, path });
}

server.listen(PORT, () => {
  console.log(`Mock x402 demo server listening on http://localhost:${PORT}`);
  console.log(`  x402 payment challenge mode: ${X402_ENABLED ? "ON (MOCK_X402)" : "off"}`);
  console.log("  Point the examples at it with DUMMY_SERVER_URL=http://localhost:" + PORT);
});
