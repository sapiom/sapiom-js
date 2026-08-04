import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { AppState, DisplayMode } from "@shared/types";
import { HARNESS_PATHS } from "@shared/types";

import type { AuthStartResponse } from "../lib/api";
import { Icon } from "./Icon";
import { getDisplayMode, setDisplayMode, subscribeDisplayMode } from "../lib/theme";
import { track } from "../lib/track";

/** Sign-in progress state in the Settings popover. */
type AuthProgress =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string };

interface SettingsPopoverProps {
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  /** Light product-analytics (PostHog clicks/journeys) opt-in — on by default. */
  productAnalyticsOptIn: boolean;
  /** How consent was determined - "env-forced-off" locks BOTH toggles. */
  consentSource?: AppState["consentSource"];
  /** Which env var forced telemetry off, when consentSource is "env-forced-off". */
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  onToggleProductAnalytics: (next: boolean) => Promise<void>;
  /** `HarnessSettings.rollingSummary` — see the toggle's own note below. */
  rollingSummary: boolean;
  onToggleRollingSummary: (next: boolean) => Promise<void>;
  /** Kick off the browser OAuth flow — see HarnessApi.startAuth(). */
  onStartAuth: () => Promise<AuthStartResponse>;
  /** Sign out and clear credentials — see HarnessApi.disconnect(). */
  onDisconnect: () => Promise<void>;
}

const DISPLAY_MODE_OPTIONS: ReadonlyArray<{ mode: DisplayMode; label: string }> = [
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
  { mode: "system", label: "System" },
];

export function SettingsPopover({
  authenticated,
  organizationName,
  telemetryOptIn,
  productAnalyticsOptIn,
  consentSource,
  consentEnvReason,
  onToggleTelemetry,
  onToggleProductAnalytics,
  rollingSummary,
  onToggleRollingSummary,
  onStartAuth,
  onDisconnect,
}: SettingsPopoverProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  // Read from lib/theme rather than a prop: the rail header's toggle sets the
  // same value, and this control has to show that too. Persisting for the next
  // launch is wired up once, in App.
  const [displayMode, setLocalDisplayMode] = useState(getDisplayMode());
  useEffect(() => subscribeDisplayMode(setLocalDisplayMode), []);
  const [authProgress, setAuthProgress] = useState<AuthProgress>({ status: "idle" });
  // An env override outranks any stored preference; flipping the toggle here
  // would silently lose to it on the next boot, so the control locks instead.
  const envForced = consentSource === "env-forced-off";
  const effectiveOptIn = envForced ? false : telemetryOptIn;
  // The env kill-switch turns off ALL telemetry, product analytics included.
  const effectiveProductAnalytics = envForced ? false : productAnalyticsOptIn;

  const handleToggle = async (): Promise<void> => {
    const next = !telemetryOptIn;
    setBusy(true);
    try {
      await onToggleTelemetry(next);
      track("consent.changed", { optIn: next });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleProductAnalytics = async (): Promise<void> => {
    const next = !productAnalyticsOptIn;
    setBusy(true);
    try {
      await onToggleProductAnalytics(next);
      track("consent.changed", { productAnalytics: next });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleRollingSummary = async (): Promise<void> => {
    setBusy(true);
    try {
      await onToggleRollingSummary(!rollingSummary);
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (): Promise<void> => {
    setAuthProgress({ status: "pending" });
    try {
      await onStartAuth();
      // The server returns immediately with { started: true }; the actual
      // sign-in completes asynchronously. The auth.changed bus message will
      // update AppState.authenticated — no need to reset authProgress to idle
      // here; the component will re-render with authenticated=true on arrival.
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not start sign-in. Try again.";
      setAuthProgress({ status: "error", message });
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      await onDisconnect();
    } finally {
      setBusy(false);
    }
  };

  // When auth.changed arrives and authenticated flips to true, reset the
  // in-progress state so the component shows the signed-in identity.
  if (authenticated && authProgress.status === "pending") {
    setAuthProgress({ status: "idle" });
  }

  // No positioned wrapper of its own: the host mounts this inside an
  // AnchoredPopover carrying the .settings-popover recipe and testid.
  return (
    <>
      <div className="settings-identity">
        {authenticated ? (organizationName ?? "Signed in") : "Not signed in"}
      </div>

      {!authenticated && (
        <div className="settings-auth-row">
          {authProgress.status === "pending" ? (
            <span
              className="settings-auth-pending"
              data-testid="settings-auth-pending"
            >
              <Icon name="Loader" size={13} />
              Opening browser&hellip; waiting for sign-in
            </span>
          ) : (
            <>
              <button
                type="button"
                className="btn-primary settings-connect-btn"
                data-testid="settings-connect-btn"
                onClick={() => void handleConnect()}
              >
                Connect account
              </button>
              {authProgress.status === "error" && (
                <p
                  className="settings-note settings-auth-error"
                  data-testid="settings-auth-error"
                >
                  {authProgress.message}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {authenticated && (
        <div className="settings-auth-row">
          <button
            type="button"
            className="settings-disconnect-btn"
            data-testid="settings-disconnect-btn"
            disabled={busy}
            onClick={() => void handleDisconnect()}
          >
            <Icon name="LogOut" size={13} />
            {busy ? "Signing out…" : "Disconnect"}
          </button>
        </div>
      )}

      <div className="settings-choice-row" data-testid="display-mode-row">
        <span id="display-mode-label">Display mode</span>
        <div className="settings-segmented" role="radiogroup" aria-labelledby="display-mode-label">
          {DISPLAY_MODE_OPTIONS.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={displayMode === mode}
              data-testid={`display-mode-${mode}`}
              className={"settings-segment" + (displayMode === mode ? " is-on" : "")}
              onClick={() => setDisplayMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <label className="settings-toggle-row">
        <span>Share session details with Sapiom</span>
        <button
          type="button"
          role="switch"
          aria-checked={effectiveOptIn}
          data-testid="telemetry-toggle"
          className={"toggle-switch" + (effectiveOptIn ? " is-on" : "")}
          disabled={busy || envForced}
          onClick={() => void handleToggle()}
        >
          <span className="toggle-knob" />
        </button>
      </label>

      <p className="settings-note">
        Help us optimize your experience: with this on, your prompts, tool calls, and session
        lifecycle events are shared with Sapiom so we can see where Agent Studio gets in your way.
        Off by default. Always written locally to <code>{HARNESS_PATHS.events}</code> either way.
      </p>

      <label className="settings-toggle-row">
        <span>Product analytics (clicks &amp; usage)</span>
        <button
          type="button"
          role="switch"
          aria-checked={effectiveProductAnalytics}
          data-testid="product-analytics-toggle"
          className={"toggle-switch" + (effectiveProductAnalytics ? " is-on" : "")}
          disabled={busy || envForced}
          onClick={() => void handleToggleProductAnalytics()}
        >
          <span className="toggle-knob" />
        </button>
      </label>

      <p className="settings-note">
        Anonymous-by-default usage: which buttons and screens you use, and how you move through the
        Agent Studio. No prompt text, no file contents, and never a screen recording. On by default; turn
        it off here anytime.
      </p>

      {envForced && (
        <p className="settings-note settings-env-note" data-testid="telemetry-env-note">
          All telemetry is turned off by {consentEnvReason ? `$${consentEnvReason}` : "an environment variable"}. Unset
          it and restart the Agent Studio server to manage consent here.
        </p>
      )}

      <label className="settings-toggle-row">
        <span>Summarize sessions in the background</span>
        <button
          type="button"
          role="switch"
          aria-checked={rollingSummary}
          data-testid="rolling-summary-toggle"
          className={"toggle-switch" + (rollingSummary ? " is-on" : "")}
          disabled={busy}
          onClick={() => void handleToggleRollingSummary()}
        >
          <span className="toggle-knob" />
        </button>
      </label>

      <p className="settings-note">
        Off by default, because it uses tokens you didn&rsquo;t ask to use: every 10 turns, and
        once at the end, a cheap one-shot coding-agent pass folds the session into a short summary.
        Continuing a session the coding agent can no longer reattach to then explains what the work
        was{" "}
        <em>for</em>, not just what it last did. With this off, continuing still works — it
        carries the last few turns instead.
      </p>
    </>
  );
}
