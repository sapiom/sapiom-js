import { useState } from "react";
import type { JSX } from "react";
import type { AppState } from "@shared/types";
import { HARNESS_PATHS } from "@shared/types";

import type { AuthStartResponse } from "../lib/api";
import { Icon } from "./Icon";
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
  /** How consent was determined - "env-forced-off" locks the toggle. */
  consentSource?: AppState["consentSource"];
  /** Which env var forced telemetry off, when consentSource is "env-forced-off". */
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
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
  onStartAuth,
  onDisconnect,
}: SettingsPopoverProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [authProgress, setAuthProgress] = useState<AuthProgress>({ status: "idle" });
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
    </>
  );
}
