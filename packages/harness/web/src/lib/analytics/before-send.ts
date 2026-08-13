import type { CaptureResult } from "posthog-js";

/**
 * The one middleware every client event passes through (SAP-1988; ported and
 * trimmed from the web app's `before-send.ts`).
 *
 * posthog-js calls `before_send` for every capture — autocaptured, manual, and
 * internal (`$pageview`, `$feature_flag_called`) alike — which makes it the only
 * place a rule applies to *all* telemetry without touching a call site. In the
 * harness its job is **redaction** (the web app also enriches with a journey and
 * drops replay snapshots here; the harness sets journey as a super-property and
 * never records, so both are gone):
 *
 * 1. **Strip URL secrets.** The harness serves itself at
 *    `http://localhost:<port>/?token=<bootToken>` — the boot token is a live
 *    credential sitting in `$current_url` on every event. Drop ALL query params
 *    and fragments (the harness has no attribution params worth keeping).
 * 2. **Redact click text.** Truncate autocaptured `$el_text` everywhere, and
 *    drop it entirely on a secrets/vault surface, where a copy-button's label or
 *    a field value can be the secret itself.
 *
 * Never throws: posthog-js does not guard this callback, so an exception here
 * would take down capture for the whole page. On failure we pass the event
 * through unmodified rather than losing it.
 */

/** Upper bound on retained click text — longer runs are likely user content. */
const MAX_EL_TEXT_LENGTH = 120;

/**
 * Element attributes kept when scrubbing a secrets surface. `class`/`id` survive
 * because heatmaps and PostHog Actions match on them and neither is a plausible
 * place for a credential; everything else (aria-label, title, value, placeholder)
 * is dropped because any of them can carry the secret.
 */
const KEPT_ELEMENT_ATTRIBUTES: ReadonlySet<string> = new Set(["attr__class", "attr__id"]);

/** `attr__href` values inside the serialized `$elements_chain` string. */
const CHAIN_HREF_PATTERN = /attr__href="([^"]*)"/gi;

/** Person-property keys whose values are URLs, matched by suffix. */
const URL_VALUED_PERSON_PROPERTIES = /(?:current_url|referrer|pathname)$/;

/** Person-property keys whose values are bare `hostname:port` (`$initial_host`). */
const HOST_VALUED_PERSON_PROPERTIES = /host$/;

/**
 * Whether the event's autocapture attribution marks it as coming from a
 * secrets/vault surface — the container is tagged `surface: "secrets_panel"`
 * (or `object: "secret"`) via `trackingAttrs`, so the marker rides on the event
 * itself and we can redact without knowing a pathname (the harness has none).
 */
function isSecretSurface(properties: Record<string, unknown>): boolean {
  const surface = typeof properties.surface === "string" ? properties.surface.toLowerCase() : "";
  const object = typeof properties.object === "string" ? properties.object.toLowerCase() : "";
  return /secret|vault|credential/.test(surface) || /secret|vault|credential/.test(object);
}

/**
 * `object` values whose on-screen label is written by the USER, not by us.
 *
 * An agent, workspace or session is named by whoever made it, so its label is
 * user content and lands in `$el_text` verbatim — production has shipped us
 * `fetch-recent-weather`, `newsletter-autopilot`, `twitter-run` and
 * `Ewan's Organization` this way. That is wrong twice: it puts user-authored
 * strings in analytics, and it shreds the numbers, because "clicked an agent in
 * the rail" splits into one row per private agent name and never aggregates.
 *
 * Templates are deliberately absent — a gallery template's name is OUR string
 * from OUR registry, low-cardinality and safe, and it's the label that makes
 * the on-ramp funnel readable.
 */
const USER_NAMED_OBJECTS: ReadonlySet<string> = new Set(["agent", "workspace", "session", "run", "directory"]);

/** Whether this click's `object` marks it as a user-named entity. */
function isUserNamedObject(properties: Record<string, unknown>): boolean {
  const object = typeof properties.object === "string" ? properties.object.toLowerCase() : "";
  return USER_NAMED_OBJECTS.has(object);
}

/** `text="…"` segments inside the serialized `$elements_chain` string. */
const CHAIN_TEXT_PATTERN = /\btext="[^"]*"/gi;

/**
 * Element attributes that can carry a user-authored name alongside the visible
 * text — an icon button's accessible name, a truncated row's tooltip. Dropped
 * with `$el_text` on a user-named object; `class`/`id`/`data-testid` survive
 * because they are ours and are what Actions and heatmaps match on.
 *
 * Kept as both a key set and a pattern because posthog-js serializes elements
 * two different ways (`$elements` objects vs the `$elements_chain` string) and
 * a rule that covers only one of them is a rule a remote-config flip disables.
 */
const NAME_BEARING_ATTRIBUTE_NAMES = [
  "aria-label",
  "title",
  "alt",
  "placeholder",
  "value",
  "data-tooltip",
  "data-tip-stash",
] as const;

const NAME_BEARING_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(
  NAME_BEARING_ATTRIBUTE_NAMES.map((name) => `attr__${name}`),
);

const NAME_BEARING_ATTRIBUTES = new RegExp(
  `\\battr__(?:${NAME_BEARING_ATTRIBUTE_NAMES.join("|")})="[^"]*"`,
  "gi",
);

/** Loopback hostnames the harness serves itself on. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The single origin every Studio boot is reported under. See {@link sanitizeUrl}. */
const CANONICAL_STUDIO_HOST = "localhost";

/**
 * Strip the query string and fragment from an absolute URL, keeping only
 * origin + path, and collapse the harness's ephemeral port. Returns the input
 * unchanged if it does not parse, since a non-URL value here means our
 * assumption is wrong and silently blanking it would lose more than it
 * protects.
 *
 * The port matters as much as the query string, for a different reason. The
 * harness binds a RANDOM free port every boot, so `$current_url` and `$host`
 * are unique per run — `127.0.0.1:57070`, `:53213`, `:64964`. Nothing
 * aggregates across that: URL breakdowns return one row per session, and
 * clickmaps/scrollmaps (which key on URL) never accumulate enough samples on
 * any one "page" to render, so `enable_heatmaps` silently produces nothing.
 * Collapsing every loopback origin to a single canonical host is what makes
 * those features work at all. Non-loopback URLs are left alone.
 */
export function sanitizeUrl(rawUrl: unknown): unknown {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return rawUrl;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const origin = LOOPBACK_HOSTNAMES.has(url.hostname)
    ? `${url.protocol}//${CANONICAL_STUDIO_HOST}`
    : url.origin;
  // The harness carries no attribution params — drop the whole query (which
  // includes the boot token) and any fragment.
  return `${origin}${url.pathname}`;
}

/**
 * Collapse a bare `$host` / `$initial_host` value (`127.0.0.1:57070`) the same
 * way {@link sanitizeUrl} collapses a full URL. These arrive already split
 * into `hostname:port`, so they never reach the `URL` parser above.
 */
export function sanitizeHost(rawHost: unknown): unknown {
  if (typeof rawHost !== "string" || rawHost.length === 0) return rawHost;
  const hostname = rawHost.replace(/:\d+$/, "");
  return LOOPBACK_HOSTNAMES.has(hostname) ? CANONICAL_STUDIO_HOST : rawHost;
}

/** Truncate retained click text with an ellipsis marker. */
function truncateElementText(text: string): string {
  return text.length > MAX_EL_TEXT_LENGTH ? `${text.slice(0, MAX_EL_TEXT_LENGTH)}…` : text;
}

/**
 * How hard to scrub a click's element data.
 *
 *  - `truncate` — the default: keep the label, cap its length.
 *  - `drop_name` — the label is user-authored (an agent/workspace/session
 *    name), so remove it and the attributes that mirror it, but keep our own
 *    `class`/`id`/`data-testid` so the control is still identifiable.
 *  - `secret` — a credential surface: keep nothing but `class`/`id`.
 */
type RedactionMode = "truncate" | "drop_name" | "secret";

function redactionModeFor(properties: Record<string, unknown>): RedactionMode {
  if (isSecretSurface(properties)) return "secret";
  if (isUserNamedObject(properties)) return "drop_name";
  return "truncate";
}

/** Scrub one entry of `properties.$elements`. */
function scrubElement(element: Record<string, unknown>, mode: RedactionMode): void {
  if (mode === "secret") {
    delete element.$el_text;
    for (const key of Object.keys(element)) {
      if (key.startsWith("attr__") && !KEPT_ELEMENT_ATTRIBUTES.has(key)) delete element[key];
    }
    return;
  }
  if (mode === "drop_name") {
    delete element.$el_text;
    for (const key of Object.keys(element)) {
      if (NAME_BEARING_ATTRIBUTE_KEYS.has(key)) delete element[key];
    }
  } else if (typeof element.$el_text === "string") {
    element.$el_text = truncateElementText(element.$el_text);
  }
  if (typeof element.attr__href === "string") {
    element.attr__href = sanitizeUrl(element.attr__href);
  }
}

/**
 * Scrub the two nested carriers of autocaptured element data. posthog-js emits
 * **either** `$elements` (array) or `$elements_chain` (string) depending on
 * remote config, so both are handled — a server-side flip cannot silently start
 * leaking.
 */
function scrubElementCarriers(properties: Record<string, unknown>, mode: RedactionMode): void {
  const elements = properties.$elements;
  if (Array.isArray(elements)) {
    for (const element of elements) {
      if (element && typeof element === "object") scrubElement(element as Record<string, unknown>, mode);
    }
  }

  if (typeof properties.$elements_chain !== "string") return;
  if (mode === "secret") {
    delete properties.$elements_chain;
    return;
  }
  let chain = properties.$elements_chain;
  if (mode === "drop_name") {
    // The chain carries the same name twice — as a `text="…"` segment and as
    // the accessible-name attributes — so both have to go, or dropping
    // `$el_text` upstream just moves the leak one property over.
    chain = chain.replace(CHAIN_TEXT_PATTERN, 'text=""').replace(NAME_BEARING_ATTRIBUTES, "");
  }
  properties.$elements_chain = chain.replace(CHAIN_HREF_PATTERN, (match, href: string) => {
    const sanitized = sanitizeUrl(href);
    return typeof sanitized === "string" ? `attr__href="${sanitized}"` : match;
  });
}

/**
 * Sanitize every URL-valued field on the event, including the `$set`/`$set_once`
 * person-property bags (siblings of `properties`, not members of it) — posthog-js
 * writes `$initial_current_url` there, which would otherwise pin the boot-token
 * URL onto the person profile permanently.
 */
function redactUrls(result: CaptureResult, properties: Record<string, unknown>): void {
  properties.$current_url = sanitizeUrl(properties.$current_url);
  properties.$referrer = sanitizeUrl(properties.$referrer);
  // `$host` arrives pre-split as `hostname:port`, so it needs the bare-host
  // form of the same collapse — otherwise every boot is still its own row.
  properties.$host = sanitizeHost(properties.$host);

  for (const bag of [result.$set, result.$set_once]) {
    if (!bag) continue;
    const personProperties = bag as Record<string, unknown>;
    for (const key of Object.keys(personProperties)) {
      if (URL_VALUED_PERSON_PROPERTIES.test(key)) personProperties[key] = sanitizeUrl(personProperties[key]);
      else if (HOST_VALUED_PERSON_PROPERTIES.test(key)) personProperties[key] = sanitizeHost(personProperties[key]);
    }
  }
}

/** An `attr__aria-label="…"` in the serialized chain. Anchored on the full
 *  attribute name so it cannot match `aria-labelledby` or `aria-hidden`. */
const CHAIN_ARIA_LABEL_PATTERN = /attr__aria-label="([^"]*)"/i;

/**
 * Give icon-only controls a readable label.
 *
 * posthog-js fills `$el_text` from the element's TEXT only. An icon button has
 * none — the click lands on the `<svg>` — so roughly a third of Studio clicks
 * arrive with `$el_text` unset and show up as a blank row in every breakdown,
 * even though the button is perfectly well described by an `aria-label` that
 * posthog already captured into the element chain. Composer send, rail
 * collapse, back/forward, add-workspace and directory-up are all in that
 * bucket today.
 *
 * So: when there is no text, promote the nearest ancestor's accessible name
 * into `$el_text`. One rule fixes every such control, including ones nobody
 * has written yet, and it reuses labels that are already maintained because
 * screen readers depend on them — strictly better than a hand-kept list of
 * per-button tracking attributes that silently rots.
 *
 * Only runs in `truncate` mode: on a user-named or secret surface the whole
 * point is that the label goes away.
 */
function promoteAccessibleName(properties: Record<string, unknown>): void {
  const existing = properties.$el_text;
  if (typeof existing === "string" && existing.trim() !== "") return;

  let name: string | undefined;
  const elements = properties.$elements;
  if (Array.isArray(elements)) {
    // Nearest-first: `$elements[0]` is the clicked node, so the first
    // accessible name walking outward is the control's own.
    for (const element of elements) {
      const candidate = (element as Record<string, unknown> | null)?.["attr__aria-label"];
      if (typeof candidate === "string" && candidate.trim() !== "") {
        name = candidate;
        break;
      }
    }
  }
  if (name === undefined && typeof properties.$elements_chain === "string") {
    // The chain is serialized nearest-first too, so the first match is nearest.
    name = CHAIN_ARIA_LABEL_PATTERN.exec(properties.$elements_chain)?.[1];
  }

  if (name !== undefined && name.trim() !== "") {
    properties.$el_text = truncateElementText(name);
    // Mark it so analysis can tell a real label from one we inferred, rather
    // than quietly changing what `$el_text` means.
    properties.el_text_source = "aria_label";
  }
}

/** Redact autocaptured click text — the top-level `$el_text` and the nested carriers. */
function redactClickText(properties: Record<string, unknown>, mode: RedactionMode): void {
  if (typeof properties.$el_text === "string") {
    if (mode === "truncate") {
      properties.$el_text = truncateElementText(properties.$el_text);
    } else {
      delete properties.$el_text;
    }
  }
  // Promote BEFORE scrubbing the carriers: `drop_name`/`secret` strip
  // `attr__aria-label` out of them, so a promotion attempted afterwards would
  // find nothing — and must not, since those modes are removing the label on
  // purpose. Guarding on the mode here says that intent explicitly rather than
  // leaving it to call order.
  if (mode === "truncate") promoteAccessibleName(properties);
  scrubElementCarriers(properties, mode);
}

/** `before_send` implementation. Returns `null` to drop an event (never used today). */
export function beforeSend(result: CaptureResult | null): CaptureResult | null {
  if (!result) return result;
  try {
    const properties = (result.properties ?? {}) as Record<string, unknown>;
    const mode = redactionModeFor(properties);

    redactUrls(result, properties);
    redactClickText(properties, mode);

    result.properties = properties;
    return result;
  } catch {
    // Pass through unmodified — dropping telemetry is worse than un-redacted
    // telemetry only in the sense that an unhandled throw here breaks capture
    // page-wide; the URL/token risk is mitigated by posthog's own config too.
    return result;
  }
}
