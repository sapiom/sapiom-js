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
  /**
   * Origins of frames that hold card fields but were not typed into, because they are neither the
   * page's origin, a built-in card-vault origin, nor in `frameOrigins`.
   */
  untrusted: string[];
}

export interface FillCardOptions {
  /** Delay between keystrokes, in milliseconds. Defaults to 25. */
  keyDelayMs?: number;
  /** How long to wait for card fields to appear, in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /**
   * Extra frame origins allowed to receive the card, such as a payment provider not in the built-in
   * list. The page's own origin and the built-in card-vault origins are always allowed.
   */
  frameOrigins?: string[];
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
  boundingBox(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  evaluate<R>(fn: (el: FieldElement) => R): Promise<R>;
  selectOption(
    values: Array<{ value?: string; label?: string }>,
    options?: { timeout?: number },
  ): Promise<string[]>;
}

/** The parts of a form field read inside the page to check its validity. */
export interface FieldElement {
  validity?: { valid: boolean };
  getAttribute(name: string): string | null;
  blur?(): void;
  options?: ArrayLike<{ value: string; text: string }>;
}

/** The parts of a Playwright `Frame` this helper uses. */
export interface FrameLike {
  url(): string;
  parentFrame(): FrameLike | null;
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
  /** Not in view now, but scrolling vertically brings it into view uncovered. */
  reachable: boolean;
  maxLength: number;
  placeholder: string;
}

interface Match {
  frame: FrameLike;
  /** The frame's URL when it was scanned. */
  url: string;
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
  const startX = window.scrollX, startY = window.scrollY;
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
    // one a person can click is real. \`hit\`: its centre is in the frame's viewport now and nothing
    // covers it. \`reachable\`: not in view, but scrolling vertically (instantly, so the position is
    // final) brings it into view uncovered; a copy parked to the left or right is never scrolled to.
    // Every scroll container moved is put back before the next field is measured.
    const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
    const visible = ([x, y]) => x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    const hitAt = ([x, y]) => {
      if (!visible([x, y])) return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (top === el || el.contains(top) || (top.tagName === "LABEL" && top.control === el));
    };
    const [cx, cy] = centre(rect);
    const hit = hitAt([cx, cy]);
    let reachable = false;
    if (!hit && cx >= 0 && cx <= window.innerWidth) {
      const moved = [];
      for (let n = el.parentElement; n; n = n.parentElement) moved.push([n, n.scrollLeft, n.scrollTop]);
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      reachable = hitAt(centre(el.getBoundingClientRect()));
      for (const [n, l, tp] of moved) { n.scrollLeft = l; n.scrollTop = tp; }
      window.scrollTo({ left: startX, top: startY, behavior: "instant" });
    }
    const labels = Array.from(el.labels || []).map((l) => l.textContent || "").join(" ");
    const named = (el.getAttribute("aria-labelledby") || "").split(/\\s+/)
      .map((id) => (id && document.getElementById(id) ? document.getElementById(id).textContent || "" : "")).join(" ");
    const hints = [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      el.getAttribute("data-fieldtype"), el.getAttribute("data-elements-stable-field-name"),
      el.getAttribute("data-braintree-name"), labels, named]
      .filter(Boolean).join(" | ").toLowerCase();
    out.push({ index, tag, type, autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase().trim(),
      hints, hit, reachable, maxLength: tag === "input" ? el.maxLength : -1, placeholder: (el.getAttribute("placeholder") || "").toLowerCase() });
  });
  // Leave the frame where it was.
  window.scrollTo({ left: startX, top: startY, behavior: "instant" });
  // The browser lets a frame read its parent's document only when they share an origin, so this
  // cannot be spoofed by the frame's own script.
  let parentAccessible = false;
  try { parentAccessible = parent !== self && !!parent.document; } catch (e) { parentAccessible = false; }
  return { title: (document.title || "").toLowerCase(), fields: out, parentAccessible };
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

/** The card field a candidate is, and how sure: 3 by `autocomplete`, 2 by a card-specific name, 1 bare. */
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

/**
 * Hosts of card vaults and payment providers that serve card-field iframes. A frame on any other
 * origin than the page's own gets the card only when the caller lists it in `frameOrigins`, so an
 * unrelated embedded iframe advertising card fields is never typed into.
 */
const CARD_VAULT_HOSTS = [
  "shopifyinc.com",
  "shopifycs.com",
  "stripe.com",
  "braintreegateway.com",
  "braintree-api.com",
  "adyen.com",
  "adyenpayments.com",
  "paypal.com",
  "squareup.com",
  "squarecdn.com",
  "checkout.com",
  "recurly.com",
  "chargebee.com",
  "spreedly.com",
  "authorize.net",
];

/** Frame titles that mark a card iframe, where a bare `number`/`name`/`expiry` input is a card field. */
const CARD_TITLE = /card|credit|payment|security code|cvv|cvc|expir/;

/** Whether a frame on `origin` may receive the card. */
function trusted(origin: string, top: string, extra: Set<string>): boolean {
  if (origin === top || extra.has(origin)) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return (
      protocol === "https:" &&
      CARD_VAULT_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

/** The origin of a URL, or "" when it has none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Every allowed card-field match in every frame; origins of disallowed card frames go to `untrusted`. */
async function scan(
  page: PageLike,
  extra: Set<string>,
  untrusted: Set<string>,
): Promise<Match[]> {
  const top = originOf(page.frames()[0]?.url() ?? "");
  const matches: Match[] = [];
  const effective = new Map<FrameLike, string>();
  for (const frame of page.frames()) {
    let candidates: Candidate[];
    let title: string;
    let parentAccessible: boolean;
    try {
      const described = await frame.evaluate<{
        title: string;
        fields: Candidate[];
        parentAccessible: boolean;
      }>(DESCRIBE_FIELDS);
      candidates = described.fields;
      title = described.title;
      parentAccessible = described.parentAccessible;
    } catch {
      continue; // detached or navigating frame
    }
    // An `about:srcdoc` or `about:blank` frame has no origin in its URL. It shares its parent's
    // origin when the browser lets it read the parent's document; otherwise it is opaque.
    let origin = originOf(frame.url());
    if (origin === "" || origin === "null") {
      const parentFrame = frame.parentFrame();
      origin =
        parentAccessible && parentFrame
          ? (effective.get(parentFrame) ?? originOf(parentFrame.url()))
          : "null";
    }
    effective.set(frame, origin);
    // Off-screen or covered copies are autofill decoys whenever the frame shows a real field.
    if (candidates.some((c) => c.hit || c.reachable))
      candidates = candidates.filter((c) => c.hit || c.reachable);
    // A frame on another origin holding few inputs is a card iframe; so is one with any field
    // that already names itself a card field.
    // The title marks the frame, never a field: it is not one input's own label.
    const strong = candidates.some((c) => classify(c, false));
    const cardFrame =
      strong ||
      (origin !== top &&
        candidates.length > 0 &&
        (candidates.length <= 4 || CARD_TITLE.test(title)));
    const allowed = trusted(origin, top, extra);
    for (const candidate of candidates) {
      const hit = classify(candidate, cardFrame);
      if (hit && !allowed) untrusted.add(origin);
      else if (hit)
        matches.push({
          frame,
          url: frame.url(),
          origin,
          candidate,
          field: hit.field,
          score: hit.score,
        });
    }
  }
  return matches;
}

/**
 * Matches per field, best first. Within one frame, a field in view now beats one reached by scrolling.
 * Otherwise highest score; then, among duplicates of a field, one a person can
 * see on the page right now (uncovered in its frame and inside the main viewport, judged through
 * every iframe by Playwright's bounding box); then document order. Positions inside one frame's
 * viewport are never compared with another frame's.
 */
async function rank(
  page: PageLike,
  matches: Match[],
): Promise<Map<CardField, Match[]>> {
  const ranked = new Map<CardField, Match[]>();
  for (const m of matches)
    ranked.set(m.field, [...(ranked.get(m.field) ?? []), m]);
  const main = page.frames()[0];
  const viewport = await main
    ?.evaluate<{
      w: number;
      h: number;
    }>("({ w: window.innerWidth, h: window.innerHeight })")
    .catch(() => null);
  const onScreen = async (m: Match): Promise<boolean> => {
    if (!m.candidate.hit || !viewport) return false;
    const box = await fieldOf(m)
      .boundingBox()
      .catch(() => null);
    if (!box) return false;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return x >= 0 && y >= 0 && x <= viewport.w && y <= viewport.h;
  };
  for (const [field, list] of ranked) {
    if (list.length < 2) continue;
    const seen = new Map<Match, boolean>();
    for (const m of list) seen.set(m, await onScreen(m));
    list.sort((a, b) => {
      // Within one frame, a field in view now beats one reached only by scrolling (an autofill copy
      // further down a vault's document), whatever the frame's place on the page or the score.
      if (a.frame === b.frame && a.candidate.hit !== b.candidate.hit)
        return Number(b.candidate.hit) - Number(a.candidate.hit);
      return b.score - a.score || Number(seen.get(b)) - Number(seen.get(a));
    });
    ranked.set(field, list);
  }
  return ranked;
}

/** Only the digits of `s`. */
const digits = (s: string) => s.replace(/\D/g, "");
/** The last two digits of `n`, zero-padded. */
const two = (n: number) => String(n % 100).padStart(2, "0");

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * What to type into a combined expiry, in order: two-digit year first, unless the placeholder spells
 * YYYY, then the compact `MMYY`. Every spelling is tried, and one counts only if the field reads it
 * back and does not mark itself invalid; the field's own `pattern` takes part through constraint
 * validation. Hints only order the attempts: a `YY` placeholder can sit on an `MM/YYYY` pattern,
 * masks pad `MM / YY` with spaces, and `\\d{4}` can mean MMYY.
 */
function expiryTexts(c: Candidate, card: CardToFill): string[] {
  const mm = two(card.expMonth);
  const short = `${mm}/${two(card.expYear)}`;
  const long = `${mm}/${card.expYear}`;
  const ordered = /yyyy/.test(c.placeholder) ? [long, short] : [short, long];
  return [...ordered, `${mm}${two(card.expYear)}`];
}

/** Rejects a card that cannot be typed, before any field is touched. Messages carry no values. */
function assertCard(card: CardToFill): void {
  const n = digits(card.number ?? "");
  const cvc = digits(card.cvc ?? "");
  const ok =
    n.length >= 12 &&
    n.length <= 19 &&
    n === card.number.replace(/[\s-]/g, "") &&
    cvc.length >= 3 &&
    cvc.length <= 4 &&
    cvc === card.cvc &&
    Number.isInteger(card.expMonth) &&
    card.expMonth >= 1 &&
    card.expMonth <= 12 &&
    Number.isInteger(card.expYear) &&
    card.expYear >= 2000 &&
    card.expYear <= 2099;
  if (!ok)
    throw new TypeError(
      "fillCard: the card's number, security code or expiry is not usable",
    );
}

/** The field a match points at. */
const fieldOf = (m: Match) => m.frame.locator(SELECTOR).nth(m.candidate.index);

/** The field's current value, as digits or trimmed text. */
async function readBack(m: Match, expectDigits: boolean): Promise<string> {
  const v = await fieldOf(m).inputValue({ timeout: 2000 });
  return expectDigits ? digits(v) : v.trim();
}

/**
 * Whether the frame still shows the document the match was found in. A frame whose origin came from
 * its URL must still be on that origin; one that inherited its parent's origin (`about:srcdoc`,
 * `about:blank`) must still be on the same URL, so a navigation to `data:` or anywhere else fails.
 */
function sameDocumentOrigin(m: Match): boolean {
  const now = m.frame.url();
  const inherited = originOf(m.url) === "" || originOf(m.url) === "null";
  return inherited ? now === m.url : originOf(now) === m.origin;
}

/** Whether the field rejects what was typed: its constraint validation, or `aria-invalid` after blur. */
async function invalid(m: Match): Promise<boolean> {
  const el = fieldOf(m);
  await el.evaluate((e) => e.blur?.()).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 150));
  return el
    .evaluate(
      (e) =>
        (!!e.validity && !e.validity.valid) ||
        e.getAttribute("aria-invalid") === "true",
    )
    .catch(() => false);
}

/** Types `text` like a person and reads it back; a direct fill is the fallback for masks that drop keys. */
async function typeInto(
  m: Match,
  text: string,
  expectDigits: boolean,
  delay: number,
): Promise<boolean> {
  // A frame that navigated away may now hold someone else's document: never type into it.
  if (!sameDocumentOrigin(m)) return false;
  const el = fieldOf(m);
  const want = expectDigits ? digits(text) : text.trim();
  await el.click({ timeout: 5000 });
  await el.fill("", { timeout: 5000 }).catch(() => undefined);
  await el.pressSequentially(text, { delay, timeout: 15000 });
  if ((await readBack(m, expectDigits).catch(() => "")) === want) return true;
  if (!sameDocumentOrigin(m)) return false;
  await el.fill(text, { timeout: 5000 }).catch(() => undefined);
  return (await readBack(m, expectDigits).catch(() => "")) === want;
}

/**
 * Tries each spelling in turn. With `validate`, a spelling counts only if the field is valid after
 * blur and still holds it. Returns the digits or text that stuck, or null.
 */
async function typeFirst(
  m: Match,
  texts: string[],
  expectDigits: boolean,
  validate: boolean,
  delay: number,
): Promise<string | null> {
  for (const text of texts) {
    const want = expectDigits ? digits(text) : text.trim();
    if (!(await typeInto(m, text, expectDigits, delay).catch(() => false)))
      continue;
    if (!validate) return want;
    if (await invalid(m)) continue;
    // A blur handler may clear or rewrite the field.
    if ((await readBack(m, expectDigits).catch(() => "")) === want) return want;
  }
  return null;
}

/** Picks the first option that matches a spelling and survives the select's change handlers. */
async function chooseOption(
  m: Match,
  spellings: string[],
): Promise<string | null> {
  const el = fieldOf(m);
  const options = await el
    .evaluate((e) =>
      Array.from(e.options ?? []).map((o) => [o.value, o.text.trim()]),
    )
    .catch(() => [] as string[][]);
  const lower = (s: string) => s.toLowerCase();
  for (const s of spellings) {
    const hit = options.find(
      ([value, text]) => lower(value) === lower(s) || lower(text) === lower(s),
    );
    if (!hit) continue;
    try {
      const picked = await el.selectOption([{ value: hit[0] }], {
        timeout: 2000,
      });
      // Read the field back after its change handlers ran; a handler may have reset it.
      if (
        picked.length &&
        (await el.inputValue({ timeout: 2000 })) === picked[0]
      )
        return picked[0];
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/** Spellings of the expiry month an `<option>` might use: 03, 3, March, Mar. */
function monthOptions(month: number): string[] {
  const name = MONTHS[month - 1];
  return [two(month), String(month), name, name.slice(0, 3)];
}

/**
 * Types `card` into the checkout's card form on `page` (a Playwright page connected over CDP).
 * Call it after `attachInterceptor`, with the placeholder the purchase returned, once the payment
 * form is on screen. It does not press Pay. It throws a `TypeError` (with no card values) before
 * touching any field when the card's number, security code or expiry is not usable.
 */
export async function fillCard(
  page: PageLike,
  card: CardToFill,
  options: FillCardOptions = {},
): Promise<FillCardResult> {
  assertCard(card);
  const delay = options.keyDelayMs ?? 25;
  const deadline = Date.now() + (options.timeoutMs ?? 15000);

  const extra = new Set(options.frameOrigins ?? []);
  const untrusted = new Set<string>();
  let ranked = await rank(page, await scan(page, extra, untrusted));
  // Card iframes load after the page; wait until the whole card form is there or time runs out.
  const complete = () =>
    ranked.has("number") &&
    ranked.has("cvc") &&
    (ranked.has("expiry") || (ranked.has("expMonth") && ranked.has("expYear")));
  while (!complete() && Date.now() < deadline) {
    await page.waitForTimeout(500);
    ranked = await rank(page, await scan(page, extra, untrusted));
  }

  const split = ranked.has("expMonth") && ranked.has("expYear");
  const mm = two(card.expMonth);
  const plan: Array<[CardField, (m: Match) => Promise<string | null>]> = [
    ["number", (m) => typeFirst(m, [card.number], true, false, delay)],
    ...(split
      ? ([
          [
            "expMonth",
            (m: Match) =>
              m.candidate.tag === "select"
                ? chooseOption(m, monthOptions(card.expMonth))
                : typeFirst(m, [mm, String(card.expMonth)], true, true, delay),
          ],
          [
            "expYear",
            (m: Match) =>
              m.candidate.tag === "select"
                ? chooseOption(m, [String(card.expYear), two(card.expYear)])
                : typeFirst(
                    m,
                    m.candidate.maxLength === 2
                      ? [two(card.expYear)]
                      : [String(card.expYear), two(card.expYear)],
                    true,
                    true,
                    delay,
                  ),
          ],
        ] as Array<[CardField, (m: Match) => Promise<string | null>]>)
      : ([
          [
            "expiry",
            (m: Match) =>
              typeFirst(m, expiryTexts(m.candidate, card), true, true, delay),
          ],
        ] as Array<[CardField, (m: Match) => Promise<string | null>]>)),
    ["cvc", (m) => typeFirst(m, [card.cvc], true, false, delay)],
    ...(card.name
      ? ([
          [
            "name",
            (m: Match) => typeFirst(m, [card.name!], false, false, delay),
          ],
        ] as Array<[CardField, (m: Match) => Promise<string | null>]>)
      : []),
  ];

  const filled: CardField[] = [];
  const unconfirmed: CardField[] = [];
  const origins: Partial<Record<CardField, string>> = {};
  const stuck = new Map<CardField, { m: Match; value: string }>();
  for (const [field, write] of plan) {
    const matches = ranked.get(field);
    if (!matches) continue;
    // A covered or detached field fails its click; the next match for the field gets a turn.
    let done: { m: Match; value: string } | null = null;
    for (const m of matches) {
      const value = await write(m).catch(() => null);
      if (value !== null) {
        done = { m, value };
        break;
      }
    }
    origins[field] = (done?.m ?? matches[0]).origin;
    if (done) stuck.set(field, done);
    else unconfirmed.push(field);
  }

  // A later field's handlers can reset an earlier one: read every field back once more.
  for (const [field, { m, value }] of stuck) {
    const now =
      m.candidate.tag === "select"
        ? await fieldOf(m)
            .inputValue({ timeout: 2000 })
            .catch(() => "")
        : await readBack(m, field !== "name").catch(() => "");
    (now === value ? filled : unconfirmed).push(field);
  }

  const has = (f: CardField) => filled.includes(f);
  const missing: FillCardResult["missing"] = [];
  if (!has("number")) missing.push("number");
  if (!has("expiry") && !(has("expMonth") && has("expYear")))
    missing.push("expiry");
  if (!has("cvc")) missing.push("cvc");
  return {
    ok: missing.length === 0,
    filled,
    missing,
    unconfirmed,
    origins,
    untrusted: [...untrusted],
  };
}
