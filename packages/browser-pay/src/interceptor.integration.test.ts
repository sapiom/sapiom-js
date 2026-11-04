import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import type { PaymentRelay, RelayCallOptions } from "./relay";
import type { HeldPlaceholder, RelayRequest } from "./index";
import { stubPaymentRelay } from "../test/stub-relay";
import {
  VerificationHttpError,
  type VerificationAdapterFactory,
  type VerificationState,
} from "./verification";

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
  userDataDir: string,
  proc: ChildProcess,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `Chrome exited before CDP was ready (${proc.exitCode ?? proc.signalCode})`,
      );
    }
    const endpoint = await readDebuggerEndpoint(userDataDir);
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("CDP endpoint did not come up (DevToolsActivePort missing)");
}

function chromeArgs(userDataDir: string): string[] {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--site-per-process",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

async function killChrome(
  proc: ChildProcess | undefined,
  exited: boolean,
): Promise<void> {
  if (
    !proc?.pid ||
    exited ||
    proc.exitCode !== null ||
    proc.signalCode !== null
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  });
}

/**
 * GitHub runners sometimes leave Chrome alive without writing
 * DevToolsActivePort. One fresh profile is enough when that happens.
 * stderr is kept so a second miss says why.
 */
async function launchChrome(bin: string): Promise<{
  proc: ChildProcess;
  userDataDir: string;
  endpoint: string;
}> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "browser-pay-"));
    const stderr: string[] = [];
    const proc = spawn(bin, chromeArgs(userDataDir), {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(String(chunk));
      if (stderr.length > 40) stderr.shift();
    });
    try {
      const endpoint = await waitForDebugger(userDataDir, proc);
      return { proc, userDataDir, endpoint };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "chrome failed";
      const tail = stderr.join("").trim().slice(-600);
      lastError = new Error(tail ? `${detail}\n${tail}` : detail);
      await killChrome(
        proc,
        proc.exitCode !== null || proc.signalCode !== null,
      );
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
  throw lastError ?? new Error("Chrome did not start");
}

async function readDebuggerEndpoint(
  userDataDir: string,
): Promise<string | undefined> {
  try {
    const text = await readFile(
      path.join(userDataDir, "DevToolsActivePort"),
      "utf8",
    );
    const [port, wsPath] = text.split("\n");
    if (!port?.trim() || !wsPath?.trim()) return undefined;
    return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
  } catch {
    return undefined;
  }
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
    let chromeExited = false;
    let userDataDir: string;
    let cdpUrl: string;
    let merchant: { server: http.Server; port: number };
    let card: { server: http.Server; port: number };
    const hits: Hit[] = [];

    beforeAll(async () => {
      const launched = await launchChrome(chromeBin ?? "chrome-missing");
      chrome = launched.proc;
      userDataDir = launched.userDataDir;
      cdpUrl = launched.endpoint;
      chrome.on("exit", () => {
        chromeExited = true;
      });
      card = await startServer(hits, FRAME_HTML, "127.0.0.1");
      merchant = await startServer(
        hits,
        `<!doctype html><title>merchant</title><iframe src="http://127.0.0.1:${card.port}/frame.html"></iframe>`,
        "localhost",
      );
    }, 50_000);

    afterAll(async () => {
      await killChrome(chrome, chromeExited);
      await new Promise((resolve) => {
        if (merchant) merchant.server.close(() => resolve(undefined));
        else resolve(undefined);
      });
      await new Promise((resolve) => {
        if (card) card.server.close(() => resolve(undefined));
        else resolve(undefined);
      });
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      hits.length = 0;
    });

    async function drive(
      relay: PaymentRelay,
      bodies: { ping: string; other?: string; mismatch?: string; card: string },
      timeoutMs = 5_000,
      verificationAdapter?: VerificationAdapterFactory,
    ) {
      const events: InterceptorEvent[] = [];
      const calls: RelayRequest[] = [];
      const wrapped: PaymentRelay = {
        verification: relay.verification,
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
        verificationAdapter,
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
        return {
          events,
          calls,
          result,
          merchantOrigin,
          verification: handle.verification,
        };
      } finally {
        // Closing a connectOverCDP browser can terminate Chrome. Close the page
        // only; the interceptor's own connection is detached below.
        await page?.close().catch(() => {});
        await handle.detach();
        void browser;
      }
    }

    it.each([
      {
        reason: "timeout",
        error: () => new DOMException("registration timed out", "TimeoutError"),
      },
      {
        reason: "HTTP 409 observer mismatch",
        error: () =>
          new VerificationHttpError(409, "verification_observer_mismatch"),
      },
    ])(
      "keeps checkout working when registration fails: $reason",
      async ({ error }) => {
        const register = jest.fn(async () => {
          throw error();
        });
        const sync = jest.fn();
        const report = jest.fn();
        const { result, verification } = await drive(
          {
            ...stubPaymentRelay(async () => ({
              outcome: "relayed",
              response: {
                status: 201,
                headers: { "content-type": "application/json" },
                body: '{"id":"same-card"}',
              },
            })),
            verification: { register, sync, report },
          },
          { ping: PING, card: CARD },
        );
        expect(result).toMatchObject({
          ping: { status: 200 },
          card: { status: 201 },
        });
        expect(verification).toBeUndefined();
        expect(register).toHaveBeenCalledTimes(1);
        expect(sync).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
      },
      60000,
    );

    it("captures a challenge on the same connection without emitting another card relay", async () => {
      let state: VerificationState = {
        id: "verification",
        version: 1,
        status: "preparing",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        merchantOrigin: "http://localhost",
        total: { amount: "11.00", currency: "USD" },
        challengeCaptured: false,
        launchClaimed: false,
        checkRequested: false,
        continuationClaimed: false,
      };
      const reports: Record<string, unknown>[] = [];
      const relay: PaymentRelay = {
        ...stubPaymentRelay(async () => ({
          outcome: "relayed",
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"id":"same-session"}',
          },
        })),
        verification: {
          register: async () => state,
          sync: async () => state,
          report: async (_id, report) => {
            reports.push(report);
            state = {
              ...state,
              version: state.version + 1,
              status: "requires_action",
              challengeCaptured: true,
            };
            return state;
          },
        },
      };
      const { events } = await drive(
        relay,
        { ping: PING, card: CARD },
        5000,
        () => ({
          inspect: async (request) =>
            request.url.endsWith("/collect")
              ? { capture: { url: request.url, body: request.body } }
              : "continue",
          relayed: () => {},
          reconcile: async () => null,
        }),
      );
      expect(hits.filter((hit) => hit.path === "/collect")).toHaveLength(0);
      expect(
        reports.find((report) => report.kind === "challenge_observed"),
      ).toMatchObject({ capture: { body: PING } });
      expect(events.filter((event) => event.type === "relayed")).toHaveLength(
        2,
      );
    }, 60000);

    it("preserves ordinary traffic and fulfilled card responses when observer callbacks throw", async () => {
      const state: VerificationState = {
        id: "verification",
        version: 1,
        status: "preparing",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        merchantOrigin: "http://localhost",
        total: { amount: "11.00", currency: "USD" },
        challengeCaptured: false,
        launchClaimed: false,
        checkRequested: false,
        continuationClaimed: false,
      };
      const { events, result } = await drive(
        {
          ...stubPaymentRelay(async () => ({
            outcome: "relayed",
            response: {
              status: 201,
              headers: { "content-type": "application/json" },
              body: '{"id":"same-card"}',
            },
          })),
          verification: {
            register: async () => state,
            sync: async () => state,
            report: async () => state,
          },
        },
        { ping: PING, card: CARD },
        5000,
        () => ({
          inspect: async () => {
            throw new Error("inspection failed");
          },
          relayed: () => {
            throw new Error("observation failed");
          },
          reconcile: async () => null,
        }),
      );
      expect(result).toMatchObject({
        ping: { status: 200 },
        unrelated: { status: 200 },
        card: { status: 201, text: '{"id":"same-card"}' },
      });
      expect(events.some((event) => event.type === "failed")).toBe(false);
      expect(events.filter((event) => event.type === "relayed")).toHaveLength(
        2,
      );
    }, 60000);
    it("automatically waits for the native callback and continues once on the original browser", async () => {
      let ready = false;
      let submissions = 0;
      let cardRelays = 0;
      let continuations = 0;
      let state: VerificationState;
      const creq = Buffer.from(
        JSON.stringify({
          acsTransID: "11111111-1111-4111-8111-111111111111",
          threeDSServerTransID: "22222222-2222-4222-8222-222222222222",
          messageType: "CReq",
          messageVersion: "2.2.0",
          challengeWindowSize: "05",
        }),
      ).toString("base64url");
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        if (req.url === "/") {
          res.setHeader("content-type", "text/html");
          res.end(`<!doctype html><title>checkout</title><script>
            window.callbacks = 0;
            window.addEventListener('message', event => {
              if (event.origin === location.origin && event.data?.type === '3ds_completed') window.callbacks++;
            });
          </script>`);
        } else if (req.url?.startsWith("/payments_api/redirect/show")) {
          res.setHeader("content-type", "text/html");
          res.end(
            ready
              ? '<script>window.top.postMessage({type:"3ds_completed"}, "*");</script>'
              : `<!doctype html><iframe name="acs"></iframe><form target="acs" method="POST" action="https://bank.example/challenge"><input name="creq" value="${creq}"></form><script>document.forms[0].submit()</script>`,
          );
        } else {
          const operation = JSON.parse(body || "{}").operationName;
          if (operation === "SubmitForCompletion") submissions++;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              data: {
                receipt: ready
                  ? {
                      id: "receipt",
                      __typename: "ProcessedReceipt",
                      purchaseOrder: {
                        payment: {
                          paymentLines: [
                            { paymentMethod: { sessionId: "same-card" } },
                          ],
                        },
                      },
                      paymentDetails: {
                        paymentAmount: { amount: "11", currencyCode: "USD" },
                      },
                      orderCreationStatus: {
                        __typename: "OrderCreationSucceeded",
                      },
                      orderIdentity: { id: "order" },
                    }
                  : null,
              },
            }),
          );
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      state = {
        id: "verification",
        version: 1,
        status: "preparing",
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        merchantOrigin: origin,
        total: { amount: "11.00", currency: "USD" },
        challengeCaptured: false,
        launchClaimed: false,
        checkRequested: false,
        continuationClaimed: false,
      };
      const handle = await attachInterceptor(cdpUrl, {
        profileId: "shopify-card-vault",
        placeholder: PLACEHOLDER,
        relay: {
          ...stubPaymentRelay(async () => {
            cardRelays++;
            return {
              outcome: "relayed",
              response: {
                status: 200,
                headers: { "content-type": "application/json" },
                body: '{"id":"same-card"}',
              },
            };
          }),
          verification: {
            register: async () => state,
            sync: async () => state,
            report: async (_id, report) => {
              state = { ...state, version: state.version + 1 };
              if (report.kind === "challenge_observed") {
                expect(report.capture).toEqual({
                  url: "https://bank.example/challenge",
                  body: "creq=" + creq,
                });
                state = {
                  ...state,
                  status: "requires_action",
                  challengeCaptured: true,
                };
              }
              if (report.kind === "continuation_started") {
                continuations++;
                state.continuationClaimed = true;
              }
              if (report.kind === "checkout_observed")
                state = {
                  ...state,
                  status: "ended",
                  observation: { outcome: "confirmed", source: "runner" },
                };
              return state;
            },
          },
        },
      });
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP(cdpUrl);
      const page = await browser.contexts()[0].newPage();
      try {
        await page.goto(origin);
        await page.evaluate(
          async ({ cardBody, submitBody }) => {
            await fetch("/sessions", { method: "POST", body: cardBody });
            await fetch("/checkouts/internal/graphql/persisted", {
              method: "POST",
              body: JSON.stringify(submitBody),
            });
            const iframe = (globalThis as any).document.createElement("iframe");
            iframe.src = "/payments_api/redirect/show?opaque=existing";
            (globalThis as any).document.body.append(iframe);
          },
          {
            cardBody: CARD,
            submitBody: {
              operationName: "SubmitForCompletion",
              variables: {
                input: {
                  payment: {
                    paymentLines: [
                      {
                        paymentMethod: {
                          directPaymentMethod: { sessionId: "same-card" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        );
        const until = async (test: () => boolean) => {
          const deadline = Date.now() + 20000;
          while (!test() && Date.now() < deadline)
            await page.waitForTimeout(50);
          expect(test()).toBe(true);
        };
        await until(() => state.challengeCaptured);
        state = {
          ...state,
          version: state.version + 1,
          launchClaimed: true,
          checkRequested: true,
        };
        await page.waitForTimeout(2200);
        expect(continuations).toBe(0);
        expect(await page.evaluate(() => (globalThis as any).callbacks)).toBe(
          0,
        );
        ready = true;
        await until(() => continuations === 1);
        await page.waitForFunction(() => (globalThis as any).callbacks === 1);
        expect(await page.evaluate(() => (globalThis as any).callbacks)).toBe(
          1,
        );
        await page.evaluate(async () => {
          await fetch(
            "/checkouts/internal/graphql/persisted?operationName=PollForReceipt",
            {
              method: "POST",
              body: JSON.stringify({
                id: "b99547c8e17e88f985ec0e11a844dd1305bf14cf70e41ca10954899050ffc567",
                operationName: "PollForReceipt",
                variables: { receiptId: "receipt", sessionToken: "private" },
              }),
            },
          );
        });
        await until(() => state.status === "ended");
        expect((await handle.verification!.wait()).observation?.source).toBe(
          "runner",
        );
        expect([submissions, cardRelays, continuations]).toEqual([1, 1, 1]);
      } finally {
        await page.close();
        await handle.detach();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60000);

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
      expect([
        ["paused", "relayed", "paused", "relayed"],
        ["paused", "paused", "relayed", "relayed"],
      ]).toContainEqual(events.map((event) => event.type));
      expect(events.filter((event) => event.type === "relayed")).toEqual([
        expect.objectContaining({ status: 201 }),
        expect.objectContaining({ status: 201 }),
      ]);
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
        url: `http://127.0.0.1:${card.port}`,
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
