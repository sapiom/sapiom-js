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
 * would take down capture for the whole page. On failure we drop the one event;
 * an analytics gap is safer than sending a live boot token or secret-surface
 * text that we could not prove was redacted.
 */

/** Upper bound on retained click text — longer runs are likely user content. */
const MAX_EL_TEXT_LENGTH = 120;

/**
 * Element attributes kept when scrubbing a secrets surface. `class`/`id` survive
 * because heatmaps and PostHog Actions match on them and neither is a plausible
 * place for a credential; everything else (aria-label, title, value, placeholder)
 * is dropped because any of them can carry the secret.
 */
const KEPT_ELEMENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "attr__class",
  "attr__id",
]);

/** `attr__href` values inside the serialized `$elements_chain` string. */
const CHAIN_HREF_PATTERN = /attr__href="([^"]*)"/gi;

/** Person-property keys whose values are URLs, matched by suffix. */
const URL_VALUED_PERSON_PROPERTIES = /(?:current_url|referrer|pathname)$/;

/**
 * Whether the event's autocapture attribution marks it as coming from a
 * secrets/vault surface — the container is tagged `surface: "secrets_panel"`
 * (or `object: "secret"`) via `trackingAttrs`, so the marker rides on the event
 * itself and we can redact without knowing a pathname (the harness has none).
 */
function isSecretSurface(properties: Record<string, unknown>): boolean {
  const surface =
    typeof properties.surface === "string"
      ? properties.surface.toLowerCase()
      : "";
  const object =
    typeof properties.object === "string"
      ? properties.object.toLowerCase()
      : "";
  return (
    /secret|vault|credential/.test(surface) ||
    /secret|vault|credential/.test(object)
  );
}

/**
 * Strip the query string and fragment from an absolute URL, keeping only
 * origin + path. Returns the input unchanged if it does not parse, since a
 * non-URL value here means our assumption is wrong and silently blanking it
 * would lose more than it protects.
 */
export function sanitizeUrl(rawUrl: unknown): unknown {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return rawUrl;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  // The harness carries no attribution params — drop the whole query (which
  // includes the boot token) and any fragment.
  return `${url.origin}${url.pathname}`;
}

/** Truncate retained click text with an ellipsis marker. */
function truncateElementText(text: string): string {
  return text.length > MAX_EL_TEXT_LENGTH
    ? `${text.slice(0, MAX_EL_TEXT_LENGTH)}…`
    : text;
}

/** Scrub one entry of `properties.$elements`. */
function scrubElement(
  element: Record<string, unknown>,
  isSecret: boolean,
): void {
  if (isSecret) {
    delete element.$el_text;
    for (const key of Object.keys(element)) {
      if (key.startsWith("attr__") && !KEPT_ELEMENT_ATTRIBUTES.has(key))
        delete element[key];
    }
    return;
  }
  if (typeof element.$el_text === "string") {
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
function scrubElementCarriers(
  properties: Record<string, unknown>,
  isSecret: boolean,
): void {
  const elements = properties.$elements;
  if (Array.isArray(elements)) {
    for (const element of elements) {
      if (element && typeof element === "object")
        scrubElement(element as Record<string, unknown>, isSecret);
    }
  }

  if (typeof properties.$elements_chain !== "string") return;
  if (isSecret) {
    delete properties.$elements_chain;
    return;
  }
  properties.$elements_chain = properties.$elements_chain.replace(
    CHAIN_HREF_PATTERN,
    (match, href: string) => {
      const sanitized = sanitizeUrl(href);
      return typeof sanitized === "string"
        ? `attr__href="${sanitized}"`
        : match;
    },
  );
}

/**
 * Sanitize every URL-valued field on the event, including the `$set`/`$set_once`
 * person-property bags (siblings of `properties`, not members of it) — posthog-js
 * writes `$initial_current_url` there, which would otherwise pin the boot-token
 * URL onto the person profile permanently.
 */
function redactUrls(
  result: CaptureResult,
  properties: Record<string, unknown>,
): void {
  properties.$current_url = sanitizeUrl(properties.$current_url);
  properties.$referrer = sanitizeUrl(properties.$referrer);

  for (const bag of [result.$set, result.$set_once]) {
    if (!bag) continue;
    const personProperties = bag as Record<string, unknown>;
    for (const key of Object.keys(personProperties)) {
      if (URL_VALUED_PERSON_PROPERTIES.test(key))
        personProperties[key] = sanitizeUrl(personProperties[key]);
    }
  }
}

/** Redact autocaptured click text — the top-level `$el_text` and the nested carriers. */
function redactClickText(
  properties: Record<string, unknown>,
  isSecret: boolean,
): void {
  if (typeof properties.$el_text === "string") {
    if (isSecret) {
      delete properties.$el_text;
    } else {
      properties.$el_text = truncateElementText(properties.$el_text);
    }
  }
  scrubElementCarriers(properties, isSecret);
}

/** `before_send` implementation. Returns `null` when an event cannot be redacted safely. */
export function beforeSend(result: CaptureResult | null): CaptureResult | null {
  if (!result) return result;
  try {
    const properties = (result.properties ?? {}) as Record<string, unknown>;
    const secret = isSecretSurface(properties);

    redactUrls(result, properties);
    redactClickText(properties, secret);

    result.properties = properties;
    return result;
  } catch {
    // Fail closed. The event may still contain the per-boot URL credential or
    // secret-surface text, so it cannot leave the machine unredacted.
    return null;
  }
}
