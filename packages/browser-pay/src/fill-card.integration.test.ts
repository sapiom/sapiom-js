import http from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright";
import { fillCard, type CardToFill, type PageLike } from "./fill-card";

const CARD: CardToFill = {
  number: "4000000000000002",
  expMonth: 3,
  expYear: 2029,
  cvc: "321",
  name: "Test Buyer",
};

/** Formats digits as the page types them, like Shopify's and Stripe's masks. */
const MASKS = `<script>
function maskCard(el){el.addEventListener('input',()=>{const d=el.value.replace(/\\D/g,'').slice(0,19);el.value=d.replace(/(.{4})/g,'$1 ').trim();});}
function maskExpiry(el){el.addEventListener('input',()=>{const d=el.value.replace(/\\D/g,'').slice(0,4);el.value=d.length>2?d.slice(0,2)+' / '+d.slice(2):d;});}
</script>`;

function field(attrs: string, title: string, mask = ""): string {
  return `<!doctype html><title>${title}</title>${MASKS}<input ${attrs} style="width:200px;height:30px">
<script>${mask}</script>`;
}

/** Card-iframe documents, served from the second origin. */
const FRAMES: Record<string, string> = {
  "/shopify/number": field(
    'id="number" name="number" autocomplete="cc-number" placeholder="Card number"',
    "Field container for: Card number",
    "maskCard(document.querySelector('input'))",
  ),
  "/shopify/expiry": field(
    'id="expiry" name="expiry" autocomplete="cc-exp" placeholder="Expiration date (MM / YY)"',
    "Field container for: Expiration date (MM / YY)",
    "maskExpiry(document.querySelector('input'))",
  ),
  "/shopify/cvc": field(
    'id="verification_value" name="verification_value" autocomplete="cc-csc" placeholder="Security code"',
    "Field container for: Security code",
  ),
  "/shopify/name": field(
    'id="name" name="name" autocomplete="cc-name" placeholder="Name on card"',
    "Field container for: Name on card",
  ),
  "/stripe/card": `<!doctype html><title>Secure card payment input frame</title>${MASKS}
<input name="cardnumber" autocomplete="cc-number" placeholder="Card number" style="width:200px;height:30px">
<input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY" style="width:80px;height:30px">
<input name="cvc" autocomplete="cc-csc" placeholder="CVC" style="width:60px;height:30px">
<input name="postal" autocomplete="postal-code" placeholder="ZIP" style="width:60px;height:30px">
<script>maskCard(document.querySelector('[name=cardnumber]'));maskExpiry(document.querySelector('[name=exp-date]'));</script>`,
  "/braintree/number": field(
    'id="credit-card-number" name="credit-card-number"',
    "Secure Credit Card Frame - Credit Card Number",
  ),
  "/braintree/month": field(
    'id="expiration-month" name="expiration-month" maxlength="2"',
    "Secure Credit Card Frame - Expiration Month",
  ),
  "/braintree/year": field(
    'id="expiration-year" name="expiration-year" maxlength="4"',
    "Secure Credit Card Frame - Expiration Year",
  ),
  "/braintree/cvv": field(
    'id="cvv" name="cvv"',
    "Secure Credit Card Frame - CVV",
  ),
  "/adyen/number": field(
    'data-fieldtype="encryptedCardNumber"',
    "Iframe for card number",
  ),
  "/adyen/expiry": field(
    'data-fieldtype="encryptedExpiryDate" placeholder="MM/YY"',
    "Iframe for expiry date",
    "maskExpiry(document.querySelector('input'))",
  ),
  "/adyen/cvc": field(
    'data-fieldtype="encryptedSecurityCode"',
    "Iframe for security code",
  ),
};

/** Top-level checkout pages; FRAME_ORIGIN is replaced with the card-iframe origin. */
const DECOYS = `<label>Email <input name="email" autocomplete="email" style="width:200px;height:30px"></label>
<label>Phone number <input name="phone" autocomplete="tel" style="width:200px;height:30px"></label>
<label>Apartment, suite <input name="address2" style="width:200px;height:30px"></label>
<input type="hidden" name="checkout[number]" value="x">`;

const frame = (path: string) =>
  `<iframe src="FRAME_ORIGIN${path}" style="width:320px;height:60px"></iframe>`;

const PAGES: Record<string, string> = {
  "/shopify": `<!doctype html><title>Checkout - Example Store</title>${DECOYS}
${frame("/shopify/number")}${frame("/shopify/expiry")}${frame("/shopify/cvc")}${frame("/shopify/name")}`,
  "/stripe": `<!doctype html><title>Checkout</title>${DECOYS}<iframe src="FRAME_ORIGIN/stripe/card" style="width:600px;height:80px"></iframe>`,
  "/braintree": `<!doctype html><title>Checkout</title>${DECOYS}
${frame("/braintree/number")}${frame("/braintree/month")}${frame("/braintree/year")}${frame("/braintree/cvv")}`,
  "/adyen": `<!doctype html><title>Checkout</title>${DECOYS}${frame("/adyen/number")}${frame("/adyen/expiry")}${frame("/adyen/cvc")}`,
  "/plain": `<!doctype html><title>Checkout</title>${DECOYS}
<label>Card number <input id="ccnum" style="width:200px;height:30px"></label>
<label>Month <select id="m" autocomplete="cc-exp-month"><option value="">MM</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${String(i + 1).padStart(2, "0")}</option>`).join("")}</select></label>
<label>Year <select id="y" autocomplete="cc-exp-year"><option value="">YYYY</option>${[2027, 2028, 2029, 2030].map((y) => `<option value="${y}">${y}</option>`).join("")}</select></label>
<label>CVV <input id="cvv" style="width:60px;height:30px"></label>`,
  "/delayed": `<!doctype html><title>Checkout</title>${DECOYS}
<script>setTimeout(() => {
  for (const p of ["/shopify/number", "/shopify/expiry", "/shopify/cvc"]) {
    const f = document.createElement("iframe");
    f.src = "FRAME_ORIGIN" + p;
    f.style.cssText = "width:320px;height:60px";
    document.body.appendChild(f);
  }
}, 1500)</script>`,
  "/none": `<!doctype html><title>Checkout</title>${DECOYS}`,
  "/untrusted": `<!doctype html><title>Checkout</title>${DECOYS}
<iframe src="OTHER_ORIGIN/evil" style="width:600px;height:80px"></iframe>
${frame("/shopify/number")}${frame("/shopify/expiry")}${frame("/shopify/cvc")}`,
  "/titled": `<!doctype html><title>Card Number</title>
<label>Email <input name="email" autocomplete="email" style="width:200px;height:30px"></label>
<label>Card <input name="cardnumber" style="width:200px;height:30px"></label>
<label>Expiry <input name="exp-date" placeholder="MM / YY" style="width:80px;height:30px"></label>
<label>CVC <input name="cvc" style="width:60px;height:30px"></label>`,
  "/select-reset": `<!doctype html><title>Checkout</title>
<label>Card number <input id="ccnum" style="width:200px;height:30px"></label>
<select id="m" autocomplete="cc-exp-month"><option value="">MM</option><option value="03">03</option></select>
<select id="y" autocomplete="cc-exp-year"><option value="">YYYY</option><option value="2029">2029</option></select>
<label>CVV <input id="cvv" style="width:60px;height:30px"></label>
<script>document.getElementById("m").addEventListener("change", (e) => { e.target.value = ""; });</script>`,
  "/stray-month": `<!doctype html><title>Checkout</title>${MASKS}
<input autocomplete="cc-number" style="width:200px;height:30px">
<input id="exp" autocomplete="cc-exp" placeholder="MM / YY" style="width:80px;height:30px">
<input id="month" autocomplete="cc-exp-month" style="width:40px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">
<script>maskExpiry(document.getElementById("exp"));</script>`,
  "/padded": `<!doctype html><title>Checkout</title>${MASKS}
<input autocomplete="cc-number" style="width:200px;height:30px">
<input id="exp" autocomplete="cc-exp" maxlength="9" placeholder="Expiration" style="width:80px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">
<script>maskExpiry(document.getElementById("exp"));</script>`,
  "/four-digit": `<!doctype html><title>Checkout</title>
<input autocomplete="cc-number" style="width:200px;height:30px">
<input id="exp" autocomplete="cc-exp" maxlength="9" placeholder="Expiration" style="width:90px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">
<script>
const exp = document.getElementById("exp");
exp.addEventListener("input", () => { const d = exp.value.replace(/\\D/g, "").slice(0, 6); exp.value = d.length > 2 ? d.slice(0, 2) + " / " + d.slice(2) : d; });
exp.addEventListener("blur", () => { const y = exp.value.split("/")[1] || ""; exp.setAttribute("aria-invalid", String(y.trim().length !== 4)); });
</script>`,
  "/pattern-four": `<!doctype html><title>Checkout</title>
<input autocomplete="cc-number" style="width:200px;height:30px">
<input id="exp" autocomplete="cc-exp" pattern="\\d{2}/\\d{4}" style="width:90px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">`,
  "/srcdoc": `<!doctype html><title>Checkout</title>
<iframe style="width:600px;height:80px" srcdoc='<input autocomplete="cc-number" style="width:200px;height:30px"><input autocomplete="cc-exp" placeholder="MM / YY" style="width:80px;height:30px"><input autocomplete="cc-csc" style="width:60px;height:30px">'></iframe>`,
  "/mmyy-pattern": `<!doctype html><title>Checkout</title>
<input autocomplete="cc-number" style="width:200px;height:30px">
<input id="exp" autocomplete="cc-exp" pattern="\\d{4}" style="width:90px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">
<script>
const e = document.getElementById("exp");
e.addEventListener("input", () => { e.value = e.value.replace(/\\D/g, "").slice(0, 4); });
</script>`,
  "/yy-placeholder-four-pattern": `<!doctype html><title>Checkout</title>
<input autocomplete="cc-number" style="width:200px;height:30px">
<input id="exp" autocomplete="cc-exp" placeholder="MM/YY" pattern="\\d{2}/\\d{4}" style="width:90px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">`,
  "/sandboxed": `<!doctype html><title>Checkout</title>
<iframe sandbox="allow-scripts" style="width:600px;height:80px" srcdoc='<input autocomplete="cc-number" style="width:200px;height:30px"><input autocomplete="cc-exp" style="width:80px;height:30px"><input autocomplete="cc-csc" style="width:60px;height:30px">'></iframe>`,
};

function findChromium(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("playwright").chromium.executablePath() as string;
    return Boolean(path && existsSync(path));
  } catch {
    return false;
  }
}

function serve(
  handler: (path: string) => string | undefined,
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = handler(req.url ?? "/");
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? "not found");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(findChromium() ? describe : describe.skip)(
  "fillCard (Chromium, cross-origin card iframes)",
  () => {
    let browser: Browser;
    let top: http.Server;
    let frames: http.Server;
    let other: http.Server;
    let topUrl: string;
    let frameOrigin: string;
    let otherOrigin: string;

    // The fixture card iframes are on plain-http localhost, not a built-in card-vault host.
    const fill = (page: Page, opts: { timeoutMs?: number } = {}) =>
      fillCard(page as unknown as PageLike, CARD, {
        keyDelayMs: 5,
        frameOrigins: [frameOrigin],
        ...opts,
      });

    beforeAll(async () => {
      frames = await serve((p) => FRAMES[p]);
      // Same host, different hostname spelling: localhost vs 127.0.0.1 are different origins.
      frameOrigin = `http://localhost:${(frames.address() as AddressInfo).port}`;
      // An unrelated embedded iframe that advertises card fields.
      other = await serve((p) =>
        p === "/evil"
          ? `<!doctype html><title>Card</title>
<input autocomplete="cc-number" style="width:200px;height:30px">
<input autocomplete="cc-exp" style="width:80px;height:30px">
<input autocomplete="cc-csc" style="width:60px;height:30px">`
          : undefined,
      );
      otherOrigin = `http://localhost:${(other.address() as AddressInfo).port}`;
      top = await serve((p) =>
        PAGES[p]
          ?.replace(/FRAME_ORIGIN/g, frameOrigin)
          .replace(/OTHER_ORIGIN/g, otherOrigin),
      );
      topUrl = `http://127.0.0.1:${(top.address() as AddressInfo).port}`;
      const { chromium } = await import("playwright");
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      top?.close();
      frames?.close();
      other?.close();
    });

    async function open(path: string): Promise<Page> {
      const page = await browser.newPage();
      await page.goto(`${topUrl}${path}`, { waitUntil: "load" });
      return page;
    }

    const valueIn = async (page: Page, urlPart: string, selector = "input") => {
      const f = page.frames().find((fr) => fr.url().includes(urlPart));
      return f!.locator(selector).first().inputValue();
    };

    it("fills Shopify's one-iframe-per-field card form, masks included, and skips decoys", async () => {
      const page = await open("/shopify");
      const result = await fill(page);
      expect(result).toMatchObject({
        ok: true,
        missing: [],
        unconfirmed: [],
        untrusted: [],
      });
      expect(result.filled).toEqual(["number", "expiry", "cvc", "name"]);
      expect(await valueIn(page, "/shopify/number")).toBe(
        "4000 0000 0000 0002",
      );
      expect(await valueIn(page, "/shopify/expiry")).toBe("03 / 29");
      expect(await valueIn(page, "/shopify/cvc")).toBe("321");
      expect(await page.locator('[name="phone"]').inputValue()).toBe("");
      expect(await page.locator('[name="email"]').inputValue()).toBe("");
      expect(result.origins.number).toBe(frameOrigin);
      await page.close();
    });

    it("fills Stripe Elements' single iframe and leaves the postal code alone", async () => {
      const page = await open("/stripe");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(result.filled).toEqual(["number", "expiry", "cvc"]);
      expect(await valueIn(page, "/stripe/card", "[name=exp-date]")).toBe(
        "03 / 29",
      );
      expect(await valueIn(page, "/stripe/card", "[name=postal]")).toBe("");
      await page.close();
    });

    it("fills Braintree hosted fields with split month and year", async () => {
      const page = await open("/braintree");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(result.filled).toEqual(["number", "expMonth", "expYear", "cvc"]);
      expect(await valueIn(page, "/braintree/month")).toBe("03");
      expect(await valueIn(page, "/braintree/year")).toBe("2029");
      await page.close();
    });

    it("fills Adyen secured fields by their data-fieldtype", async () => {
      const page = await open("/adyen");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(result.filled).toEqual(["number", "expiry", "cvc"]);
      await page.close();
    });

    it("fills plain inputs and expiry selects on the page itself", async () => {
      const page = await open("/plain");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(result.filled).toEqual(["number", "expMonth", "expYear", "cvc"]);
      expect(await page.locator("#m").inputValue()).toBe("03");
      expect(await page.locator("#y").inputValue()).toBe("2029");
      await page.close();
    });

    it("waits for card iframes that load after the page", async () => {
      const page = await open("/delayed");
      const result = await fill(page);
      expect(result).toMatchObject({ ok: true, missing: [] });
      await page.close();
    }, 20_000);

    it("never types into an iframe on an origin it was not given, and names it", async () => {
      const page = await open("/untrusted");
      const result = await fill(page);
      expect(result).toMatchObject({ ok: true, untrusted: [otherOrigin] });
      expect(Object.values(result.origins)).toEqual([
        frameOrigin,
        frameOrigin,
        frameOrigin,
      ]);
      const evil = page.frames().find((f) => f.url().startsWith(otherOrigin))!;
      for (const ac of ["cc-number", "cc-exp", "cc-csc"])
        expect(await evil.locator(`[autocomplete=${ac}]`).inputValue()).toBe(
          "",
        );
      await page.close();
    });

    it("does not read the page title as a field's label", async () => {
      const page = await open("/titled");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(await page.locator('[name="email"]').inputValue()).toBe("");
      expect(await page.locator('[name="cardnumber"]').inputValue()).toBe(
        CARD.number,
      );
      await page.close();
    });

    it("reports a select its change handler reset as unconfirmed", async () => {
      const page = await open("/select-reset");
      const result = await fill(page);
      expect(result).toMatchObject({ ok: false, missing: ["expiry"] });
      expect(result.unconfirmed).toContain("expMonth");
      await page.close();
    });

    it("uses the combined expiry when only one split field exists", async () => {
      const page = await open("/stray-month");
      const result = await fill(page);
      expect(result).toMatchObject({
        ok: true,
        filled: ["number", "expiry", "cvc"],
      });
      expect(await page.locator("#exp").inputValue()).toBe("03 / 29");
      expect(await page.locator("#month").inputValue()).toBe("");
      await page.close();
    });

    it("types a two-digit year into a padded MM / YY mask with a long maxlength", async () => {
      const page = await open("/padded");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(await page.locator("#exp").inputValue()).toBe("03 / 29");
      await page.close();
    });

    it("retries a four-digit year when the field marks two digits invalid", async () => {
      const page = await open("/four-digit");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(await page.locator("#exp").inputValue()).toBe("03 / 2029");
      await page.close();
    });

    it("types a four-digit year when the field's pattern requires one", async () => {
      const page = await open("/pattern-four");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(await page.locator("#exp").inputValue()).toBe("03/2029");
      await page.close();
    });

    it("types MMYY into a field whose pattern is four digits in total", async () => {
      const page = await open("/mmyy-pattern");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(await page.locator("#exp").inputValue()).toBe("0329");
      await page.close();
    });

    it("falls back to a four-digit year behind a YY placeholder when the pattern needs it", async () => {
      const page = await open("/yy-placeholder-four-pattern");
      const result = await fill(page);
      expect(result.ok).toBe(true);
      expect(await page.locator("#exp").inputValue()).toBe("03/2029");
      await page.close();
    });

    it("fills a same-origin srcdoc card frame as the page's own origin", async () => {
      const page = await open("/srcdoc");
      const result = await fill(page);
      expect(result).toMatchObject({ ok: true, untrusted: [] });
      expect(result.origins.number).toBe(topUrl);
      await page.close();
    });

    it("never types into a sandboxed srcdoc frame, whose origin is opaque", async () => {
      const page = await open("/sandboxed");
      const result = await fill(page, { timeoutMs: 1000 });
      expect(result).toMatchObject({
        ok: false,
        filled: [],
        untrusted: ["null"],
      });
      await page.close();
    });

    it("reports what is missing, without values, when there is no card form", async () => {
      const page = await open("/none");
      const result = await fill(page, { timeoutMs: 1000 });
      expect(result).toEqual({
        ok: false,
        filled: [],
        missing: ["number", "expiry", "cvc"],
        unconfirmed: [],
        origins: {},
        untrusted: [],
      });
      expect(JSON.stringify(result)).not.toContain(CARD.number);
      await page.close();
    });
  },
);
