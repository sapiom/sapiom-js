/**
 * Journey taxonomy for the Studio (SAP-1988) — the harness port of the web
 * app's `frontend/src/lib/analytics/journeys.ts`.
 *
 * A "journey" is the arc of intent a user is in, stamped on every event so
 * autocapture is groupable by intent instead of raw UI coordinates. The web app
 * derives it from the URL pathname; the harness has **no router and no
 * pathname** — it is a single-page shell with internal view state — so we
 * classify from a small {@link HarnessView} descriptor the App computes from its
 * live state instead.
 *
 * The `Journey` union is intentionally identical to the web app's so studio and
 * web events share one `journey` vocabulary and can sit in the same PostHog
 * funnels. The harness only ever emits the subset it can reach; the rest exist
 * for cross-surface compatibility.
 */

/** The arcs of intent we analyse. Mirrors the web app's union verbatim. */
export type Journey =
  | "auth"
  | "onboarding"
  | "overview"
  | "agent_build"
  | "agent_operate"
  | "agent_observe"
  | "capabilities"
  | "assistant"
  | "account"
  | "internal_demo"
  | "unknown";

/**
 * The minimal view descriptor the App derives from its own state. Deliberately
 * decoupled from App's concrete state variable names so this module stays pure
 * and unit-testable — App maps its state onto this shape once (see
 * `viewForAppState` at the call site).
 */
export interface HarnessView {
  /** First-run welcome overlay is showing (no prior harness use, no live session). */
  readonly firstRun?: boolean;
  /** The settings popover / account surface is open. */
  readonly settingsOpen?: boolean;
  /** The template gallery is open. */
  readonly templatesOpen?: boolean;
  /** There is at least one live (running) agent session. */
  readonly hasLiveSession?: boolean;
  /** The currently-selected session is a dead/historical one being inspected. */
  readonly inspectingDeadSession?: boolean;
  /** The active right-hand tab, when a session is open: canvas | preview | logs | diff … */
  readonly rightTab?: string | null;
}

/**
 * Classify a view descriptor into its journey. Order matters — the most
 * specific, highest-intent signal wins. Returns `'unknown'` for a shape no rule
 * matched rather than guessing, so `unknown` surfacing in analysis is the
 * signal that this table needs a new rule (same discipline as the web app).
 */
export function journeyForView(view: HarnessView | null | undefined): Journey {
  if (!view) return "unknown";

  // Account/settings is a modal surface that outlives whatever is behind it.
  if (view.settingsOpen) return "account";

  // First-run welcome is the onboarding arc, before any session exists.
  if (view.firstRun && !view.hasLiveSession) return "onboarding";

  // Browsing templates is where building starts (the on-ramp to authoring).
  if (view.templatesOpen) return "agent_build";

  // With a live session, the right-hand tab distinguishes operating a run
  // (canvas/preview — watching it do the thing) from observing it (logs/diff).
  if (view.hasLiveSession) {
    const tab = view.rightTab ?? "";
    if (tab === "logs" || tab === "diff") return "agent_observe";
    if (tab === "canvas" || tab === "preview") return "agent_operate";
    // Chatting/iterating in the workbench with no operate tab focused: authoring.
    return "agent_build";
  }

  // Inspecting a finished/dead session is the observe arc.
  if (view.inspectingDeadSession) return "agent_observe";

  return "unknown";
}
