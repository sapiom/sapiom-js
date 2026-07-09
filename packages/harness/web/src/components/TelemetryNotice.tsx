/**
 * TelemetryNotice — non-blocking first-run notice shown when consent was
 * determined silently in a non-TTY environment (consentSource === "default-silent").
 *
 * Rendered once; dismissed permanently via PATCH /api/settings
 * (telemetryNoticeDismissed: true).  If the user answered the CLI prompt
 * (consentSource === "prompted") or telemetry was forced off by the environment
 * (consentSource === "env-forced-off"), this notice is never shown.
 *
 * Points the user at the tracking indicator chip in the top bar and the
 * settings toggle to change the preference.
 */
import type { JSX } from "react";

interface TelemetryNoticeProps {
  /** Called when the user dismisses the notice. */
  onDismiss: () => void;
  /** Called when the user clicks "Settings" — should open the settings popover. */
  onOpenSettings: () => void;
}

export function TelemetryNotice({ onDismiss, onOpenSettings }: TelemetryNoticeProps): JSX.Element {
  return (
    <div className="telemetry-notice" role="status" data-testid="telemetry-notice">
      <div className="telemetry-notice-body">
        <p className="telemetry-notice-text">
          Analytics are <strong>on by default</strong> — usage events (including prompts and tool calls)
          are collected locally and sent to Sapiom to help improve the product. Change this any time in{" "}
          <button
            className="telemetry-notice-settings-link"
            onClick={() => {
              onOpenSettings();
              onDismiss();
            }}
          >
            Settings
          </button>
          , or use the indicator in the top bar.
        </p>
      </div>
      <button
        className="telemetry-notice-dismiss"
        aria-label="Dismiss analytics notice"
        data-testid="telemetry-notice-dismiss"
        onClick={onDismiss}
      >
        &times;
      </button>
    </div>
  );
}
