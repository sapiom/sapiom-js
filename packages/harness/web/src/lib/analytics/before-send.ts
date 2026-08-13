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
 * The ONLY element attributes that ever leave the machine — an allowlist, applied
 * in every redaction mode.
 *
 * This is deliberately an allowlist rather than a denylist of known-dangerous
 * attributes, because the denylist version was wrong the moment it was written.
 * posthog-js captures EVERY attribute as `attr__*` (`r.attributes["attr__" +
 * i.name]` in `posthog-js@1.409.5`, with no default ignore list), and this
 * codebase interpolates user data into attributes that read as ours:
 *
 *   - `data-testid={`workflow-${workflow.name}`}`   (WorkflowRow — the agent's name)
 *   - `data-testid={`workspace-group-${label}`}`    (WorkflowsRail — the folder name)
 *   - `data-testid={`dir-picker-item-${entry.name}`}` (DirectoryPicker)
 *   - `title={isDirectory ? cwd : label}`           (WorkflowsRail — the ABSOLUTE PATH,
 *                                                    which contains the OS username)
 *
 * A denylist has to enumerate every such attribute correctly, forever, across
 * components nobody has written yet — and a miss is silent, because the payload
 * still looks redacted. The allowlist inverts that: a new attribute is dropped
 * until someone deliberately adds it here, so forgetting to tag a surface is
 * safe rather than leaky.
 *
 * `class` and `id` survive because heatmaps and PostHog Actions match on them,
 * and neither is a plausible place for user content. `data-testid` deliberately
 * does NOT — it is interpolated with names today, and a name-bearing testid is a
 * poor Actions selector regardless. Match on `class` instead.
 */
const KEPT_ELEMENT_ATTRIBUTES: ReadonlySet<string> = new Set(["attr__class", "attr__id"]);

/**
 * Any `attr__*="…"` in the serialized chain. Tolerates posthog's own escaping:
 * the serializer rewrites embedded quotes as `\"` (`e.replace(/"|\\"/g, '\\"')`
 * in the vendored bundle), so a plain `[^"]*` stops at the first escaped quote
 * and leaves the tail of the value behind — a partial leak in exactly the modes
 * whose job is to leave nothing. `(?:\\.|[^"\\])*` consumes escape pairs whole.
 */
const CHAIN_ANY_ATTRIBUTE = /attr__([\w-]+)="(?:\\.|[^"\\])*"/g;

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

/** `text="…"` segments inside the serialized chain. Escape-aware, same reason
 *  as {@link CHAIN_ANY_ATTRIBUTE}: an agent named `my "cool" agent` would
 *  otherwise leave `cool\" agent"` behind. */
const CHAIN_TEXT_PATTERN = /\btext="(?:\\.|[^"\\])*"/g;

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
 * aggregates across that: a URL breakdown returns one row per session, which
 * is useless, and heatmap data is keyed by URL so it never accumulates enough
 * samples on any one "page" to be worth rendering.
 *
 * The breakdown fix is unambiguous. The HEATMAP fix is not fully verified: the
 * PostHog toolbar queries heatmaps for the URL of the page it is loaded on, and
 * that page really is `http://127.0.0.1:57070/`, not the canonical host we now
 * store under. So the data should aggregate correctly and may still be
 * unreachable from inside the Studio. Confirm against a real boot before
 * treating heatmaps as working; the port collapse is right either way.
 *
 * Non-loopback URLs are left alone.
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
 * Element ATTRIBUTES are no longer part of this decision — every mode keeps
 * only {@link KEPT_ELEMENT_ATTRIBUTES}. The mode now governs the visible label
 * alone:
 *
 *  - `truncate` — the default: keep the label, cap its length.
 *  - `drop_name` — the label is user-authored (an agent/workspace/session
 *    name), so remove it, and do not synthesize a replacement from the
 *    accessible name either.
 *  - `secret` — a credential surface: drop the label and the whole chain.
 */
type RedactionMode = "truncate" | "drop_name" | "secret";

function redactionModeFor(properties: Record<string, unknown>): RedactionMode {
  if (isSecretSurface(properties)) return "secret";
  if (isUserNamedObject(properties)) return "drop_name";
  return "truncate";
}

/**
 * Scrub one entry of `properties.$elements`.
 *
 * The attribute pass runs in EVERY mode, including `truncate`. That is the
 * point of the allowlist: an untagged surface — one whose author never thought
 * about `object` — is the common case, and it must not be the leaky one.
 */
function scrubElement(element: Record<string, unknown>, mode: RedactionMode): void {
  for (const key of Object.keys(element)) {
    if (key.startsWith("attr__") && !KEPT_ELEMENT_ATTRIBUTES.has(key)) delete element[key];
  }
  if (mode === "truncate") {
    if (typeof element.$el_text === "string") {
      element.$el_text = truncateElementText(element.$el_text);
    }
    return;
  }
  delete element.$el_text;
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
  // Same allowlist as the object carrier, applied to the serialized form. A rule
  // that covers only one of the two is a rule a remote-config flip disables.
  let chain = properties.$elements_chain.replace(CHAIN_ANY_ATTRIBUTE, (match, name: string) =>
    KEPT_ELEMENT_ATTRIBUTES.has(`attr__${name}`) ? match : "",
  );
  if (mode === "drop_name") {
    // The chain carries the name a second time as a `text="…"` segment, so
    // dropping `$el_text` upstream without this just moves the leak one
    // property over.
    chain = chain.replace(CHAIN_TEXT_PATTERN, 'text=""');
  }
  properties.$elements_chain = chain;
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
 * ## The contract this depends on, and how it is enforced
 *
 * An `aria-label` is NOT automatically safe: several in this codebase
 * interpolate user data (`Copy path for ${label}`, `Focus ${label}`,
 * `More actions for ${detailStep.label}`, `${field.name}, ${field.type}`).
 * Promoting one of those would put a user-authored string straight into
 * `$el_text` — the exact property the `drop_name` mode exists to clear.
 *
 * The rule is therefore: **a surface whose labels interpolate user data must
 * carry an `object` from {@link USER_NAMED_OBJECTS}**, which puts it in
 * `drop_name` and skips promotion entirely. That is a convention, and
 * conventions rot, so it is pinned by a test rather than by this comment —
 * see `redaction-gate.test.ts`, which renders every such component with
 * fixture names and a fixture path and asserts neither reaches the payload.
 * Add a component that interpolates a label, forget the tag, and that test
 * fails.
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
