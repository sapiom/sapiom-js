import { useState } from "react";
import type { JSX } from "react";
import type { AppState } from "@shared/types";
import { HARNESS_PATHS } from "@shared/types";

import type { AuthStartResponse } from "../lib/api";
import { Icon } from "./Icon";
import { track } from "../lib/track";
import {
  describeUpdateOutcome,
  getDesktopBridge,
  type UpdateStatusView,
} from "../lib/desktop";

/** Sign-in progress state in the Settings popover. */
type AuthProgress =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string };

interface SettingsPopoverProps {
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  /** How consent was determined - "env-forced-off" locks the toggle. */
  consentSource?: AppState["consentSource"];
  /** Which env var forced telemetry off, when consentSource is "env-forced-off". */
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  /** `HarnessSettings.rollingSummary` — see the toggle's own note below. */
  rollingSummary: boolean;
  onToggleRollingSummary: (next: boolean) => Promise<void>;
  /** Kick off the browser OAuth flow — see HarnessApi.startAuth(). */
  onStartAuth: () => Promise<AuthStartResponse>;
  /** Sign out and clear credentials — see HarnessApi.disconnect(). */
  onDisconnect: () => Promise<void>;
}

export function SettingsPopover({
  authenticated,
  organizationName,
  telemetryOptIn,
  consentSource,
  consentEnvReason,
  onToggleTelemetry,
  rollingSummary,
  onToggleRollingSummary,
  onStartAuth,
  onDisconnect,
}: SettingsPopoverProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [authProgress, setAuthProgress] = useState<AuthProgress>({ status: "idle" });
  // Null in a browser (`npx @sapiom/harness`), where there is nothing to update —
  // the whole update section is then absent rather than disabled. Read once per
  // render; the preload either injected it before first paint or never will.
  const desktop = getDesktopBridge();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusView | null>(null);
  const [restarting, setRestarting] = useState(false);
  // An env override outranks any stored preference; flipping the toggle here
  // would silently lose to it on the next boot, so the control locks instead.
  const envForced = consentSource === "env-forced-off";
  const effectiveOptIn = envForced ? false : telemetryOptIn;

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

  const handleCheckForUpdates = async (): Promise<void> => {
    if (!desktop) return;
    setUpdateChecking(true);
    // Clear the previous result first: leaving "Up to date" on screen while a new
    // check runs makes the button look like it did nothing.
    setUpdateStatus(null);
    try {
      setUpdateStatus(describeUpdateOutcome(await desktop.checkForUpdates()));
    } catch (err) {
      // The bridge is documented as never rejecting, but it crosses a process
      // boundary — if that contract ever breaks, the user gets a message rather
      // than a spinner that never stops.
      setUpdateStatus({
        text: err instanceof Error ? err.message : "The update check failed.",
        tone: "error",
      });
    } finally {
      setUpdateChecking(false);
    }
  };

  const handleRestartToUpdate = async (): Promise<void> => {
    if (!desktop || restarting) return;
    // Latched, and never released on success: the app is about to be replaced, so
    // the button must not come back and invite a second install. A double-click
    // would otherwise call quitAndInstall twice.
    setRestarting(true);
    try {
      await desktop.restartToUpdate();
    } catch (err) {
      // Reaching here means the install did not happen — the app would be gone
      // otherwise. Re-arm the button and say so.
      setRestarting(false);
      setUpdateStatus({
        text: err instanceof Error ? err.message : "The update could not be installed.",
        tone: "error",
      });
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

      {/* Desktop app only. In a browser there is no bundle to replace, so the
          whole section is absent rather than present-and-disabled — a control that
          can never work is worse than no control. */}
      {desktop && (
        <div className="settings-auth-row" data-testid="settings-update-row">
          <button
            type="button"
            className="settings-update-btn"
            data-testid="settings-update-btn"
            disabled={updateChecking}
            onClick={() => void handleCheckForUpdates()}
          >
            <Icon name={updateChecking ? "Loader" : "RefreshCw"} size={13} />
            {updateChecking ? "Checking…" : "Check for updates"}
          </button>
          {updateStatus && (
            <p
              className="settings-note settings-update-status"
              data-testid="settings-update-status"
              // Announced, because the outcome is the entire point of pressing
              // the button and it appears without any focus change.
              role="status"
            >
              {updateStatus.text}
            </p>
          )}
          {updateStatus?.tone === "action" && (
            <button
              type="button"
              className="settings-update-restart-btn"
              data-testid="settings-update-restart-btn"
              disabled={restarting}
              onClick={() => void handleRestartToUpdate()}
              // Same warning the native prompt gives. The user may have an agent
              // mid-task, and this button ends it — so it says so before the click,
              // not after.
              title="Ends any running agent sessions"
            >
              <Icon name={restarting ? "Loader" : "RefreshCw"} size={13} />
              {restarting ? "Installing…" : "Restart now — ends running sessions"}
            </button>
          )}
          {desktop.appVersion && (
            <p className="settings-note settings-update-version" data-testid="settings-app-version">
              Sapiom {desktop.appVersion}
            </p>
          )}
        </div>
      )}

      <label className="settings-toggle-row">
        <span>Send usage analytics to Sapiom</span>
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

      {envForced && (
        <p className="settings-note settings-env-note" data-testid="telemetry-env-note">
          Analytics is turned off by {consentEnvReason ? `$${consentEnvReason}` : "an environment variable"}. Unset it
          and restart the Studio server to manage consent here.
        </p>
      )}

      <p className="settings-note">
        Prompts, tool calls, and session lifecycle events are always written locally to{" "}
        <code>{HARNESS_PATHS.events}</code>. With your consent, they&rsquo;re also sent to Sapiom.
      </p>

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
        once at the end, a cheap one-shot agent run folds the session into a short summary.
        Continuing a session the agent can no longer reattach to then explains what the work was{" "}
        <em>for</em>, not just what it last did. With this off, continuing still works — it
        carries the last few turns instead.
      </p>
    </>
  );
}
