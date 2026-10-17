import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import type { PaymentRelay, RelayCallOptions } from "./relay";
import type { HeldPlaceholder, RelayRequest } from "./index";
import { stubPaymentRelay } from "../test/stub-relay";

const nodeRequire = createRequire(__filename);

const NUMBER = "4242424242424242";
const EXP_MONTH = 12;
const EXP_YEAR = 2028;
const CVC = "123";

const PLACEHOLDER: HeldPlaceholder = {
  number: NUMBER,
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
    number: NUMBER,
    month: EXP_MONTH,
    year: EXP_YEAR,
    verification_value: "999",
  },
});
const CARD = JSON.stringify({
  credit_card: {
    number: NUMBER,
    month: EXP_MONTH,
    year: EXP_YEAR,
    verification_value: CVC,
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
  host: string,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const pathOnly = (req.url ?? "").split("?")[0];
    if (
      req.method === "GET" &&
      (pathOnly === "/" || pathOnly === "/frame.html")
    ) {
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
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  try {
    const playwrightPath = nodeRequire(
      "playwright",
    ).chromium.executablePath() as string;
    if (playwrightPath && existsSync(playwrightPath)) return playwrightPath;
  } catch {
    return undefined;
  }
  return undefined;
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

const chromeBin = findChrome();
if (!chromeBin) {
  process.stderr.write(
    "browser-pay: skipping Chrome integration tests. Install Google Chrome or Chromium, or set CHROME_PATH.\n",
  );
}

(chromeBin ? describe : describe.skip)(
  "attachInterceptor on headless Chromium",
  () => {
    let chrome: ChildProcess;
    let userDataDir: string;
    let cdpUrl: string;
    let merchant: { server: http.Server; port: number };
    let card: { server: http.Server; port: number };
    const hits: Hit[] = [];

    beforeAll(async () => {
      userDataDir = await mkdtemp(path.join(os.tmpdir(), "browser-pay-"));
      const port = await freePort();
      chrome = spawn(
        chromeBin ?? "chrome-missing",
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--site-per-process",
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
      card = await startServer(hits, FRAME_HTML, "127.0.0.1");
      merchant = await startServer(
        hits,
        `<!doctype html><title>merchant</title><iframe src="http://127.0.0.1:${card.port}/frame.html"></iframe>`,
        "localhost",
      );
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
      timeoutMs = 5_000,
    ) {
      const events: InterceptorEvent[] = [];
      const calls: RelayRequest[] = [];
      const wrapped: PaymentRelay = {
        relay: async (request, options) => {
          calls.push(request);
          return relay.relay(request, options);
        },
      };
      const handle = await attachInterceptor(cdpUrl, {
        relay: wrapped,
        placeholder: PLACEHOLDER,
        profileId: "shopify-card-vault",
        timeoutMs,
      });
      handle.on((event) => events.push(event));
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP(cdpUrl);
      let page: import("playwright").Page | undefined;
      try {
        const context = browser.contexts()[0];
        page = context.pages()[0] ?? (await context.newPage());
        const merchantOrigin = `http://localhost:${merchant.port}`;
        await page.goto(`${merchantOrigin}/`, {
          waitUntil: "domcontentloaded",
        });
        // The driver's Playwright session is a second CDP client on this browser.
        expect(
          await page.evaluate(
            () =>
              (globalThis as { document?: { title: string } }).document?.title,
          ),
        ).toBe("merchant");
        let frame = page
          .frames()
          .find((candidate) => candidate.url().includes(String(card.port)));
        const frameDeadline = Date.now() + 5_000;
        while (!frame && Date.now() < frameDeadline) {
          await page.waitForTimeout(50);
          frame = page
            .frames()
            .find((candidate) => candidate.url().includes(String(card.port)));
        }
        if (!frame) {
          const urls = page.frames().map((candidate) => candidate.url());
          const count = await page
            .locator("iframe")
            .count()
            .catch(() => -1);
          throw new Error(
            `cross-origin card frame was not attached (iframes=${count}; ${urls.join(" | ")})`,
          );
        }
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
          outcome: "relayed",
          response: {
            status: 201,
            headers: { "content-type": "application/json" },
            body: '{"id":"sess_test"}',
          },
        })),
        { ping: PING, other: UNRELATED, mismatch: MISMATCH, card: CARD },
      );

      const paths = hits.map((hit) => hit.path);
      expect(paths.filter((item) => item === "/collect").length).toBe(1);
      expect(hits.find((hit) => hit.path === "/collect")?.body).toBe(PING);
      expect(hits.find((hit) => hit.path === "/other")?.body).toBe(UNRELATED);
      expect(paths.filter((item) => item === "/sessions")).toEqual([]);

      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({
        profileId: "shopify-card-vault",
        injectionRef: "inj_integration",
        pageOrigin: merchantOrigin,
        request: {
          method: "POST",
          url: `http://127.0.0.1:${card.port}/sessions`,
          body: CARD,
        },
      });
      expect(calls[0].request.body).toBe(MISMATCH);
      expect(calls[0].idempotencyKey).not.toBe(calls[1].idempotencyKey);
      expect(calls[1].pageOrigin).not.toContain(String(card.port));
      expect(calls[0].request.headers["content-type"]).toBe("application/json");
      expect(events.filter((event) => event.type === "paused")).toEqual([
        expect.objectContaining({ type: "paused", targetType: "iframe" }),
        expect.objectContaining({ type: "paused", targetType: "iframe" }),
      ]);

      expect(result).toEqual({
        ping: {
          status: 200,
          text: JSON.stringify({ ok: true, via: "server" }),
        },
        unrelated: {
          status: 200,
          text: JSON.stringify({ ok: true, via: "server" }),
        },
        mismatch: { status: 201, text: '{"id":"sess_test"}' },
        card: { status: 201, text: '{"id":"sess_test"}' },
      });
      expect(events.map((event) => event.type)).toEqual([
        "paused",
        "relayed",
        "paused",
        "relayed",
      ]);
      expect(events[3]).toMatchObject({ type: "relayed", status: 201 });
      expect(JSON.stringify(events)).not.toContain(PLACEHOLDER.number);
    }, 60_000);

    it("fails a refused placeholder request and never delivers it", async () => {
      const { events, calls, result } = await drive(
        stubPaymentRelay(async () => ({
          outcome: "refused",
          reason: "already_relayed",
        })),
        { ping: PING, other: PING, mismatch: PING, card: CARD },
      );
      expect(
        hits.filter((hit) => hit.body.includes(PLACEHOLDER.number)),
      ).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0].request.body).toBe(CARD);
      expect(result).toMatchObject({ card: { error: "TypeError" } });
      expect(events.map((event) => event.type)).toEqual(["paused", "refused"]);
      expect(events[1]).toEqual({
        type: "refused",
        url: `http://127.0.0.1:${card.port}/sessions`,
        reason: "already_relayed",
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
      expect(
        hits.filter((hit) => hit.body.includes(PLACEHOLDER.number)),
      ).toEqual([]);
      expect(result).toMatchObject({ card: { error: "TypeError" } });
      expect(events.map((event) => event.type)).toEqual(["paused", "failed"]);
      expect(events[1]).toMatchObject({ type: "failed", reason: "network" });
      expect(JSON.stringify(events)).not.toContain(PLACEHOLDER.number);
    }, 60_000);

    it("fails a relay that does not finish before the timeout", async () => {
      const { events, result } = await drive(
        stubPaymentRelay(
          (_request, options?: RelayCallOptions) =>
            new Promise((_resolve, reject) => {
              const abort = () => reject(new Error("Payment relay timed out"));
              if (options?.signal?.aborted) abort();
              else
                options?.signal?.addEventListener("abort", abort, {
                  once: true,
                });
            }),
        ),
        { ping: PING, other: PING, mismatch: PING, card: CARD },
        400,
      );
      expect(
        hits.filter((hit) => hit.body.includes(PLACEHOLDER.number)),
      ).toEqual([]);
      expect(result).toMatchObject({ card: { error: "TypeError" } });
      expect(events.map((event) => event.type)).toEqual(["paused", "failed"]);
      expect(events[1]).toMatchObject({ type: "failed", reason: "timeout" });
    }, 60_000);

    it("does not deliver a placeholder sent as a query or after a multipart boundary", async () => {
      const events: InterceptorEvent[] = [];
      const calls: RelayRequest[] = [];
      const handle = await attachInterceptor(cdpUrl, {
        relay: {
          relay: async (request) => {
            calls.push(request);
            return {
              outcome: "relayed",
              response: {
                status: 201,
                headers: { "content-type": "text/plain" },
                body: "ok",
              },
            };
          },
        },
        placeholder: PLACEHOLDER,
        profileId: "shopify-card-vault",
        timeoutMs: 5_000,
      });
      handle.on((event) => events.push(event));
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP(cdpUrl);
      const page =
        browser.contexts()[0].pages()[0] ??
        (await browser.contexts()[0].newPage());
      try {
        await page.goto(`http://localhost:${merchant.port}/`, {
          waitUntil: "domcontentloaded",
        });
        let frame = page
          .frames()
          .find((candidate) => candidate.url().includes(String(card.port)));
        const frameDeadline = Date.now() + 5_000;
        while (!frame && Date.now() < frameDeadline) {
          await page.waitForTimeout(50);
          frame = page
            .frames()
            .find((candidate) => candidate.url().includes(String(card.port)));
        }
        if (!frame) throw new Error("cross-origin card frame was not attached");
        const boundary = "----WebKitFormBoundary123";
        const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="number"\r\n\r\n4242 4242 4242 4242\r\n--${boundary}--`;
        const outcome = await frame.evaluate(
          async ({ query, multipartBody, formBoundary }) => {
            const queryResult = await fetch(query).then(
              (response) => ({ status: response.status }),
              (error: Error) => ({ error: error.name }),
            );
            const formResult = await fetch("/sessions", {
              method: "POST",
              headers: {
                "content-type": `multipart/form-data; boundary=${formBoundary}`,
              },
              body: multipartBody,
            }).then(
              async (response) => ({
                status: response.status,
                text: await response.text(),
              }),
              (error: Error) => ({ error: error.name }),
            );
            return { queryResult, formResult };
          },
          {
            query: `/lookup?number=${PLACEHOLDER.number}`,
            multipartBody: multipart,
            formBoundary: boundary,
          },
        );
        expect(outcome.queryResult).toEqual({ status: 201 });
        expect(outcome.formResult).toEqual({ status: 201, text: "ok" });
        expect(
          hits.filter((hit) => hit.body.includes(PLACEHOLDER.number)),
        ).toEqual([]);
        expect(hits.map((hit) => hit.path)).not.toContain(
          `/lookup?number=${PLACEHOLDER.number}`,
        );
        expect(calls).toHaveLength(2);
        expect(
          calls.some((call) => call.request.url.includes(PLACEHOLDER.number)),
        ).toBe(true);
        expect(
          calls.some((call) =>
            call.request.body.includes("4242 4242 4242 4242"),
          ),
        ).toBe(true);
        expect(events.filter((event) => event.type === "paused")).toHaveLength(
          2,
        );
        expect(events.some((event) => event.type === "failed")).toBe(false);
      } finally {
        await page.close().catch(() => {});
        await handle.detach();
        void browser;
      }
    }, 60_000);
  },
);
