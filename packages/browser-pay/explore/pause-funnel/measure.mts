import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:https";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { textHoldsPlaceholderNumber } from "../../src/detect.ts";
import { strictCardSession, type HeldCard } from "./strict.mts";

const PAN = "4242424242424242";
const HELD: HeldCard = {
  number: PAN,
  expMonth: 12,
  expYear: 2028,
  cvc: "123",
};
const CARD = JSON.stringify({
  credit_card: {
    number: PAN,
    name: "Test User",
    month: HELD.expMonth,
    year: HELD.expYear,
    verification_value: HELD.cvc,
  },
  payment_session_scope: "substitute.local",
});
const ROUNDS = 5;
const CLK_TCK = 100;
const ARTIFACT = "/opt/cursor/artifacts/pause-funnel-runs.json";

type ContinuePolicy = "baseline" | "non-post";
type MatchKind = "loose" | "strict";

interface Pattern {
  urlPattern: string;
  requestStage: "Request";
  resourceType?: string;
}

interface Mode {
  id: string;
  patterns: Pattern[] | null;
  continuePolicy: ContinuePolicy;
  match: MatchKind;
  waitForDebugger: boolean;
}

const TYPE_PATTERNS: Pattern[] = ["XHR", "Fetch", "Document"].map(
  (resourceType) => ({
    urlPattern: "*",
    requestStage: "Request",
    resourceType,
  }),
);
const FETCH_XHR: Pattern[] = ["XHR", "Fetch"].map((resourceType) => ({
  urlPattern: "*",
  requestStage: "Request",
  resourceType,
}));
const STAR: Pattern[] = [{ urlPattern: "*", requestStage: "Request" }];

const MODES: Mode[] = [
  {
    id: "none",
    patterns: null,
    continuePolicy: "baseline",
    match: "loose",
    waitForDebugger: false,
  },
  {
    id: "baseline",
    patterns: STAR,
    continuePolicy: "baseline",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "types",
    patterns: TYPE_PATTERNS,
    continuePolicy: "baseline",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "types-no-doc",
    patterns: FETCH_XHR,
    continuePolicy: "baseline",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "method",
    patterns: STAR,
    continuePolicy: "non-post",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "types-method",
    patterns: TYPE_PATTERNS,
    continuePolicy: "non-post",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "host",
    patterns: [
      {
        urlPattern: "*checkout.pci.shopifyinc.com*",
        requestStage: "Request",
      },
    ],
    continuePolicy: "baseline",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "sessions",
    patterns: [
      {
        urlPattern: "*checkout.pci.shopifyinc.com*/sessions*",
        requestStage: "Request",
      },
    ],
    continuePolicy: "baseline",
    match: "loose",
    waitForDebugger: true,
  },
  {
    id: "funnel",
    patterns: FETCH_XHR,
    continuePolicy: "non-post",
    match: "strict",
    waitForDebugger: true,
  },
  {
    id: "funnel-sessions",
    patterns: [
      {
        urlPattern: "*checkout.pci.shopifyinc.com*/sessions*",
        requestStage: "Request",
      },
    ],
    continuePolicy: "non-post",
    match: "strict",
    waitForDebugger: true,
  },
  {
    id: "sessions-nowait",
    patterns: [
      {
        urlPattern: "*checkout.pci.shopifyinc.com*/sessions*",
        requestStage: "Request",
      },
    ],
    continuePolicy: "non-post",
    match: "strict",
    waitForDebugger: false,
  },
];

interface Hit {
  method: string;
  host: string;
  path: string;
  bytes: number;
  holdsPan: boolean;
  contentType: string;
}

interface PauseRec {
  url: string;
  method: string;
  resourceType: string;
  targetType: string;
  targetUrl: string;
  stallMs: number;
  matchMs: number;
  continueMs: number;
  action: "continue" | "fulfill" | "fail";
  loose: boolean;
  strict: boolean;
  hasPostData: boolean;
  postDataInline: boolean;
  postBytes: number;
  fetchPostBytes: number | null;
  fetchPostError: string | null;
  networkPostBytes: number | null;
  networkPostError: string | null;
}

interface Trial {
  mode: string;
  round: number;
  loadMs: number | null;
  payMs: number | null;
  pageErrors: string[];
  paused: number;
  continued: number;
  fulfilled: number;
  failed: number;
  cardPaused: number;
  cardFulfilled: number;
  originGotCard: boolean;
  originSessions: number;
  stallMs: number[];
  cardStallMs: number[];
  matchMs: number[];
  continueMs: number[];
  nodeCpuMs: number;
  chromeCpuMs: number;
  resourceTypes: Record<string, number>;
  error: string | null;
  serverHits: number;
  iframeTargets: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function range(values: number[]): [number, number] | null {
  if (values.length === 0) return null;
  return [Math.min(...values), Math.max(...values)];
}

function looseHit(url: string, body: string): boolean {
  return (
    textHoldsPlaceholderNumber(url, PAN) ||
    (body.length > 0 && textHoldsPlaceholderNumber(body, PAN))
  );
}

function selfCheck(): void {
  const tabbed = `{"credit_card":{"number":"4242\t4242\t4242\t4242","month":12,"year":2028,"verification_value":"123"}}`;
  const jsonTab = JSON.stringify({
    credit_card: {
      number: "4242\t4242\t4242\t4242",
      month: 12,
      year: 2028,
      verification_value: "123",
    },
  });
  const wrongCvc = CARD.replace('"123"', '"999"');
  const encoded = [...PAN].map((digit) => `%3${digit}`).join("");
  const unicode = `{"credit_card":{"number":"4242\\u00204242\\u00204242\\u00204242","month":12,"year":2028,"verification_value":"123"}}`;
  const urlencoded = `credit_card%5Bnumber%5D=${PAN}&credit_card%5Bmonth%5D=12&credit_card%5Byear%5D=2028&credit_card%5Bverification_value%5D=123`;
  const multipart = [
    "--b",
    'Content-Disposition: form-data; name="credit_card[number]"',
    "",
    PAN,
    "--b",
    'Content-Disposition: form-data; name="credit_card[month]"',
    "",
    "12",
    "--b",
    'Content-Disposition: form-data; name="credit_card[year]"',
    "",
    "2028",
    "--b",
    'Content-Disposition: form-data; name="credit_card[verification_value]"',
    "",
    "123",
    "--b--",
    "",
  ].join("\r\n");
  const cases: Array<[string, string, boolean, boolean]> = [
    ["exact-json", CARD, true, true],
    ["wrong-cvc", wrongCvc, true, false],
    ["raw-tab-number", tabbed, true, false],
    ["json-backslash-t", jsonTab, false, false],
    ["unicode-escapes", unicode, true, false],
    ["percent-digits", encoded, true, false],
    ["urlencoded", urlencoded, true, false],
    ["multipart", multipart, true, false],
    ["checkout-update", JSON.stringify({ step: 1 }), false, false],
    ["two-digit-year", CARD.replace('"year":2028', '"year":28'), true, true],
  ];
  const failed: string[] = [];
  for (const [name, body, expectLoose, expectStrict] of cases) {
    const loose = looseHit("https://checkout.pci.shopifyinc.com/sessions", body);
    const strict = strictCardSession(body, HELD);
    if (loose !== expectLoose || strict !== expectStrict) {
      failed.push(
        `${name} loose=${loose}/${expectLoose} strict=${strict}/${expectStrict}`,
      );
    }
  }
  const urlOnly = looseHit(
    `https://shop.example/pay?number=${PAN}`,
    "",
  );
  if (!urlOnly || strictCardSession("", HELD)) {
    failed.push("url-only loose should hit and strict should miss");
  }
  if (failed.length > 0) {
    throw new Error(failed.join("\n"));
  }
}

class Cdp {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly events: Array<(message: CdpMessage) => void> = [];

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const raw = event.data;
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : String(raw);
      const message = JSON.parse(text) as CdpMessage;
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(
            new Error(
              `${waiter.method}: ${message.error.message || "CDP call failed"}`,
            ),
          );
          return;
        }
        waiter.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.events) listener(message);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
    });
    return new Cdp(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.socket.send(JSON.stringify(payload));
    return result;
  }

  close(): void {
    this.socket.close();
  }
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  sessionId?: string;
  error?: { message?: string };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cpuTicks(marker: string): number {
  let total = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let command = "";
    try {
      command = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!command.includes(marker)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      total += Number(rest[11]) + Number(rest[12]);
    } catch {
      continue;
    }
  }
  return total;
}

function checkoutHtml(pciOrigin: string): string {
  const scripts = Array.from({ length: 12 }, (_, index) =>
    index === 0
      ? `<script src="/bounce.js"></script>`
      : `<script defer src="/app.js?i=${index}"></script>`,
  ).join("");
  const styles = Array.from(
    { length: 4 },
    (_, index) => `<link rel="stylesheet" href="/app.css?i=${index}">`,
  ).join("");
  const images = Array.from(
    { length: 8 },
    (_, index) => `<img src="/pixel.gif?i=${index}" alt="">`,
  ).join("");
  return `<!doctype html><meta charset="utf-8"><title>checkout</title>
<link rel="icon" href="data:,">
${styles}
<link rel="preload" as="font" type="font/woff2" href="/f.woff2?i=0" crossorigin>
<link rel="preload" as="font" type="font/woff2" href="/f.woff2?i=1" crossorigin>
${scripts}
<body>
${images}
<script>
const pciOrigin = ${JSON.stringify(pciOrigin)};
const errors = [];
function xhr(url) {
  return new Promise((resolve) => {
    const req = new XMLHttpRequest();
    req.open("GET", url);
    req.onload = () => resolve(req.status);
    req.onerror = () => { errors.push(url); resolve(0); };
    req.send();
  });
}
async function run() {
  const ready = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.data && event.data.kind === "ready") resolve(event.data);
    });
  });
  const frame = document.createElement("iframe");
  frame.src = pciOrigin + "/pci.html";
  document.body.appendChild(frame);
  const t0 = performance.now();
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push(xhr("/xhr?i=" + i));
  for (let i = 0; i < 2; i++) jobs.push(fetch("/fetch?i=" + i).then((res) => res.text()).catch(() => errors.push("fetch")));
  await Promise.all([ready, ...jobs]);
  const loadMs = performance.now() - t0;
  const pay0 = performance.now();
  const paid = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.data && event.data.kind === "paid") resolve(event.data);
    });
  });
  frame.contentWindow.postMessage({ kind: "pay" }, "*");
  const posts = [0, 1, 2].map((step) =>
    fetch("/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step }),
    }).then((res) => res.status).catch(() => { errors.push("update"); return 0; }),
  );
  const card = await paid;
  const statuses = await Promise.all(posts);
  const payMs = performance.now() - pay0;
  window.__result = { loadMs, payMs, errors, card, statuses };
}
run().catch((error) => {
  window.__result = { loadMs: null, payMs: null, errors: [String(error)], card: null, statuses: [] };
});
</script>`;
}

function pciHtml(card: string): string {
  return `<!doctype html><meta charset="utf-8"><title>pci</title>
<link rel="stylesheet" href="/pci.css">
<script src="/pci.js?i=0"></script>
<script src="/pci.js?i=1"></script>
<script src="/pci.js?i=2"></script>
<img src="/pixel.gif?pci=1" alt="">
<script>
const card = ${JSON.stringify(card)};
parent.postMessage({ kind: "ready" }, "*");
window.addEventListener("message", async (event) => {
  if (!event.data || event.data.kind !== "pay") return;
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: card,
    });
    const text = await res.text();
    parent.postMessage({ kind: "paid", status: res.status, text }, "*");
  } catch (error) {
    parent.postMessage({ kind: "paid", status: 0, error: String(error) }, "*");
  }
});
</script>`;
}

function edgeHtml(pciOrigin: string): string {
  return `<!doctype html><meta charset="utf-8"><title>edge</title>
<body><script>
const pciOrigin = ${JSON.stringify(pciOrigin)};
const pan = ${JSON.stringify(PAN)};
async function post(url, body, headers) {
  const res = await fetch(url, { method: "POST", headers, body });
  return { url, status: res.status, bytes: body.length };
}
async function run() {
  const out = { steps: [], errors: [] };
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sw = await fetch("/sw-hit");
    out.steps.push({ name: "service-worker", status: sw.status, body: await sw.text() });
  } catch (error) {
    out.errors.push("service-worker " + error);
  }
  const frameReady = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.data && event.data.kind === "ready") resolve(true);
    });
  });
  const frame = document.createElement("iframe");
  frame.src = pciOrigin + "/pci.html";
  document.body.appendChild(frame);
  await frameReady;
  const paid = new Promise((resolve) => {
    window.addEventListener("message", (event) => {
      if (event.data && event.data.kind === "paid") resolve(event.data);
    });
  });
  frame.contentWindow.postMessage({ kind: "pay" }, "*");
  out.steps.push({ name: "pci-card", ...(await paid) });
  const tabbed = '{"credit_card":{"number":"4242\\t4242\\t4242\\t4242","month":12,"year":2028,"verification_value":"123"}}'.replaceAll("\\\\t", "\\t");
  const unicode = '{"credit_card":{"number":"4242\\\\u00204242\\\\u00204242\\\\u00204242","month":12,"year":2028,"verification_value":"123"}}';
  const urlencoded = "credit_card%5Bnumber%5D=" + pan + "&credit_card%5Bmonth%5D=12&credit_card%5Byear%5D=2028&credit_card%5Bverification_value%5D=123";
  const multipart = ["--b", 'Content-Disposition: form-data; name="number"', "", pan, "--b--", ""].join("\\r\\n");
  const jobs = [
    post("/update", JSON.stringify({ step: "edge" }), { "content-type": "application/json" }),
    post("/form", urlencoded, { "content-type": "application/x-www-form-urlencoded" }),
    post("/form-file", multipart, { "content-type": "multipart/form-data; boundary=b" }),
    post("/tabbed", tabbed, { "content-type": "application/json" }),
    post("/unicode", unicode, { "content-type": "application/json" }),
    post("/hop", "redirect-body", { "content-type": "text/plain" }),
    fetch("/pan-url?number=" + pan).then((res) => ({ url: "/pan-url", status: res.status, bytes: 0 })),
  ];
  for (const size of [64 * 1024, 512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]) {
    jobs.push(post("/bulk?n=" + size, "a".repeat(size), { "content-type": "text/plain" }));
  }
  out.steps.push(...(await Promise.all(jobs)));
  window.__result = out;
}
run().catch((error) => { window.__result = { steps: [], errors: [String(error)] }; });
</script>`;
}

const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function startSubstitute(cert: Buffer, key: Buffer): Promise<{
  server: Server;
  port: number;
  hits: Hit[];
}> {
  const hits: Hit[] = [];
  const server = createServer({ cert, key }, (req, res) => {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", "https://substitute.local");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const text = body.toString("utf8");
      hits.push({
        method: req.method ?? "",
        host,
        path: url.pathname,
        bytes: body.length,
        holdsPan: text.includes(PAN),
        contentType: readString(req.headers["content-type"]),
      });
      const send = (status: number, type: string, payload: string | Buffer) => {
        res.writeHead(status, {
          "content-type": type,
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        res.end(payload);
      };
      if (url.pathname === "/bounce.js") {
        res.writeHead(302, { location: "/land.js", "cache-control": "no-store" });
        res.end();
        return;
      }
      if (url.pathname === "/hop") {
        res.writeHead(302, { location: "/land", "cache-control": "no-store" });
        res.end();
        return;
      }
      if (url.pathname === "/checkout") {
        send(200, "text/html", checkoutHtml(pciOriginFrom(host)));
        return;
      }
      if (url.pathname === "/edge") {
        send(200, "text/html", edgeHtml(pciOriginFrom(host)));
        return;
      }
      if (url.pathname === "/pci.html") {
        send(200, "text/html", pciHtml(CARD));
        return;
      }
      if (url.pathname === "/sw.js") {
        send(
          200,
          "application/javascript",
          `self.addEventListener("fetch", (event) => {
            const path = new URL(event.request.url).pathname;
            if (path === "/sw-hit") event.respondWith(new Response("from-sw", { status: 200 }));
          });`,
        );
        return;
      }
      if (url.pathname === "/pixel.gif") {
        send(200, "image/gif", GIF);
        return;
      }
      if (url.pathname.endsWith(".css")) {
        send(200, "text/css", "body{color:#222}");
        return;
      }
      if (url.pathname.endsWith(".js")) {
        send(200, "application/javascript", "void 0");
        return;
      }
      if (url.pathname.startsWith("/f.woff2")) {
        send(200, "font/woff2", Buffer.alloc(32));
        return;
      }
      if (url.pathname === "/sessions") {
        send(200, "application/json", '{"id":"origin"}');
        return;
      }
      send(200, "application/json", '{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, hits });
    });
  });
}

function pciOriginFrom(hostHeader: string): string {
  const port = hostHeader.split(":")[1] ?? "";
  return `https://checkout.pci.shopifyinc.com:${port}`;
}

async function launchChrome(userDataDir: string): Promise<{
  proc: ChildProcess;
  url: string;
}> {
  const port = await new Promise<number>((resolve, reject) => {
    const finder = spawn("python3", [
      "-c",
      "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()",
    ]);
    let out = "";
    finder.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    finder.on("exit", (code) => {
      if (code !== 0) reject(new Error("port"));
      else resolve(Number(out.trim()));
    });
  });
  const proc = spawn(
    process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--site-per-process",
      "--ignore-certificate-errors",
      "--allow-insecure-localhost",
      "--host-resolver-rules=MAP checkout.pci.shopifyinc.com 127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 15_000;
  let last = "not up";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`chrome exited ${proc.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const body = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return { proc, url: body.webSocketDebuggerUrl };
      }
    } catch (error) {
      last = error instanceof Error ? error.message : "fetch failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`cdp not ready (${last})`);
}

interface SessionInfo {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
}

async function runTrial(
  cdp: Cdp,
  mode: Mode,
  round: number,
  origin: string,
  hits: Hit[],
  marker: string,
  pathName: string,
): Promise<{ trial: Trial; pauses: PauseRec[] }> {
  hits.length = 0;
  const pauses: PauseRec[] = [];
  const sessions = new Map<string, SessionInfo>();
  const byTarget = new Map<string, string>();
  const open = new Set<string>();
  let pageSession = "";
  const arming: Promise<void>[] = [];

  const arm = (
    sessionId: string,
    info: { targetId: string; type: string; url: string },
    waiting: boolean,
  ) => {
    if (byTarget.has(info.targetId)) {
      const extra = cdp
        .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .catch(() => undefined)
        .then(() =>
          cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined),
        );
      arming.push(extra.then(() => undefined));
      return;
    }
    byTarget.set(info.targetId, sessionId);
    sessions.set(sessionId, { sessionId, ...info });
    if (info.type === "page" && !pageSession) pageSession = sessionId;
    const job = (async () => {
      try {
        if (info.type === "page" || info.type === "iframe") {
          await cdp
            .send(
              "Target.setAutoAttach",
              {
                autoAttach: true,
                waitForDebuggerOnStart: mode.waitForDebugger === true,
                flatten: true,
                filter: [{ type: "iframe" }],
              },
              sessionId,
            )
            .catch(() => undefined);
        }
        await cdp.send("Network.enable", {}, sessionId).catch(() => undefined);
        await cdp
          .send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId)
          .catch(() => undefined);
        if (mode.patterns) {
          await cdp.send(
            "Fetch.enable",
            { patterns: mode.patterns },
            sessionId,
          );
        }
      } finally {
        if (waiting) {
          await cdp
            .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
            .catch(() => undefined);
        }
      }
    })();
    arming.push(job);
  };

  const onEvent = (message: CdpMessage) => {
    if (message.method === "Target.attachedToTarget") {
      const params = message.params ?? {};
      const sessionId = readString(params.sessionId);
      const info = params.targetInfo as
        | { targetId?: string; type?: string; url?: string }
        | undefined;
      if (!sessionId || !info?.targetId || !info.type) return;
      arm(sessionId, {
        targetId: info.targetId,
        type: info.type,
        url: readString(info.url),
      }, params.waitingForDebugger === true);
      return;
    }
    if (message.method !== "Fetch.requestPaused" || !mode.patterns) return;
    const sessionId = message.sessionId ?? "";
    const params = message.params ?? {};
    const requestId = readString(params.requestId);
    const request = (params.request ?? {}) as Record<string, unknown>;
    const key = `${sessionId}\n${requestId}`;
    if (!requestId || open.has(key)) return;
    open.add(key);
    void settle(
      sessionId,
      requestId,
      request,
      readString(params.resourceType),
      key,
      readString(params.networkId),
    );
  };

  async function settle(
    sessionId: string,
    requestId: string,
    request: Record<string, unknown>,
    resourceType: string,
    key: string,
    networkId: string,
  ): Promise<void> {
    const started = performance.now();
    const url = readString(request.url);
    const method = readString(request.method) || "GET";
    const inline =
      typeof request.postData === "string" ? request.postData : "";
    const hasPostData = request.hasPostData === true || inline.length > 0;
    const session = sessions.get(sessionId);
    let action: PauseRec["action"] = "continue";
    let body = "";
    let loose = false;
    let strict = false;
    let matchMs = 0;
    let fetchPostBytes: number | null = null;
    let fetchPostError: string | null = null;
    let networkPostBytes: number | null = null;
    let networkPostError: string | null = null;
    try {
      const fast =
        mode.continuePolicy === "non-post"
          ? method.toUpperCase() !== "POST"
          : (method === "GET" || method === "HEAD") &&
            !hasPostData &&
            !textHoldsPlaceholderNumber(url, PAN);
      if (!fast) {
        body = inline;
        if (!body && hasPostData) {
          const fetched = (await cdp.send(
            "Fetch.getRequestPostData",
            { requestId },
            sessionId,
          )) as { postData?: string; base64Encoded?: boolean };
          const raw = readString(fetched.postData);
          body =
            fetched.base64Encoded === true
              ? Buffer.from(raw, "base64").toString("utf8")
              : raw;
        }
        const matchStart = performance.now();
        loose = looseHit(url, body);
        strict = strictCardSession(body, HELD);
        matchMs = performance.now() - matchStart;
        if (url.includes("/bulk") && (inline.length > 1_000_000 || body.length > 1_000_000)) {
          try {
            const fetched = (await cdp.send(
              "Fetch.getRequestPostData",
              { requestId },
              sessionId,
            )) as { postData?: string };
            fetchPostBytes = readString(fetched.postData).length;
          } catch (error) {
            fetchPostError = error instanceof Error ? error.message : "fetch post failed";
          }
          try {
            const fetched = (await cdp.send(
              "Network.getRequestPostData",
              { requestId: networkId || requestId },
              sessionId,
            )) as { postData?: string };
            networkPostBytes = readString(fetched.postData).length;
          } catch (error) {
            networkPostError = error instanceof Error ? error.message : "network post failed";
          }
        }
        const hit = mode.match === "strict" ? strict : loose;
        if (hit) {
          action = "fulfill";
          await cdp.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 201,
              responseHeaders: [
                { name: "content-type", value: "application/json" },
              ],
              body: Buffer.from('{"id":"sess_probe"}').toString("base64"),
            },
            sessionId,
          );
        }
      } else {
        loose = textHoldsPlaceholderNumber(url, PAN);
      }
      if (action === "continue") {
        await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
      }
    } catch {
      action = "fail";
      await cdp
        .send(
          "Fetch.failRequest",
          { requestId, errorReason: "BlockedByClient" },
          sessionId,
        )
        .catch(() => undefined);
    } finally {
      open.delete(key);
      const stallMs = performance.now() - started;
      pauses.push({
        url,
        method,
        resourceType,
        targetType: session?.type ?? "",
        targetUrl: session?.url ?? "",
        stallMs,
        matchMs,
        continueMs: Math.max(0, stallMs - matchMs),
        action,
        loose,
        strict,
        hasPostData,
        postDataInline: inline.length > 0,
        postBytes: body.length || inline.length,
        fetchPostBytes,
        fetchPostError,
        networkPostBytes,
        networkPostError,
      });
    }
  }

  cdp.events.push(onEvent);
  try {
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await cdp
      .send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined);
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: mode.waitForDebugger === true,
      flatten: true,
      filter: [{ type: "page" }, { type: "iframe" }],
    });
    const waitPage = Date.now() + 3_000;
    while (!pageSession && Date.now() < waitPage) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!pageSession) {
      const listed = (await cdp.send("Target.getTargets")) as {
        targetInfos?: Array<{ targetId: string; type: string; url: string }>;
      };
      for (const info of listed.targetInfos ?? []) {
        if (info.type !== "page" || byTarget.has(info.targetId)) continue;
        const attached = (await cdp.send("Target.attachToTarget", {
          targetId: info.targetId,
          flatten: true,
        })) as { sessionId?: string };
        if (attached.sessionId) {
          arm(attached.sessionId, info, false);
        }
      }
    }
    await Promise.all(arming);
    const nodeBefore = process.cpuUsage();
    const chromeBefore = cpuTicks(marker);
    const sessionId = pageSession;
    if (!sessionId) throw new Error("no page session");
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Page.navigate",
      { url: `${origin}${pathName}` },
      sessionId,
    );
    const deadline = Date.now() + 20_000;
    let result: {
      loadMs?: number;
      payMs?: number;
      errors?: string[];
    } | null = null;
    let error: string | null = null;
    while (Date.now() < deadline) {
      const evaluated = (await cdp.send(
        "Runtime.evaluate",
        { expression: "window.__result || null", returnByValue: true },
        sessionId,
      )) as { result?: { value?: typeof result } };
      result = evaluated.result?.value ?? null;
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result) error = "page result missing";
    const nodeDelta = process.cpuUsage(nodeBefore);
    const chromeDelta = cpuTicks(marker) - chromeBefore;
    for (const key of [...open]) {
      const [sid, requestId] = key.split("\n");
      await cdp
        .send(
          "Fetch.failRequest",
          { requestId, errorReason: "BlockedByClient" },
          sid,
        )
        .catch(() => undefined);
    }
    for (const sid of sessions.keys()) {
      await cdp.send("Fetch.disable", {}, sid).catch(() => undefined);
      await cdp
        .send("Target.detachFromTarget", { sessionId: sid })
        .catch(() => undefined);
    }
    await cdp
      .send("Page.navigate", { url: "about:blank" }, sessionId)
      .catch(() => undefined);
    const cardPauses = pauses.filter((pause) => pause.url.includes("/sessions"));
    const continuedPauses = pauses.filter((pause) => pause.action === "continue");
    const resourceTypes: Record<string, number> = {};
    for (const pause of pauses) {
      resourceTypes[pause.resourceType || "unknown"] =
        (resourceTypes[pause.resourceType || "unknown"] ?? 0) + 1;
    }
    const trial: Trial = {
      mode: mode.id,
      round,
      loadMs: result?.loadMs ?? null,
      payMs: result?.payMs ?? null,
      pageErrors: result?.errors ?? [],
      paused: pauses.length,
      continued: continuedPauses.length,
      fulfilled: pauses.filter((pause) => pause.action === "fulfill").length,
      failed: pauses.filter((pause) => pause.action === "fail").length,
      cardPaused: cardPauses.length,
      cardFulfilled: cardPauses.filter((pause) => pause.action === "fulfill").length,
      originGotCard: hits.some((hit) => hit.path === "/sessions" && hit.holdsPan),
      originSessions: hits.filter((hit) => hit.path === "/sessions").length,
      stallMs: continuedPauses.map((pause) => pause.stallMs),
      cardStallMs: cardPauses.map((pause) => pause.stallMs),
      matchMs: pauses.map((pause) => pause.matchMs),
      continueMs: pauses.map((pause) => pause.continueMs),
      nodeCpuMs: (nodeDelta.user + nodeDelta.system) / 1000,
      chromeCpuMs: (chromeDelta / CLK_TCK) * 1000,
      resourceTypes,
      error,
      serverHits: hits.length,
      iframeTargets: [...sessions.values()].filter((session) => session.type === "iframe")
        .length,
    };
    return {
      trial,
      pauses,
      pageResult: result,
      iframeUrls: [...sessions.values()]
        .filter((session) => session.type === "iframe")
        .map((session) => session.url),
    };
  } finally {
    const index = cdp.events.indexOf(onEvent);
    if (index >= 0) cdp.events.splice(index, 1);
  }
}

function summarize(trials: Trial[]) {
  const noneLoad = median(
    trials.filter((trial) => trial.mode === "none" && trial.loadMs !== null).map((trial) => trial.loadMs ?? 0),
  );
  const rows = MODES.map((mode) => {
    const sample = trials.filter((trial) => trial.mode === mode.id && !trial.error);
    const loads = sample.map((trial) => trial.loadMs).filter((value): value is number => value !== null);
    const pays = sample.map((trial) => trial.payMs).filter((value): value is number => value !== null);
    const paused = sample.map((trial) => trial.paused);
    const stalls = sample.flatMap((trial) => trial.stallMs);
    const cardStalls = sample.flatMap((trial) => trial.cardStallMs);
    const node = sample.map((trial) => trial.nodeCpuMs);
    const chrome = sample.map((trial) => trial.chromeCpuMs);
    const loadMed = median(loads);
    return {
      mode: mode.id,
      runs: sample.length,
      errors: trials.filter((trial) => trial.mode === mode.id && trial.error).length,
      pageErrors: sample.reduce((sum, trial) => sum + trial.pageErrors.length, 0),
      pausedMedian: median(paused),
      pausedRange: range(paused),
      stallMedianMs: median(stalls),
      stallRangeMs: range(stalls),
      cardStallMedianMs: median(cardStalls),
      loadMedianMs: loadMed,
      loadRangeMs: range(loads),
      loadDeltaVsNoneMs:
        loadMed !== null && noneLoad !== null ? loadMed - noneLoad : null,
      payMedianMs: median(pays),
      payRangeMs: range(pays),
      nodeCpuMedianMs: median(node),
      nodeCpuRangeMs: range(node),
      chromeCpuMedianMs: median(chrome),
      chromeCpuRangeMs: range(chrome),
      matchMedianMs: median(sample.flatMap((trial) => trial.matchMs)),
      continueMedianMs: median(sample.flatMap((trial) => trial.continueMs)),
      originGotCard: sample.filter((trial) => trial.originGotCard).length,
      cardFulfilled: sample.reduce((sum, trial) => sum + trial.cardFulfilled, 0),
      cardPaused: sample.reduce((sum, trial) => sum + trial.cardPaused, 0),
      iframeTargetsMedian: median(sample.map((trial) => trial.iframeTargets)),
      failed: sample.reduce((sum, trial) => sum + trial.failed, 0),
    };
  });
  return { noneLoadMedianMs: noneLoad, rows };
}

async function profileMatchers(): Promise<Record<string, number>> {
  const bodies = [
    CARD,
    JSON.stringify({ step: 1, note: "shipping" }),
    "x".repeat(8000),
  ];
  const iterations = 4000;
  const looseStart = process.cpuUsage();
  for (let i = 0; i < iterations; i++) {
    for (const body of bodies) looseHit("https://cdn.shopify.com/a.js", body);
  }
  const loose = process.cpuUsage(looseStart);
  const strictStart = process.cpuUsage();
  for (let i = 0; i < iterations; i++) {
    for (const body of bodies) strictCardSession(body, HELD);
  }
  const strict = process.cpuUsage(strictStart);
  return {
    iterations,
    bodies: bodies.length,
    looseCpuMs: (loose.user + loose.system) / 1000,
    strictCpuMs: (strict.user + strict.system) / 1000,
  };
}

async function main(): Promise<void> {
  selfCheck();
  const smoke = process.argv.includes("smoke");
  const probe = process.argv.includes("probe");
  const modes = smoke
    ? MODES.filter((mode) =>
        ["none", "baseline", "funnel", "sessions"].includes(mode.id),
      )
    : probe
      ? MODES.filter((mode) =>
          ["none", "sessions", "sessions-nowait"].includes(mode.id),
        )
      : MODES.filter((mode) => mode.id !== "sessions-nowait");
  const rounds = smoke ? 1 : ROUNDS;
  console.log(
    JSON.stringify({
      load: readFileSync("/proc/loadavg", "utf8").trim(),
      cores: cpus().length,
      chrome: "Google Chrome",
      substitute: true,
    }),
  );
  const cert = readFileSync("/tmp/pause-funnel-certs/cert.pem");
  const key = readFileSync("/tmp/pause-funnel-certs/key.pem");
  const userDataDir = await mkdtemp(path.join(tmpdir(), "pause-funnel-"));
  const { server, port, hits } = await startSubstitute(cert, key);
  const origin = `https://127.0.0.1:${port}`;
  const { proc, url } = await launchChrome(userDataDir);
  const cdp = await Cdp.connect(url);
  const trials: Trial[] = [];
  const edgePauses: PauseRec[] = [];
  try {
    for (let round = 0; round < rounds; round++) {
      const ordered = [
        ...modes.slice(round % modes.length),
        ...modes.slice(0, round % modes.length),
      ];
      for (const mode of ordered) {
        const started = performance.now();
        const { trial } = await runTrial(
          cdp,
          mode,
          round,
          origin,
          hits,
          userDataDir,
          "/checkout",
        );
        trials.push(trial);
        console.log(
          `${mode.id}#${round} paused=${trial.paused} load=${trial.loadMs?.toFixed(0)} pay=${trial.payMs?.toFixed(0)} cardFulfilled=${trial.cardFulfilled} originCard=${trial.originGotCard} iframe=${trial.iframeTargets} err=${trial.error ?? ""} ${(performance.now() - started).toFixed(0)}ms`,
        );
      }
    }
    const edgeReports: unknown[] = [];
    const edgeModes = probe ? [] : ["baseline", "funnel"];
    for (const id of edgeModes) {
      const edgeMode = MODES.find((mode) => mode.id === id);
      if (!edgeMode) continue;
      const edge = await runTrial(
        cdp,
        edgeMode,
        -1,
        origin,
        hits,
        userDataDir,
        "/edge",
      );
      edgePauses.push(...edge.pauses);
      edgeReports.push({
        mode: id,
        error: edge.trial.error,
        paused: edge.trial.paused,
        iframeUrls: edge.iframeUrls,
        page: edge.pageResult,
        pauses: edge.pauses.map((pause) => ({
          path: new URL(pause.url).pathname,
          search: new URL(pause.url).search,
          method: pause.method,
          resourceType: pause.resourceType,
          targetType: pause.targetType,
          host: new URL(pause.url).host,
          action: pause.action,
          loose: pause.loose,
          strict: pause.strict,
          hasPostData: pause.hasPostData,
          postDataInline: pause.postDataInline,
          postBytes: pause.postBytes,
          fetchPostBytes: pause.fetchPostBytes,
          fetchPostError: pause.fetchPostError,
          networkPostBytes: pause.networkPostBytes,
          networkPostError: pause.networkPostError,
          stallMs: Number(pause.stallMs.toFixed(2)),
        })),
      });
      console.log(
        `edge ${id} paused=${edge.trial.paused} err=${edge.trial.error ?? ""}`,
      );
    }
    const summary = summarize(trials);
    const matcher = await profileMatchers();
    const report = {
      substitute: true,
      missing: [
        "no myshopify test store URL in the repo, env, or Basis Theory tenant",
        "GET https://api.sapiom.ai/v1/injection-profiles returned 404",
        "GET https://api.sapiom.ai/v1/card-placeholders returned 404",
      ],
      reached: {
        btTenantName: "Sapiom Test",
        btTenantType: "test",
        proxyDestination: "https://checkout.pci.shopifyinc.com/sessions",
        liveSessionsStatus: 404,
      },
      pinnedClientSha: "570729f4a6b387d22d81d4e9b1d72b7e2578109b",
      rounds,
      summary,
      matcher,
      trials,
      edge: edgeReports,
    };
    await mkdir("/opt/cursor/artifacts", { recursive: true });
    const artifact = probe
      ? "/opt/cursor/artifacts/pause-funnel-nowait.json"
      : ARTIFACT;
    await writeFile(artifact, JSON.stringify(report));
    console.log(JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(matcher));
  } finally {
    cdp.close();
    proc.kill("SIGKILL");
    await new Promise((resolve) => {
      if (proc.exitCode !== null) resolve(undefined);
      else proc.once("exit", () => resolve(undefined));
    });
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
