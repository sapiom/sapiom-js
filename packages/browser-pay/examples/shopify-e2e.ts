/**
 * Opt-in Shopify dev-store checkout. Not part of CI.
 *
 *   RELAY=bogus npx tsx examples/shopify-e2e.ts
 *   RELAY=bt BT_PRIVATE_KEY=… BT_TOKEN_ID=… npx tsx examples/shopify-e2e.ts
 *   RELAY=http SAPIOM_BASE_URL=… SAPIOM_API_KEY=… TRANSACTION_ID=… \
 *     INJECTION_REF=… PLACEHOLDER_NUMBER=… PLACEHOLDER_EXP_MONTH=… \
 *     PLACEHOLDER_EXP_YEAR=… PLACEHOLDER_CVC=… npx tsx examples/shopify-e2e.ts
 *   MODE=refuse RELAY=bogus npx tsx examples/shopify-e2e.ts
 *   BROWSER=sapiom SAPIOM_API_KEY=… RELAY=bogus npx tsx examples/shopify-e2e.ts
 *
 * One checkout per process. Pay is clicked once. A captcha is reported and not bypassed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type Sapiom } from "@sapiom/tools";
import { chromium, type Frame, type Page } from "playwright";
import {
  attachInterceptor,
  httpPaymentRelay,
  maskCardNumber,
  redact,
  stubPaymentRelay,
  type HeldPlaceholder,
  type InterceptorEvent,
  type PaymentRelay,
} from "../src/index.js";
import { bogusShopifyRelay } from "./relays/bogus.js";
import { btProxyRelayFromEnv } from "./relays/bt-proxy.js";

const CART_URL = "https://1a2uh3-r7.myshopify.com/cart/67652208394372:1";
const SHOP_ORIGIN = "https://1a2uh3-r7.myshopify.com";

class CheckoutStopped extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

async function main(): Promise<void> {
  const relayName = process.env.RELAY;
  if (relayName !== "bogus" && relayName !== "bt" && relayName !== "http") {
    throw new CheckoutStopped(
      "Set RELAY=bogus, RELAY=bt, or RELAY=http. See the comment at the top of examples/shopify-e2e.ts.",
      1,
    );
  }
  const mode = process.env.MODE === "refuse" ? "refuse" : "pay";
  const placeholder = loadPlaceholder(relayName);
  console.log(
    `checkout ${mode} via RELAY=${relayName} BROWSER=${process.env.BROWSER ?? "local"} placeholder ${maskCardNumber(placeholder.number)}`,
  );

  const events: InterceptorEvent[] = [];
  let relayCalls = 0;
  let sessionsUrl = false;
  let merchantOrigin = "";
  let relayNote = "";
  const selected =
    mode === "refuse" ? refusingRelay() : selectRelay(relayName, placeholder);
  const relay: PaymentRelay = {
    async relay(request) {
      relayCalls += 1;
      sessionsUrl = request.url.includes(
        "checkout.pci.shopifyinc.com/sessions",
      );
      merchantOrigin = request.merchantOrigin;
      const result = await selected.relay(request);
      relayNote = result.ok
        ? `status ${result.status} body ${redact(result.body).slice(0, 180)}`
        : `refused ${result.reason}`;
      return result;
    },
  };

  const browserSession = await openBrowser();
  const handle = await attachInterceptor(browserSession.cdpUrl, {
    relay,
    placeholder,
    transactionId:
      relayName === "http" ? required("TRANSACTION_ID") : "tx_local_demo",
    timeoutMs: 30_000,
  });
  handle.on((event) => events.push(event));
  const driver = await chromium.connectOverCDP(browserSession.cdpUrl);
  let page: Page | undefined;
  try {
    const context = driver.contexts()[0] ?? (await driver.newContext());
    page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width: 1280, height: 900 });
    await runCheckout(page, placeholder, mode);
    if (!sessionsUrl) {
      throw new CheckoutStopped(
        "interceptor did not relay a request to checkout.pci.shopifyinc.com/sessions",
        2,
      );
    }
    if (mode === "refuse") {
      if (!events.some((event) => event.type === "refused")) {
        throw new CheckoutStopped("refusal did not fail the paused request", 2);
      }
      if (events.some((event) => event.type === "relayed")) {
        throw new CheckoutStopped("refusal fulfilled the paused request", 2);
      }
    }
    if (merchantOrigin && merchantOrigin !== SHOP_ORIGIN) {
      throw new CheckoutStopped(`merchant origin was ${merchantOrigin}`, 2);
    }
    console.log(
      `relay calls ${relayCalls}; events ${events.map(summarize).join(", ") || "none"}; ${relayNote}`,
    );
  } catch (error) {
    if (page) console.error(await diagnostics(page));
    console.log(
      `relay calls ${relayCalls}; events ${events.map(summarize).join(", ") || "none"}; ${relayNote}`,
    );
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    throw error;
  } finally {
    await page?.close().catch(() => {});
    await handle.detach();
    await browserSession.close();
  }
}

function selectRelay(name: string, placeholder: HeldPlaceholder): PaymentRelay {
  if (name === "bogus") return bogusShopifyRelay({ placeholder });
  if (name === "bt") return btProxyRelayFromEnv(placeholder);
  return httpPaymentRelay({
    baseUrl: process.env.SAPIOM_BASE_URL ?? "https://api.sapiom.ai",
    apiKey: required("SAPIOM_API_KEY"),
  });
}

function refusingRelay(): PaymentRelay {
  return stubPaymentRelay(async () => ({ ok: false, reason: "cancelled" }));
}

function loadPlaceholder(relayName: string): HeldPlaceholder {
  if (relayName === "http") {
    return {
      number: required("PLACEHOLDER_NUMBER"),
      expMonth: Number(required("PLACEHOLDER_EXP_MONTH")),
      expYear: Number(required("PLACEHOLDER_EXP_YEAR")),
      cvc: required("PLACEHOLDER_CVC"),
      injectionRef: required("INJECTION_REF"),
    };
  }
  // A Luhn-valid stand-in. The bogus relay replaces it with card 1 before
  // the request is forwarded. It is not sent as itself.
  return {
    number: "4123456789012349",
    expMonth: 11,
    expYear: 2029,
    cvc: "321",
    injectionRef: "inj_local_demo",
  };
}

async function runCheckout(
  page: Page,
  placeholder: HeldPlaceholder,
  mode: "pay" | "refuse",
): Promise<void> {
  console.log("open cart");
  await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await assertNoChallenge(page, "after cart");
  if (page.url().includes("shop.app")) {
    const back = new URL(page.url()).searchParams.get("ur_back_url");
    if (!back) {
      throw new CheckoutStopped(
        "Shop Pay did not offer a standard checkout URL",
        2,
      );
    }
    console.log("leave Shop Pay for the card checkout");
    await page.goto(back, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await assertNoChallenge(page, "on checkout");
  console.log("fill shipping");
  await fillShipping(page);
  console.log("choose shipping");
  await chooseShipping(page);
  console.log("fill card fields");
  await fillCard(page, placeholder);
  await assertNoChallenge(page, "before pay");
  console.log("pay once");
  await clickPay(page);
  if (mode === "refuse") {
    await waitFor(async () => page.url(), 20_000);
    await page.waitForTimeout(3000);
    if (/thank[-_]you/i.test(page.url())) {
      throw new CheckoutStopped("refusal still reached the thank-you page", 2);
    }
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    if (/order\s+#\d+/i.test(text) && /thank you/i.test(text)) {
      throw new CheckoutStopped("refusal still created an order", 2);
    }
    console.log(`refusal held; page ${redactUrl(page.url())}`);
    return;
  }
  await waitForConfirmation(page);
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const order =
    text.match(/order\s+#\s*(\d+)/i) ?? text.match(/confirmation\s+#\s*(\d+)/i);
  console.log(`confirmed ${redactUrl(page.url())}`);
  console.log(order ? `order ${order[1]}` : "order id not shown on the page");
}

async function fillShipping(page: Page): Promise<void> {
  await fill(
    page,
    /email/i,
    "buyer@example.com",
    'input[type="email"], input[name="email"]',
  );
  const country = page
    .locator('select[name="countryCode"], select[name="country"]')
    .first();
  if (await country.isVisible().catch(() => false)) {
    await country.selectOption({ label: "United States" }).catch(async () => {
      await country.selectOption("US");
    });
  }
  await fill(page, /first name/i, "Test", 'input[name="firstName"]');
  await fill(page, /last name/i, "Buyer", 'input[name="lastName"]');
  await fill(page, /^address$/i, "1 Test Street", 'input[name="address1"]');
  await dismissAddressSuggestions(page);
  await fill(page, /^city$/i, "New York", 'input[name="city"]');
  await fill(
    page,
    /zip code|postal code/i,
    "10001",
    'input[name="postalCode"]',
  );
  const phone = page.getByLabel(/phone/i).first();
  if (await phone.isVisible().catch(() => false))
    await phone.fill("2015550123");
  await selectState(page);
  await dismissAddressSuggestions(page);
}

async function dismissAddressSuggestions(page: Page): Promise<void> {
  const decline = page.getByRole("button", { name: /not now/i }).first();
  if (await decline.isVisible().catch(() => false)) {
    await decline.click();
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
}

async function fill(
  page: Page,
  label: RegExp,
  value: string,
  fallback: string,
): Promise<void> {
  const byLabel = page.getByLabel(label).first();
  if (await byLabel.isVisible().catch(() => false)) {
    await byLabel.fill(value);
    return;
  }
  const field = page.locator(fallback).first();
  await field.waitFor({ state: "visible", timeout: 20_000 });
  await field.fill(value);
}

async function selectState(page: Page): Promise<void> {
  const select = page
    .locator('select[name="zone"], select[name="province"]')
    .first();
  if (await select.isVisible().catch(() => false)) {
    await select.selectOption({ label: "New York" }).catch(async () => {
      await select.selectOption("NY");
    });
    return;
  }
  const combo = page.getByLabel(/state|province|region/i).first();
  if (await combo.isVisible().catch(() => false)) {
    await combo.click();
    await combo.fill("New York");
    await page.keyboard.press("Enter");
  }
}

async function chooseShipping(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const radios = page.locator('input[type="radio"]');
    const count = await radios.count();
    for (let index = 0; index < count; index += 1) {
      const radio = radios.nth(index);
      const blob = `${(await radio.getAttribute("name")) ?? ""} ${(await radio.getAttribute("id")) ?? ""}`;
      if (!/shipping|delivery|rate/i.test(blob)) continue;
      if (!(await radio.isChecked().catch(() => false))) {
        await radio.check({ force: true }).catch(() => {});
      }
      return;
    }
    await page.waitForTimeout(400);
  }
  console.log("no shipping-rate radio appeared");
}

async function fillCard(
  page: Page,
  placeholder: HeldPlaceholder,
): Promise<void> {
  await page
    .waitForSelector(
      'iframe[src*="checkout.pci.shopifyinc.com"], iframe[name*="card-fields"], iframe[title*="Card number"]',
      { timeout: 30_000 },
    )
    .catch(() => {});
  const frames = page.frames().filter((frame) => {
    const blob = `${frame.name()} ${frame.url()}`;
    return /checkout\.pci\.shopifyinc\.com|card-fields/i.test(blob);
  });
  const roles = new Map<string, Frame>();
  for (const frame of frames) {
    const role = frameRole(`${frame.name()} ${frame.url()}`);
    if (role !== "unknown" && !roles.has(role)) roles.set(role, frame);
  }
  const number = roles.get("number");
  if (!number) {
    throw new CheckoutStopped(
      `card number iframe not found (${frames.map((frame) => pathOnly(frame.url())).join(", ") || "no pci frames"})`,
      2,
    );
  }
  await typeFrame(number, placeholder.number);
  const expiry = roles.get("expiry");
  if (expiry) {
    await typeFrame(
      expiry,
      `${String(placeholder.expMonth).padStart(2, "0")}${String(placeholder.expYear).slice(-2)}`,
    );
  } else {
    const month = roles.get("month");
    const year = roles.get("year");
    if (month)
      await typeFrame(month, String(placeholder.expMonth).padStart(2, "0"));
    if (year) await typeFrame(year, String(placeholder.expYear).slice(-2));
  }
  const cvc = roles.get("cvc");
  if (!cvc) throw new CheckoutStopped("card security code iframe not found", 2);
  await typeFrame(cvc, placeholder.cvc);
  const name = roles.get("name");
  if (name) await typeFrame(name, "Test Buyer");
}

function frameRole(blob: string): string {
  const value = blob.toLowerCase();
  if (/verification|security.?code|cvv|cvc/.test(value)) return "cvc";
  if (/expir/.test(value)) return "expiry";
  if (/month/.test(value) && !/year/.test(value)) return "month";
  if (/year/.test(value)) return "year";
  if (/number/.test(value)) return "number";
  if (/name/.test(value)) return "name";
  return "unknown";
}

async function typeFrame(frame: Frame, text: string): Promise<void> {
  // Shopify's card iframes put a honeypot input first. It is aria-hidden and
  // covered by the real field, so a click on it never lands.
  const inputs = frame.locator(
    'input:not([data-honeypot-field]):not([aria-hidden="true"]), textarea:not([data-honeypot-field])',
  );
  await inputs.first().waitFor({ state: "attached", timeout: 15_000 });
  const count = await inputs.count();
  let target = inputs.first();
  for (let index = 0; index < count; index += 1) {
    const candidate = inputs.nth(index);
    const tab = await candidate.getAttribute("tabindex");
    if (tab === "-1") continue;
    target = candidate;
    break;
  }
  await target.click({ force: true });
  await target.fill("");
  await target.pressSequentially(text, { delay: 20 });
}

async function clickPay(page: Page): Promise<void> {
  const named = page.locator("#checkout-pay-button").first();
  if (await named.isVisible().catch(() => false)) {
    await named.click();
    return;
  }
  await page
    .getByRole("button", { name: /pay now/i })
    .first()
    .click();
}

async function waitForConfirmation(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await assertNoChallenge(page, "waiting for confirmation");
    if (/thank[-_]you/i.test(page.url())) return;
    const heading = page.getByRole("heading", { name: /thank you/i }).first();
    if (await heading.isVisible().catch(() => false)) return;
    const paymentError = await paymentAlert(page);
    if (paymentError) throw new CheckoutStopped(redact(paymentError), 2);
    await page.waitForTimeout(500);
  }
  throw new CheckoutStopped(
    `checkout did not confirm (${redactUrl(page.url())})`,
    2,
  );
}

async function paymentAlert(page: Page): Promise<string | null> {
  const alerts = await page
    .locator('[role="alert"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  for (const alert of alerts) {
    const text = alert.replace(/\s+/g, " ").trim();
    if (!text || /being processed/i.test(text)) continue;
    if (/card|payment|gateway|declined/i.test(text)) return text;
  }
  return null;
}

async function assertNoChallenge(page: Page, where: string): Promise<void> {
  const challenge = await detectChallenge(page);
  if (challenge) {
    throw new CheckoutStopped(
      `Shopify showed a captcha or bot challenge (${challenge}) ${where}. Not bypassing it.`,
      3,
    );
  }
}

async function detectChallenge(page: Page): Promise<string | null> {
  const url = page.url();
  if (/hcaptcha|recaptcha|\/checkpoint|\/challenge/i.test(url)) return "url";
  for (const frame of page.frames()) {
    if (
      /hcaptcha\.com|google\.com\/recaptcha|challenges\.cloudflare/i.test(
        frame.url(),
      )
    ) {
      return "frame";
    }
  }
  const text = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  if (/verify you are human|are you a human|checking your browser/i.test(text))
    return "text";
  if (/enter store password|opening soon/i.test(text)) return "store-password";
  return null;
}

async function diagnostics(page: Page): Promise<string> {
  const frames = page.frames().map((frame) => pathOnly(frame.url()));
  const buttons = await page
    .locator("button")
    .allInnerTexts()
    .catch(() => [] as string[]);
  const fields = await page
    .locator("input, select, textarea")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const field = node as {
          name?: string;
          id?: string;
          value?: string;
          getAttribute?: (name: string) => string | null;
        };
        const name =
          field.name ||
          field.id ||
          field.getAttribute?.("aria-label") ||
          "field";
        if (/number|verif|cvv|cvc|expir|security|code/i.test(name)) {
          return `${name}=filled`;
        }
        return `${name}=${String(field.value ?? "").slice(0, 40)}`;
      }),
    )
    .catch(() => [] as string[]);
  const alerts = await page
    .locator('[role="alert"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const radios = await page
    .locator('input[type="radio"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const input = node as { name?: string; id?: string; checked?: boolean };
        return `${input.name || input.id || "radio"}${input.checked ? " checked" : ""}`;
      }),
    )
    .catch(() => [] as string[]);
  const text = redact(
    await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => ""),
  )
    .replace(/\s+/g, " ")
    .slice(0, 700);
  const challenge = await detectChallenge(page);
  return [
    `url ${redactUrl(page.url())}`,
    `frames ${frames.join(", ")}`,
    `buttons ${buttons
      .map((label) => label.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12)
      .join(" | ")}`,
    `radios ${radios.join(", ") || "none"}`,
    `fields ${fields.join(" | ")}`,
    `alerts ${alerts.map((label) => redact(label).replace(/\s+/g, " ").trim()).join(" | ") || "none"}`,
    `text ${text}`,
    `challenge ${challenge ?? "no"}`,
  ].join("\n");
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "frame";
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "unparsed-url";
  }
}

function summarize(event: InterceptorEvent): string {
  if (event.type === "relayed") return `relayed ${event.status}`;
  if (event.type === "refused") return `refused ${event.reason}`;
  if (event.type === "failed") return `failed ${event.reason}`;
  return "paused";
}

async function waitFor(
  read: () => Promise<string>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await read();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function openBrowser(): Promise<{
  cdpUrl: string;
  close: () => Promise<void>;
}> {
  if ((process.env.BROWSER ?? "local") === "sapiom") {
    const apiKey = process.env.SAPIOM_API_KEY;
    if (!apiKey)
      throw new CheckoutStopped("BROWSER=sapiom requires SAPIOM_API_KEY", 1);
    const sapiom: Sapiom = createClient({ apiKey });
    const session = await sapiom.browserAutomation.sessions.createManaged({
      idempotencyKey: randomUUID(),
      recording: false,
      captchaSolver: true,
    });
    return {
      cdpUrl: session.cdpUrl,
      close: async () => {
        await sapiom.browserAutomation.sessions
          .closeManaged(session.sessionId)
          .catch(() => {});
        await sapiom.shutdown().catch(() => {});
      },
    };
  }
  const executable = [
    process.env.CHROME_PATH,
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
  ].find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new CheckoutStopped("local Chrome was not found", 1);
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "browser-pay-shopify-"),
  );
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const value = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(value));
    });
    server.on("error", reject);
  });
  const chrome: ChildProcess = spawn(
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
  const cdpUrl = await waitForCdp(port, chrome);
  return {
    cdpUrl,
    close: async () => {
      chrome.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
      }).catch(() => {});
    },
  };
}

async function waitForCdp(port: number, proc: ChildProcess): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new CheckoutStopped("Chrome exited before CDP was ready", 1);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const body = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new CheckoutStopped("CDP endpoint did not come up", 1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new CheckoutStopped(`${name} is required`, 1);
  return value;
}

main().catch((error: unknown) => {
  if (error instanceof CheckoutStopped) {
    console.error(error.message);
    process.exit(error.code);
  }
  console.error(error instanceof Error ? error.message : "checkout failed");
  process.exit(2);
});
