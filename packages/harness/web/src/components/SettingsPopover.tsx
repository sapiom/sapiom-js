import { useState } from "react";
import type { JSX } from "react";
import type { AppState } from "@shared/types";
import { HARNESS_PATHS } from "@shared/types";

import { track } from "../lib/track";

interface SettingsPopoverProps {
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  /** How consent was determined - "env-forced-off" locks the toggle. */
  consentSource?: AppState["consentSource"];
  /** Which env var forced telemetry off, when consentSource is "env-forced-off". */
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
}

export function SettingsPopover({
  authenticated,
  organizationName,
  telemetryOptIn,
  consentSource,
  consentEnvReason,
  onToggleTelemetry,
}: SettingsPopoverProps): JSX.Element {
  const [busy, setBusy] = useState(false);
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

  // No positioned wrapper of its own: the host mounts this inside an
  // AnchoredPopover carrying the .settings-popover recipe and testid.
  return (
    <>
      <div className="settings-identity">{authenticated ? (organizationName ?? "Signed in") : "Not signed in"}</div>

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
