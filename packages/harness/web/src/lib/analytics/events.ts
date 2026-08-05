import posthog from "posthog-js";

import { type HarnessView, type Journey, journeyForView } from "./journeys";

/**
 * Typed event registry for the Studio (SAP-1988; ported from the web app's
 * `events.ts`).
 *
 * ## What belongs here, and what does not
 *
 * Autocapture + `trackingAttrs` already covers **intent** — every click, with
 * journey and surface attribution, for free. This registry is for the half
 * autocapture is blind to: **outcomes and non-DOM state transitions.** "They
 * clicked Deploy" is autocaptured; "the deploy succeeded 4s later" or "the run
 * failed" is not, and that gap is where the launch-scorecard funnel lives.
 *
 * - A user pressed something → rely on autocapture + `trackingAttrs`.
 * - A run/deploy changed state, a secret write failed, a turn got stuck → add it
 *   here.
 *
 * ## Naming
 *
 * `<object>.<action>`, snake_case within segments — dotted to namespace, the same
 * convention the web app moved to. Payloads are snake_case and ids stay strings
 * so a breakdown never splits across a number/string of the same id.
 *
 * ## Privacy
 *
 * NEVER put prompt text, file contents, secret values, or any user content in a
 * payload — the same rule the BQ `track()` enforces. Only ids, enums, counts,
 * and durations.
 */
export interface AnalyticsEventMap {
  /** A new Studio session was created (the studio's own "session start"). */
  "session.started": {
    harness_kind?: string;
    /** Whether this was the auto-created boot session vs a user-created one. */
    origin?: "boot" | "user";
  };

  /**
   * A new agent came into existence — a fresh `sapiom.json` appeared in the
   * workspace registry. This is the confirmed-existence signal for "agents
   * built": deduped by path, and seeded on first load so pre-existing agents
   * are never counted. Deliberately distinct from the click that kicks off
   * scaffolding (already autocaptured) — the scaffold itself runs async in the
   * coding agent, so we count the agent that actually appeared, not the intent.
   */
  "agent.created": { workflow_slug?: string };

  /** A workflow/agent run was triggered from the Studio. */
  "agent.run_started": {
    workflow_slug?: string;
    session_id?: string;
  };
  /** A run reached a terminal success. */
  "agent.run_succeeded": {
    workflow_slug?: string;
    session_id?: string;
    duration_ms?: number;
  };
  /** A run reached a terminal failure. `error_kind` is an enum, never a message. */
  "agent.run_failed": {
    workflow_slug?: string;
    session_id?: string;
    duration_ms?: number;
    error_kind?: string;
  };

  /** A deploy was initiated from the Studio. */
  "agent.deploy_started": { workflow_slug?: string };
  /** A deploy completed successfully. */
  "agent.deploy_succeeded": { workflow_slug?: string; duration_ms?: number };
  /** A deploy failed. `error_kind` is an enum, never a message. */
  "agent.deploy_failed": { workflow_slug?: string; error_kind?: string };

  /** A template was cloned into a new workspace/agent. */
  "agent.template_cloned": {
    template_slug?: string;
    /** Where the clone was initiated from, for the on-ramp breakdown. */
    surface?: "welcome" | "template_gallery" | "template_detail";
  };

  /** The secrets/vault panel was opened — the friction surface that motivated this work. */
  "secrets.panel_opened": { session_id?: string };
  /** A secret/env var was set successfully. */
  "secrets.set_succeeded": { session_id?: string };
  /** Setting a secret failed. `error_kind` is an enum, never a message or value. */
  "secrets.set_failed": { session_id?: string; error_kind?: string };

  /**
   * The agent appears stuck — repeated tool errors or a turn making no progress.
   * The signal we'd have wanted when Yash & Oded got stuck on vault/secrets.
   */
  "agent.turn_stuck": {
    session_id?: string;
    /** What we think it's stuck on, as a coarse enum: e.g. "secrets", "tool_error". */
    stuck_on?: string;
    /** How many consecutive failing/repeating tool calls triggered the signal. */
    repeats?: number;
  };
}

/**
 * Emit a custom event. The only way to fire a non-autocapture event — an
 * unregistered name is a type error, which keeps the taxonomy from drifting one
 * ad-hoc `posthog.capture` at a time. Best-effort: wrapped so a capture failure
 * never breaks the measured flow.
 */
export function track<K extends keyof AnalyticsEventMap>(event: K, properties: AnalyticsEventMap[K]): void {
  // Playwright runs with VITE_MOCK and never initializes PostHog (see
  // posthog.ts `injectedConfig`), so there is nothing to assert against in
  // e2e. Record the event on the test global instead — the same seam
  // `interceptMockTrack` uses for the collector `track` — and skip any real
  // capture. Read it in specs via `window.__HARNESS_TEST__.productEvents`.
  if (import.meta.env.VITE_MOCK) {
    try {
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      const prev = (win.__HARNESS_TEST__?.productEvents as unknown[]) ?? [];
      win.__HARNESS_TEST__ = {
        ...(win.__HARNESS_TEST__ ?? {}),
        productEvents: [...prev, { event, properties }],
      };
    } catch {
      // no-op
    }
    return;
  }
  try {
    posthog.capture(event, properties);
  } catch {
    // Analytics must never break the UI.
  }
}

/**
 * Super properties that ride on every subsequent event (including autocaptured
 * clicks with no call site to thread context through). Set once identity/app
 * context is known and re-set when it changes.
 */
export interface AppContextProperties {
  active_organization_id?: string;
  app_version?: string;
  harness_kind?: string;
  /** Which host is running the SPA — "cli" (npx) or "desktop" (Electron). */
  harness_host?: string;
}

export function registerAppContext(context: AppContextProperties): void {
  try {
    // Drop undefineds so they never land as the string "undefined".
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(context)) {
      if (v !== undefined && v !== null && v !== "") clean[k] = v;
    }
    posthog.register(clean);
  } catch {
    // no-op
  }
}

/**
 * Stamp the current journey + a coarse view label as super properties, so every
 * event — autocapture included — is groupable by arc of intent. This is the
 * harness's replacement for the web app's pathname-derived `before_send`
 * enrichment; called by App whenever its view state changes.
 */
export function registerViewContext(view: HarnessView): void {
  try {
    const journey: Journey = journeyForView(view);
    posthog.register({ journey, view: coarseViewLabel(view) });
  } catch {
    // no-op
  }
}

/** A stable, low-cardinality label for the current view, for breakdowns. */
function coarseViewLabel(view: HarnessView): string {
  if (view.settingsOpen) return "settings";
  if (view.firstRun && !view.hasLiveSession) return "welcome";
  if (view.templatesOpen) return "templates";
  if (view.hasLiveSession) return `workbench:${view.rightTab ?? "chat"}`;
  if (view.inspectingDeadSession) return "session_history";
  return "unknown";
}
