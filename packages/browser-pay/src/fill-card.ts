/**
 * Types the governance placeholder into a checkout's card form without an LLM.
 *
 * Card forms put each field in a different place: a plain input, one cross-origin iframe per
 * field (Shopify's card vault, Braintree hosted fields, Adyen secured fields), or one iframe for
 * all of them (Stripe Elements). `fillCard` looks at every frame of a Playwright page, classifies
 * the visible inputs and selects by their `autocomplete`, name, id, placeholder, label and
 * provider attributes, types the card the way a person would, and reads each field back.
 *
 * It never logs, returns or throws a card value. The result names only field kinds and frame
 * origins. It does not press Pay: submitting stays with the caller, so the caller always knows
 * whether it sent the card.
 */

/** The card to type: the placeholder's fields, plus an optional cardholder name. */
export interface CardToFill {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  /** Typed only when the form has a cardholder-name field. */
  name?: string;
}

/** A card form field `fillCard` recognises. */
export type CardField =
  | "number"
  | "expiry"
  | "expMonth"
  | "expYear"
  | "cvc"
  | "name";

export interface FillCardResult {
  /**
   * The number, the security code and the expiry (one combined field, or month and year) were
   * each typed and read back. Pressing Pay is still the caller's step.
   */
  ok: boolean;
  /** Fields typed and read back, in the order they were filled. */
  filled: CardField[];
  /**
   * Fields the card needs that were not found or did not read back: `number`, `cvc`, and
   * `expiry` (standing for the combined field or either of month and year).
   */
  missing: Array<"number" | "expiry" | "cvc">;
  /** Fields found but whose read-back did not match what was typed. */
  unconfirmed: CardField[];
  /** Origin of each frame a field was filled in, keyed by field. */
  origins: Partial<Record<CardField, string>>;
}

export interface FillCardOptions {
  /** Delay between keystrokes, in milliseconds. Defaults to 25. */
  keyDelayMs?: number;
  /** How long to wait for card fields to appear, in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
}

/** The parts of a Playwright `Locator` this helper uses. */
export interface LocatorLike {
  nth(index: number): LocatorLike;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(
    text: string,
    options?: { delay?: number; timeout?: number },
  ): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  selectOption(
    values: Array<{ value?: string; label?: string }>,
    options?: { timeout?: number },
  ): Promise<string[]>;
}

/** The parts of a Playwright `Frame` this helper uses. */
export interface FrameLike {
  url(): string;
  locator(selector: string): LocatorLike;
  evaluate<R>(expression: string): Promise<R>;
}

/** The parts of a Playwright `Page` this helper uses. */
export interface PageLike {
  frames(): FrameLike[];
  waitForTimeout(ms: number): Promise<void>;
}

/** What the page reports about one input or select. Values are never read here. */
interface Candidate {
  index: number;
  tag: "input" | "select";
  type: string;
  autocomplete: string;
  hints: string;
  /** A person could click it: its centre is in the frame's viewport and nothing covers it. */
  hit: boolean;
  maxLength: number;
  placeholder: string;
}

interface Match {
  frame: FrameLike;
  origin: string;
  candidate: Candidate;
  field: CardField;
  score: number;
}

const SELECTOR = "input, select";

/**
 * Runs in the page (a string, since this package has no DOM types): the visible, editable inputs
 * and selects with the attributes that name them. It never reads a field's value.
 */
const DESCRIBE_FIELDS = `(() => {
  const skip = new Set(["hidden","checkbox","radio","submit","button","image","file","reset"]);
  const out = [];
  Array.from(document.querySelectorAll("input, select")).forEach((el, index) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text").toLowerCase() : "select";
    if (skip.has(type) || el.disabled || (tag === "input" && el.readOnly)) return;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return;
    // Card vaults put a copy of every card input in each field's iframe for autofill; only the
    // one a person can click is real. Hit-test its centre inside its own frame's viewport.
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
    const top = inView ? document.elementFromPoint(cx, cy) : null;
    const hit = !!top && (top === el || el.contains(top) || (top.tagName === "LABEL" && top.control === el));
    const labels = Array.from(el.labels || []).map((l) => l.textContent || "").join(" ");
    const named = (el.getAttribute("aria-labelledby") || "").split(/\\s+/)
      .map((id) => (id && document.getElementById(id) ? document.getElementById(id).textContent || "" : "")).join(" ");
    const hints = [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      el.getAttribute("data-fieldtype"), el.getAttribute("data-elements-stable-field-name"),
      el.getAttribute("data-braintree-name"), labels, named, document.title]
      .filter(Boolean).join(" | ").toLowerCase();
    out.push({ index, tag, type, autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase().trim(),
      hints, hit, maxLength: tag === "input" ? el.maxLength : -1, placeholder: (el.getAttribute("placeholder") || "").toLowerCase() });
  });
  return out;
})()`;

const AUTOCOMPLETE: Record<string, CardField> = {
  "cc-number": "number",
  "cc-exp": "expiry",
  "cc-exp-month": "expMonth",
  "cc-exp-year": "expYear",
  "cc-csc": "cvc",
  "cc-name": "name",
};

/** Field names that say "card" on their own, from the providers this was tested against. */
const PATTERNS: Array<[CardField, RegExp]> = [
  [
    "cvc",
    /\b(cvc|cvv2?|csc|cvn|cid)\b|security.?code|verification.?value|card.?code|encryptedsecuritycode/,
  ],
  [
    "expMonth",
    /exp\w*.?month|encryptedexpirymonth|\bcc.?month\b|expiration-month|card.?month/,
  ],
  [
    "expYear",
    /exp\w*.?year|encryptedexpiryyear|\bcc.?year\b|expiration-year|card.?year/,
  ],
  [
    "expiry",
    /\bexp(iry|iration)?\b|exp.?date|expiration|encryptedexpirydate|mm\s*\/\s*yy/,
  ],
  [
    "number",
    /card.?number|cardnumber|credit.?card.?number|\bcc.?num|encryptedcardnumber|\bpan\b/,
  ],
  ["name", /name.?on.?card|card.?holder|holder.?name|cardholder|\bcc.?name\b/],
];

/** A bare `number`/`name` field (Shopify's card vault, Stripe's Payment Element) counts only in a card frame. */
const BARE: Array<[CardField, RegExp]> = [
  ["number", /^number\b/],
  ["name", /^name\b/],
  ["expiry", /^expiry\b/],
];

function classify(
  c: Candidate,
  cardFrame: boolean,
): { field: CardField; score: number } | null {
  // Maestro's issue date and number look like an expiry and a card number; never type into them.
  if (/\bissue[_ ](date|number)\b/.test(c.hints)) return null;
  const ac = AUTOCOMPLETE[c.autocomplete.split(/\s+/).pop() ?? ""];
  if (ac) return { field: ac, score: 3 };
  for (const [field, re] of PATTERNS)
    if (re.test(c.hints)) return { field, score: 2 };
  if (cardFrame)
    for (const [field, re] of BARE)
      if (re.test(c.hints)) return { field, score: 1 };
  return null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function scan(page: PageLike): Promise<Match[]> {
  const top = originOf(page.frames()[0]?.url() ?? "");
  const matches: Match[] = [];
  for (const frame of page.frames()) {
    let candidates: Candidate[];
    try {
      candidates = await frame.evaluate<Candidate[]>(DESCRIBE_FIELDS);
    } catch {
      continue; // detached or navigating frame
    }
    // Off-screen or covered copies are autofill decoys whenever the frame shows a real field.
    if (candidates.some((c) => c.hit))
      candidates = candidates.filter((c) => c.hit);
    const origin = originOf(frame.url());
    // A frame on another origin holding few inputs is a card iframe; so is one with any field
    // that already names itself a card field.
    const strong = candidates.some((c) => classify(c, false));
    const cardFrame =
      strong ||
      (origin !== top && candidates.length > 0 && candidates.length <= 4);
    for (const candidate of candidates) {
      const hit = classify(candidate, cardFrame);
      if (hit)
        matches.push({
          frame,
          origin,
          candidate,
          field: hit.field,
          score: hit.score,
        });
    }
  }
  return matches;
}

/** The best match per field: highest score, then document order. */
function choose(matches: Match[]): Map<CardField, Match> {
  const best = new Map<CardField, Match>();
  for (const m of matches) {
    const cur = best.get(m.field);
    if (!cur || m.score > cur.score) best.set(m.field, m);
  }
  return best;
}

const digits = (s: string) => s.replace(/\D/g, "");
const two = (n: number) => String(n % 100).padStart(2, "0");

function expiryText(c: Candidate, card: CardToFill): string {
  const mm = two(card.expMonth);
  const long = /yyyy/.test(c.placeholder) || c.maxLength >= 9;
  return `${mm}/${long ? String(card.expYear) : two(card.expYear)}`;
}

async function typeInto(
  m: Match,
  text: string,
  expectDigits: boolean,
  delay: number,
): Promise<boolean> {
  const el = m.frame.locator(SELECTOR).nth(m.candidate.index);
  const read = async () => {
    const v = await el.inputValue({ timeout: 2000 });
    return expectDigits ? digits(v) : v.trim();
  };
  const want = expectDigits ? digits(text) : text.trim();
  await el.click({ timeout: 5000 });
  await el.fill("", { timeout: 5000 }).catch(() => undefined);
  await el.pressSequentially(text, { delay, timeout: 15000 });
  if ((await read().catch(() => "")) === want) return true;
  // Some masks drop keystrokes typed too fast; a direct fill is the fallback.
  await el.fill(text, { timeout: 5000 }).catch(() => undefined);
  return (await read().catch(() => "")) === want;
}

async function chooseOption(m: Match, options: string[]): Promise<boolean> {
  const el = m.frame.locator(SELECTOR).nth(m.candidate.index);
  for (const o of options) {
    for (const spec of [{ value: o }, { label: o }]) {
      try {
        const picked = await el.selectOption([spec], { timeout: 2000 });
        if (picked.length) return true;
      } catch {
        // try the next spelling
      }
    }
  }
  return false;
}

/**
 * Types `card` into the checkout's card form on `page` (a Playwright page connected over CDP).
 * Call it after `attachInterceptor`, with the placeholder the purchase returned, once the payment
 * form is on screen. It does not press Pay.
 */
export async function fillCard(
  page: PageLike,
  card: CardToFill,
  options: FillCardOptions = {},
): Promise<FillCardResult> {
  const delay = options.keyDelayMs ?? 25;
  const deadline = Date.now() + (options.timeoutMs ?? 15000);

  let best = choose(await scan(page));
  // Card iframes load after the page; wait until a number field shows up or time runs out.
  const complete = () =>
    best.has("number") &&
    best.has("cvc") &&
    (best.has("expiry") || (best.has("expMonth") && best.has("expYear")));
  while (!complete() && Date.now() < deadline) {
    await page.waitForTimeout(500);
    best = choose(await scan(page));
  }

  const filled: CardField[] = [];
  const unconfirmed: CardField[] = [];
  const origins: Partial<Record<CardField, string>> = {};
  const record = (field: CardField, ok: boolean) => {
    const m = best.get(field)!;
    origins[field] = m.origin;
    (ok ? filled : unconfirmed).push(field);
  };

  const order: CardField[] = [
    "number",
    "expiry",
    "expMonth",
    "expYear",
    "cvc",
    "name",
  ];
  for (const field of order) {
    const m = best.get(field);
    if (!m) continue;
    if (field === "name" && !card.name) continue;
    if (field === "expiry" && (best.has("expMonth") || best.has("expYear")))
      continue;
    let ok: boolean;
    if (field === "expMonth" && m.candidate.tag === "select") {
      ok = await chooseOption(m, [two(card.expMonth), String(card.expMonth)]);
    } else if (field === "expYear" && m.candidate.tag === "select") {
      ok = await chooseOption(m, [String(card.expYear), two(card.expYear)]);
    } else {
      const text =
        field === "number"
          ? card.number
          : field === "cvc"
            ? card.cvc
            : field === "name"
              ? card.name!
              : field === "expiry"
                ? expiryText(m.candidate, card)
                : field === "expMonth"
                  ? two(card.expMonth)
                  : m.candidate.maxLength === 2
                    ? two(card.expYear)
                    : String(card.expYear);
      ok = await typeInto(m, text, field !== "name", delay).catch(() => false);
    }
    record(field, ok);
  }

  const has = (f: CardField) => filled.includes(f);
  const missing: FillCardResult["missing"] = [];
  if (!has("number")) missing.push("number");
  if (!has("expiry") && !(has("expMonth") && has("expYear")))
    missing.push("expiry");
  if (!has("cvc")) missing.push("cvc");
  return { ok: missing.length === 0, filled, missing, unconfirmed, origins };
}
