import { useState } from "react";
import type { JSX } from "react";
import { HARNESS_PATHS } from "@shared/types";

import { track } from "../lib/track";

interface SettingsPopoverProps {
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  onClose: () => void;
}

export function SettingsPopover({
  authenticated,
  organizationName,
  telemetryOptIn,
  onToggleTelemetry,
  onClose,
}: SettingsPopoverProps): JSX.Element {
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="settings-popover" data-testid="settings-popover">
      <div className="settings-identity">{authenticated ? (organizationName ?? "Signed in") : "Not signed in"}</div>

      <label className="settings-toggle-row">
        <span>Send usage analytics to Sapiom</span>
        <button
          type="button"
          role="switch"
          aria-checked={telemetryOptIn}
          data-testid="telemetry-toggle"
          className={"toggle-switch" + (telemetryOptIn ? " is-on" : "")}
          disabled={busy}
          onClick={() => void handleToggle()}
        >
          <span className="toggle-knob" />
        </button>
      </label>

      <p className="settings-note">
        Prompts, tool calls, and session lifecycle events are always written locally to{" "}
        <code>{HARNESS_PATHS.events}</code>. With your consent, they&rsquo;re also sent to Sapiom.
      </p>

      <button className="btn-ghost settings-close" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
