import type { Journey } from "./journeys";

/**
 * Declarative click attribution via autocapture data attributes (SAP-1988;
 * ported from the web app's `frontend/src/lib/analytics/tracking-attrs.ts`).
 *
 * posthog-js collects any attribute named `data-ph-capture-attribute-<key>`
 * into the `$autocapture` event as the property `<key>`, and it does so **while
 * walking the clicked element's ancestor chain**, merging what it finds at every
 * level. That ancestor merge is the whole design: context set once on a
 * container is inherited by every click beneath it, so a surface gets full
 * attribution with zero per-callsite tracking code.
 *
 * Two consequences worth knowing:
 *
 * - **Values must be strings.** The SDK skips non-string attribute values, so
 *   everything here is coerced.
 * - **The OUTERMOST element wins a key conflict** — not the nearest. Give each
 *   level its own key: broad context (`journey`, `surface`) on containers,
 *   specific context (`intent`, `object`) on the control. Never set the same key
 *   at two depths.
 */

const ATTRIBUTE_PREFIX = "data-ph-capture-attribute-";

export interface TrackingContext {
  /**
   * The arc of intent. Usually omitted — the current journey rides as a
   * super-property (see events.ts `registerViewContext`).
   *
   * Set it explicitly only for UI that both outlives its view AND belongs to
   * one journey — a modal that always means "deploy", say. A navigator like the
   * command palette does NOT qualify: it can take you anywhere, so it has no
   * journey of its own and the ambient value (which journey you reached for it
   * FROM) is the more useful fact. That is why `CommandPalette` sets only
   * `dialog`.
   */
  readonly journey?: Journey;
  /**
   * The specific UI region, in snake_case: `agent_rail`, `run_canvas`,
   * `secrets_panel`. The main dimension for "where did they click?"
   *
   * Set this on TOP-LEVEL regions only. Because the outermost element wins a
   * key conflict (see above), a `surface` on a component nested inside another
   * surfaced region is silently discarded — which looks identical to working
   * instrumentation. For a modal hosted inside such a region, use
   * {@link TrackingContext.dialog} instead.
   */
  readonly surface?: string;
  /**
   * The open modal/dialog, in snake_case: `add_agents`, `template_use`,
   * `command_palette`.
   *
   * A separate dimension from `surface` rather than a value of it, because a
   * dialog is not laid out where it conceptually belongs: `StartDialog` is a
   * DOM child of the agent rail, so a `surface` on it loses to the rail's and
   * vanishes. Keeping its own key means both survive — you get "the
   * add-agents dialog" AND "opened from the rail", which is the pair you
   * actually want when asking where a flow was entered from.
   */
  readonly dialog?: string;
  /** The kind of entity being acted on: `session`, `template`, `secret`, `run`. */
  readonly object?: string;
  /**
   * What the control is trying to do: `deploy`, `run`, `open_detail`,
   * `set_secret`. Belongs on the control itself rather than a container.
   */
  readonly intent?: string;
}

/**
 * Build the `data-ph-capture-attribute-*` props for a tracking context.
 *
 * Spread onto any element to attribute it and everything inside it:
 *
 * ```tsx
 * <button {...trackingAttrs({ surface: "agent_rail", intent: "deploy" })}>Deploy</button>
 * ```
 *
 * Undefined and empty values are omitted so they never land as the string
 * `"undefined"` in analysis.
 */
export function trackingAttrs(context: TrackingContext): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null) continue;
    const stringValue = String(value);
    if (stringValue.length === 0) continue;
    attrs[`${ATTRIBUTE_PREFIX}${key}`] = stringValue;
  }
  return attrs;
}
