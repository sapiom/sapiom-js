import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import { stubPaymentRelay, type PaymentRelay } from "./relay";
import type { HeldPlaceholder, RelayRequest } from "./index";

const PLACEHOLDER: HeldPlaceholder = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2028,
  cvc: "123",
  injectionRef: "inj_integration",
};

const PING = JSON.stringify({ event: "ping" });
const UNRELATED = JSON.stringify({
  credit_card: {
    number: "4111111111111111",
    month: 1,
    year: 2030,
    verification_value: "999",
  },
});
const MISMATCH = JSON.stringify({
  credit_card: {
    number: PLACEHOLDER.number,
    month: PLACEHOLDER.expMonth,
    year: PLACEHOLDER.expYear,
    verification_value: "999",
  },
});
const CARD = JSON.stringify({
  credit_card: {
    number: PLACEHOLDER.number,
    month: PLACEHOLDER.expMonth,
    year: PLACEHOLDER.expYear,
    verification_value: PLACEHOLDER.cvc,
  },
});

const FRAME_HTML = `<!doctype html>
<meta charset="utf-8">
<title>card</title>
<script>
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body,
  });
  return { status: res.status, text: await res.text() };
}
window.run = async (bodies) => {
  const ping = await post("/collect", bodies.ping);
  const unrelated = await post("/other", bodies.other);
  let mismatch;
  try { mismatch = await post("/sessions", bodies.mismatch); }
  catch (error) { mismatch = { error: error.name }; }
  let card;
  try { card = await post("/sessions", bodies.card); }
  catch (error) { card = { error: error.name }; }
  return { ping, unrelated, mismatch, card };
};
</script>`;

interface Hit {
  path: string;
  body: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function startServer(
  hits: Hit[],
  html: string,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, via: "server" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function chromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function waitForDebugger(
  port: number,
  proc: ChildProcess,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  let last = "not listening";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited before CDP was ready (${proc.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const body = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : "fetch failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP endpoint did not come up (${last})`);
}

const describeWithChrome = chromeExecutable() ? describe : describe.skip;

describeWithChrome("attachInterceptor on headless Chromium", () => {
  let chrome: ChildProcess;
  let userDataDir: string;
  let cdpUrl: string;
  let merchant: { server: http.Server; port: number };
  let card: { server: http.Server; port: number };
  const hits: Hit[] = [];

  beforeAll(async () => {
    const executable = chromeExecutable();
    if (!executable) {
      throw new Error(
        "google-chrome or chromium is required for the interceptor integration test",
      );
    }
    userDataDir = await mkdtemp(path.join(os.tmpdir(), "browser-pay-"));
    const port = await freePort();
    chrome = spawn(
      executable,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    cdpUrl = await waitForDebugger(port, chrome);
    card = await startServer(hits, FRAME_HTML);
    merchant = await startServer(hits, "");
  }, 30_000);

  afterAll(async () => {
    chrome?.kill("SIGKILL");
    await new Promise((resolve) => merchant?.server.close(resolve));
    await new Promise((resolve) => card?.server.close(resolve));
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    hits.length = 0;
  });

  async function drive(
    relay: PaymentRelay,
    bodies: { ping: string; other?: string; mismatch?: string; card: string },
  ) {
    const events: InterceptorEvent[] = [];
    const calls: RelayRequest[] = [];
    const wrapped: PaymentRelay = {
      relay: async (request) => {
        calls.push(request);
        return relay.relay(request);
      },
    };
    const handle = await attachInterceptor(cdpUrl, {
      relay: wrapped,
      placeholder: PLACEHOLDER,
      transactionId: "tx_integration",
      timeoutMs: 5_000,
    });
    handle.on((event) => events.push(event));
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(cdpUrl);
    let page: import("playwright").Page | undefined;
    try {
      const context = browser.contexts()[0];
      page = context.pages()[0] ?? (await context.newPage());
      const merchantOrigin = `http://127.0.0.1:${merchant.port}`;
      await page.goto(`${merchantOrigin}/`, { waitUntil: "domcontentloaded" });
      await page.setContent(
        `<!doctype html><title>merchant</title><iframe src="http://127.0.0.1:${card.port}/frame.html"></iframe>`,
        { waitUntil: "domcontentloaded" },
      );
      // The driver's Playwright session is a second CDP client on this browser.
      expect(
        await page.evaluate(
          () =>
            (globalThis as { document?: { title: string } }).document?.title,
        ),
      ).toBe("merchant");
      const frame = page
        .frames()
        .find((candidate) => candidate.url().includes(String(card.port)));
      if (!frame) throw new Error("cross-origin card frame was not attached");
      await frame.waitForFunction(
        () => typeof (globalThis as { run?: unknown }).run === "function",
      );
      const result = await frame.evaluate(
        (payload) =>
          (
            globalThis as unknown as {
              run: (bodies: typeof payload) => Promise<unknown>;
            }
          ).run(payload),
        {
          ping: bodies.ping,
          other: bodies.other ?? PING,
          mismatch: bodies.mismatch ?? bodies.card,
          card: bodies.card,
        },
      );
      return { events, calls, result, merchantOrigin };
    } finally {
      // Closing a connectOverCDP browser can terminate Chrome. Close the page
      // only; the interceptor's own connection is detached below.
      await page?.close().catch(() => {});
      await handle.detach();
      void browser;
    }
  }

  it("relays only the placeholder request while a second CDP client drives the page", async () => {
    const { events, calls, result, merchantOrigin } = await drive(
      stubPaymentRelay(async () => ({
        ok: true,
        status: 201,
        headers: { "content-type": "application/json" },
        body: '{"id":"sess_test"}',
      })),
      { ping: PING, other: UNRELATED, mismatch: MISMATCH, card: CARD },
    );

    const paths = hits.map((hit) => hit.path);
    expect(paths.filter((item) => item === "/collect").length).toBe(1);
    expect(hits.find((hit) => hit.path === "/collect")?.body).toBe(PING);
    expect(hits.find((hit) => hit.path === "/other")?.body).toBe(UNRELATED);
    expect(paths.filter((item) => item === "/sessions")).toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      transactionId: "tx_integration",
      injectionRef: "inj_integration",
      merchantOrigin,
      method: "POST",
      url: `http://127.0.0.1:${card.port}/sessions`,
      body: CARD,
    });
    expect(calls[0].merchantOrigin).not.toContain(String(card.port));
    expect(header(calls[0].headers, "content-type")).toBe("application/json");

    expect(result).toEqual({
      ping: { status: 200, text: JSON.stringify({ ok: true, via: "server" }) },
      unrelated: {
        status: 200,
        text: JSON.stringify({ ok: true, via: "server" }),
      },
      mismatch: { error: "TypeError" },
      card: { status: 201, text: '{"id":"sess_test"}' },
    });
    expect(events.map((event) => event.type)).toEqual([
      "failed",
      "paused",
      "relayed",
    ]);
    expect(events[2]).toMatchObject({ type: "relayed", status: 201 });
    expect(JSON.stringify(events)).not.toContain(PLACEHOLDER.number);
  }, 60_000);

  it("fails a refused placeholder request and never delivers it", async () => {
    const { events, calls, result } = await drive(
      stubPaymentRelay(async () => ({ ok: false, reason: "cancelled" })),
      { ping: PING, other: PING, mismatch: PING, card: CARD },
    );
    expect(hits.filter((hit) => hit.body.includes(PLACEHOLDER.number))).toEqual(
      [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBe(CARD);
    expect(result).toMatchObject({ card: { error: "TypeError" } });
    expect(events.map((event) => event.type)).toEqual(["paused", "refused"]);
    expect(events[1]).toEqual({
      type: "refused",
      url: `http://127.0.0.1:${card.port}/sessions`,
      reason: "cancelled",
    });
    expect(JSON.stringify(events)).not.toContain(PLACEHOLDER.number);
  }, 60_000);

  it("fails the paused request when the relay throws", async () => {
    const { events, result } = await drive(
      stubPaymentRelay(async () => {
        throw new Error(`network down ${PLACEHOLDER.number}`);
      }),
      { ping: PING, other: PING, mismatch: PING, card: CARD },
    );
    expect(hits.filter((hit) => hit.body.includes(PLACEHOLDER.number))).toEqual(
      [],
    );
    expect(result).toMatchObject({ card: { error: "TypeError" } });
    expect(events.map((event) => event.type)).toEqual(["paused", "failed"]);
    expect(events[1]).toMatchObject({ type: "failed", reason: "network" });
    expect(JSON.stringify(events)).not.toContain(PLACEHOLDER.number);
  }, 60_000);
});

function header(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  return key ? headers[key] : undefined;
}
