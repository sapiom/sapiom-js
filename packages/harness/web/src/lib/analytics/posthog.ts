import posthog from "posthog-js";

import type { AppState } from "@shared/types";

import { beforeSend } from "./before-send";
import { registerAppContext } from "./events";

/**
 * Client PostHog wiring for the Studio (SAP-1988).
 *
 * The web app mounts a React `<PostHogProvider>`; the harness is a single-page
 * shell that already owns its `AppState`, so we skip the provider and drive the
 * posthog singleton directly:
 *
 *   - {@link initAnalytics} runs once, the first time `AppState` is known, so the
 *     consent decision is atomic — there is no window where an opted-out or
 *     env-forced-off user captures anything before consent loads.
 *   - {@link syncConsent} / {@link syncIdentity} re-run whenever consent or
 *     identity changes (a Settings toggle, a sign-in).
 *
 * Two consent tiers gate this (see HarnessSettings): a hard kill-switch
 * (`consentSource === "env-forced-off"`, i.e. `SAPIOM_TELEMETRY_DISABLED` /
 * `DO_NOT_TRACK` / `--no-telemetry`) always wins; otherwise the light
 * product-analytics opt-in (`productAnalyticsOptIn`, on by default) decides.
 *
 * NO session/screen recording is ever initialized.
 */

/** The PostHog config the server bakes into `window.__HARNESS__.posthog`. */
interface InjectedPosthog {
  key: string;
  apiHost: string;
  uiHost: string;
}

function injectedConfig(): InjectedPosthog | null {
  if (typeof window === "undefined") return null;
  // Never send real analytics from Playwright mock mode.
  if (import.meta.env.VITE_MOCK) return null;
  const injected = (window as unknown as { __HARNESS__?: { posthog?: InjectedPosthog } }).__HARNESS__;
  const cfg = injected?.posthog;
  if (!cfg?.key) return null;
  return cfg;
}

/** The hard kill-switch: env/flag forced telemetry off for this boot. */
function isHardOff(state: AppState): boolean {
  return state.consentSource === "env-forced-off";
}

/** Whether light product analytics should capture, given both consent tiers. */
function shouldCapture(state: AppState): boolean {
  return !isHardOff(state) && state.productAnalyticsOptIn;
}

let initialized = false;

/**
 * Initialize PostHog once, gated on consent. Idempotent — later calls only
 * re-sync consent/identity. Safe to call with any `AppState`.
 */
export function initAnalytics(state: AppState): void {
  if (initialized) {
    syncConsent(state);
    syncIdentity(state);
    return;
  }
  const cfg = injectedConfig();
  if (!cfg) return; // analytics disabled (no key, or mock mode)

  // Do NOT init while consent is off (env-forced-off, or the light-analytics
  // opt-out). Relying on `opt_out_capturing_by_default` is not enough: with
  // `persistence: "localStorage"` posthog restores a prior opt-IN preference,
  // which takes precedence over that flag and would fire the load-time
  // $pageview before syncConsent could opt out. Not calling init() at all is
  // the only way to honor the hard kill-switch's "never fires" guarantee. When
  // consent later flips on (a Settings toggle re-runs this effect with
  // `initialized` still false), we init then.
  if (!shouldCapture(state)) return;

  if (posthog.__loaded) {
    initialized = true;
    syncConsent(state);
    syncIdentity(state);
    return;
  }

  posthog.init(cfg.key, {
    api_host: cfg.apiHost,
    ui_host: cfg.uiHost,

    // One "studio opened" signal per app load. The harness has no router, so
    // there are no SPA route changes to capture — journey context rides as a
    // super property (see events.registerViewContext) instead.
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,

    // Clickmaps + scrollmaps (fed by autocapture + $pageleave, both on).
    enable_heatmaps: true,
    // Clicks that hit nothing — the highest-signal frustration metric.
    capture_dead_clicks: true,

    // Single choke point for redaction. See before-send.ts.
    before_send: beforeSend,

    // Persist distinct id + the failed-request retry queue to localStorage so
    // events captured offline (intermittent desktop/CLI connectivity) survive a
    // reload and flush on reconnect. posthog-js batches and retries by default;
    // localStorage persistence is what makes that durable across restarts.
    persistence: "localStorage",

    // NO recording. This is a tool running on someone's desktop — we never
    // capture the screen, and disabling it explicitly guards against a remote
    // config flip turning it on.
    disable_session_recording: true,
  });

  initialized = true;
  // syncConsent flips a stale localStorage opt-out back on (we only reach here
  // when consent is on); syncIdentity binds the person + org group.
  syncConsent(state);
  syncIdentity(state);
}

/**
 * Bring posthog's capturing state in line with the two consent tiers. Called on
 * init and whenever consent changes (Settings toggle).
 */
export function syncConsent(state: AppState): void {
  if (!initialized) return;
  try {
    if (shouldCapture(state)) {
      if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
    } else if (!posthog.has_opted_out_capturing()) {
      posthog.opt_out_capturing();
    }
  } catch {
    // no-op
  }
}

/**
 * Identify the person and bind their org group so studio usage is segmentable by
 * customer, exactly like the web app. Org id is `tenantId` (identity is
 * org-scoped today; `userId === tenantId`). Resets on a real sign-out so the next
 * user doesn't inherit the previous org binding.
 */
let identifiedUserId: string | null = null;

export function syncIdentity(state: AppState): void {
  if (!initialized) return;
  try {
    if (state.authenticated && state.userId) {
      identifiedUserId = state.userId;
      posthog.identify(state.userId);
      if (state.tenantId) {
        posthog.group("organization", state.tenantId, {
          ...(state.organizationName ? { name: state.organizationName } : {}),
        });
      }
      registerAppContext({
        active_organization_id: state.tenantId ?? undefined,
        app_version: state.version,
      });
      return;
    }
    // Reset only on a real identified → anonymous transition.
    if (identifiedUserId) {
      identifiedUserId = null;
      posthog.reset();
    }
  } catch {
    // no-op
  }
}

/** Test-only: reset module state between cases. */
export function resetAnalyticsForTest(): void {
  initialized = false;
  identifiedUserId = null;
}
