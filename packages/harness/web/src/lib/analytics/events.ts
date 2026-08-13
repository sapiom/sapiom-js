import posthog from "posthog-js";

import type { HarnessKind, RunTarget } from "@shared/types";

import { type HarnessView, type Journey, journeyForView } from "./journeys";
import { type AgentSource, type RunErrorKind } from "./lifecycle";

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
  "agent.created": {
    workflow_slug?: string;
    /** Provenance bucket from the project's sapiom.json — see lifecycle.ts `agentSource`. */
    source?: AgentSource;
    /** Public id of what it was made from: gallery template id or bundled starter id. Absent for fork/scratch. */
    template_id?: string;
  };

  /**
   * A run was announced to the Studio. Fired from the two places a run can
   * enter the store — {@link startRunPolling} (a prod run, whether launched
   * from the Prod Run button or detected from the CLI's own output) and the
   * local-run stream — so the funnel counts runs the user *caused*, not just
   * runs a button started.
   */
  "agent.run_started": {
    workflow_slug?: string;
    session_id?: string;
    /** Where it executed. `local` runs are stubbed against fixtures and cost nothing. */
    target?: RunTarget;
  };
  /** A run reached a terminal success. */
  "agent.run_succeeded": {
    workflow_slug?: string;
    session_id?: string;
    duration_ms?: number;
    target?: RunTarget;
  };
  /** A run reached a terminal failure. `error_kind` is an enum, never a message. */
  "agent.run_failed": {
    workflow_slug?: string;
    session_id?: string;
    duration_ms?: number;
    target?: RunTarget;
    error_kind?: RunErrorKind;
  };

  /** A deploy was initiated from the Studio. `source`/`template_id` as on `agent.created` — built and deployed split on the same dimension. */
  "agent.deploy_started": {
    workflow_slug?: string;
    source?: AgentSource;
    template_id?: string;
  };
  /** A deploy completed successfully. */
  "agent.deploy_succeeded": {
    workflow_slug?: string;
    duration_ms?: number;
    source?: AgentSource;
    template_id?: string;
  };
  /** A deploy failed. `error_kind` is an enum, never a message. */
  "agent.deploy_failed": {
    workflow_slug?: string;
    error_kind?: string;
    source?: AgentSource;
    template_id?: string;
  };

  /** A template was cloned into a new workspace/agent. */
  "agent.template_cloned": {
    /**
     * @deprecated Pre-provenance name — always the same value as `template_id`.
     * Kept so existing dashboard breakdowns keep working; do not add readers.
     */
    template_slug?: string;
    /** The template's public id — the one name the registry speaks, matching the other lifecycle events. */
    template_id?: string;
    /** Where the clone was initiated from, for the on-ramp breakdown. */
    surface?: "welcome" | "template_gallery" | "template_detail";
  };

  // ---------------------------------------------------------------------
  // NOT WIRED YET — declared ahead of the surfaces that would emit them.
  //
  // Both of these were added with the original instrumentation as the shape we
  // wanted, and neither has a call site because the thing it measures does not
  // exist in the Studio yet. They are kept (rather than deleted) because the
  // payload shape is the design decision worth preserving — but an entry with
  // no emitter reads exactly like a working metric on this list, which is how
  // four weeks passed with a deploy funnel and no run funnel. So: say so here,
  // and say what each one is waiting on.
  // ---------------------------------------------------------------------

  /**
   * The secrets/vault panel was opened.
   *
   * BLOCKED: the Studio has no secrets panel. `TemplateDetail` lists a
   * template's `requiredSecrets` read-only, and every actual set-a-secret flow
   * happens either in the coding agent's own pty or on the Sapiom dashboard —
   * neither of which this SPA can observe. Wire when a real panel lands.
   */
  "secrets.panel_opened": { session_id?: string };
  /** A secret/env var was set successfully. BLOCKED — see `secrets.panel_opened`. */
  "secrets.set_succeeded": { session_id?: string };
  /** Setting a secret failed. BLOCKED — see `secrets.panel_opened`. */
  "secrets.set_failed": { session_id?: string; error_kind?: string };

  /**
   * The agent appears stuck — repeated tool errors or a turn making no progress.
   * The signal we'd have wanted when Yash & Oded got stuck on vault/secrets.
   *
   * BLOCKED on server plumbing, not on a decision here. Detecting this needs
   * live per-tool-call outcomes, and the SPA never sees them: `BusMessage`
   * carries session status, canvas reloads, port detections, execution starts
   * and throttled "the pty produced output" pings — nothing tool-shaped. The
   * data does exist server-side (`SessionRecordToolCall`, written by
   * `core/session-record.ts`) but only lands in the SPA as a finished
   * `SessionRecord` for a session that is already over, which is too late to
   * be the stuck signal. Wire once the bus carries tool outcomes live.
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
  // e2e. Record the event on the same test global `interceptMockTrack` uses —
  // `window.__HARNESS_TEST__` — under its own `productEvents` key (the
  // collector's `interceptMockTrack` writes `trackEvents`), and skip any real
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
  /**
   * The coding agent behind the ACTIVE session, or absent when no session is
   * live. Re-registered when the active session changes, so a click is
   * attributed to the agent that was on screen — not to whichever agent
   * happened to boot first.
   */
  harness_kind?: HarnessKind;
  /**
   * Which host is running the SPA — "cli" (npx) or "desktop" (Electron).
   *
   * Nothing else can recover this: Electron's renderer reports itself as
   * Chrome on the user's OS, so a desktop session and an `npx` session are
   * byte-identical in `$browser`/`$os`. Without it "how many people use the
   * desktop app" has no answer at all.
   */
  harness_host?: HarnessHost;
  /**
   * A random id minted once per SPA load, so one Studio run's events can be
   * stitched back into a session.
   *
   * PostHog's own `$session_id` does not answer this question here. The
   * harness serves itself on an EPHEMERAL PORT, so each boot is a different
   * origin with its own `localStorage` — a returning user looks like a new
   * anonymous person, and two Studios open at once share one person's
   * timeline with nothing to separate them. This id is what makes a run
   * reconstructable in either case.
   *
   * Not the boot token: that is a live credential (which is why `before-send`
   * strips the query string), and it must never become an analytics key.
   */
  studio_boot_id?: string;
}

/** Which shell is hosting the SPA. See {@link AppContextProperties.harness_host}. */
export type HarnessHost = "cli" | "desktop";

/**
 * The per-load id carried as `studio_boot_id`. Generated lazily on first read
 * and memoized for the life of the page, so every event in one Studio run
 * agrees. Falls back to a `Math.random` id where `crypto.randomUUID` is absent
 * (older Electron, non-secure contexts) — this identifies a page load, not a
 * person, so it has no uniqueness requirement beyond "don't collide today".
 */
let bootId: string | null = null;

export function studioBootId(): string {
  if (bootId) return bootId;
  try {
    bootId = globalThis.crypto?.randomUUID?.() ?? null;
  } catch {
    bootId = null;
  }
  bootId ??= `boot-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return bootId;
}

/** Test-only: forget the memoized boot id so cases don't leak into each other. */
export function resetStudioBootIdForTest(): void {
  bootId = null;
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
