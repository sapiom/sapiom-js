#!/usr/bin/env node
import http from "node:http";

const port = Number.parseInt(process.env.DUMMY_SERVER_PORT ?? "3101", 10);
const startedAt = Date.now();

const customers = [
  {
    id: "cus_demo_enterprise_1",
    name: "Acme Corp",
    email: "ops@acme.example",
    phone: "+15550100001",
    segment: "enterprise",
    revenue: 250000,
  },
  {
    id: "cus_demo_enterprise_2",
    name: "Globex",
    email: "team@globex.example",
    phone: "+15550100002",
    segment: "enterprise",
    revenue: 180000,
  },
  {
    id: "cus_demo_enterprise_3",
    name: "Initech",
    email: "hello@initech.example",
    phone: "+15550100003",
    segment: "enterprise",
    revenue: 125000,
  },
];

function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `localhost:${port}`}`,
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers":
        "content-type,authorization,x-sapiom-transaction-id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/public/time") {
    writeJson(res, 200, {
      time: new Date().toISOString(),
      timezone: "UTC",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/public/status") {
    writeJson(res, 200, {
      status: "ok",
      version: "local-demo",
      uptime: (Date.now() - startedAt) / 1000,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/crm/customers") {
    const limit = Number.parseInt(
      url.searchParams.get("limit") ?? String(customers.length),
      10,
    );
    const segment = url.searchParams.get("segment");
    const filtered = segment
      ? customers.filter((customer) => customer.segment === segment)
      : customers;
    writeJson(res, 200, {
      customers: filtered.slice(
        0,
        Number.isFinite(limit) ? limit : filtered.length,
      ),
      total: filtered.length,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sms") {
    const body = await readJson(req);
    writeJson(res, 200, {
      messageId: `sms_demo_${Date.now()}`,
      status: "queued",
      price: 0.0075,
      to: body.phone,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/campaigns/analytics") {
    const body = await readJson(req);
    const sent = 3;
    const opened = 2;
    writeJson(res, 200, {
      campaignId: body.campaignId ?? "demo-campaign",
      name: "Local Demo Campaign",
      status: "completed",
      metrics: {
        sent,
        delivered: sent,
        opened,
        clicked: 1,
        conversions: 1,
        openRate: Math.round((opened / sent) * 100),
      },
    });
    return;
  }

  writeJson(res, 404, { error: "not_found", path: url.pathname });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local Sapiom demo server listening at http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
