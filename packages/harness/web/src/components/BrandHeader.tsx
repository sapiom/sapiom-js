import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { AppState } from "@shared/types";

import sapiomMark from "../assets/sapiom-mark.svg";
import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";
import { Icon } from "./Icon";

type ConsentSource = AppState["consentSource"];

interface BrandHeaderProps {
  authenticated: boolean;
  organizationName: string | null;
  onOpenPalette: () => void;
  /** Current telemetry opt-in state — drives the tracking indicator chip. */
  telemetryOptIn: boolean;
  /** How consent was determined — drives chip label and tooltip. */
  consentSource?: ConsentSource;
  /** Which env var forced telemetry off, when consentSource === "env-forced-off". */
  consentEnvReason?: string | null;
  /** Called when the tracking chip is clicked — should open the settings popover. */
  onOpenSettings: () => void;
}

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = IS_MAC ? "⌘K" : "Ctrl+K";

function chipLabel(telemetryOptIn: boolean, consentSource: ConsentSource): string {
  if (consentSource === "env-forced-off") return "analytics off (env)";
  return telemetryOptIn ? "analytics on" : "analytics off";
}

function chipTooltip(telemetryOptIn: boolean, consentSource: ConsentSource, envReason: string | null | undefined): string {
  if (consentSource === "env-forced-off") {
    const reason = envReason ? `$${envReason}` : "environment variable";
    return `Remote analytics disabled by ${reason}. Click to open settings.`;
  }
  if (telemetryOptIn) return "Remote analytics enabled. Click to open settings.";
  return "Remote analytics disabled. Click to open settings.";
}

function chipState(telemetryOptIn: boolean, consentSource: ConsentSource): "on" | "off" | "env" {
  if (consentSource === "env-forced-off") return "env";
  return telemetryOptIn ? "on" : "off";
}

export function BrandHeader({
  authenticated,
  organizationName,
  onOpenPalette,
  telemetryOptIn,
  consentSource,
  consentEnvReason,
  onOpenSettings,
}: BrandHeaderProps): JSX.Element {
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => subscribeTheme(setTheme), []);

  const state = chipState(telemetryOptIn, consentSource);
  const label = chipLabel(telemetryOptIn, consentSource);
  const tooltip = chipTooltip(telemetryOptIn, consentSource, consentEnvReason);

  return (
    <header className="brand-header">
      <div className="brand-lockup">
        <img src={sapiomMark} alt="" className="brand-mark" />
        <span className="brand-name">Sapiom</span>
        <span className="brand-divider" />
        <span className="brand-product">Harness</span>
      </div>

      <div className="brand-header-right">
        <button
          className="palette-trigger"
          data-testid="palette-trigger"
          aria-label="Jump to session, workflow, or path"
          onClick={onOpenPalette}
        >
          <Icon name="Search" size={13} />
          Jump
          <span className="palette-trigger-hint">{SHORTCUT_HINT}</span>
        </button>

        <button
          className="telemetry-chip"
          data-testid="telemetry-chip"
          data-state={state}
          aria-label={tooltip}
          title={tooltip}
          onClick={onOpenSettings}
        >
          <span className="telemetry-chip-dot" aria-hidden="true" />
          <span className="telemetry-chip-label">{label}</span>
        </button>

        <button
          className="theme-toggle"
          data-testid="theme-toggle"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
        >
          <Icon name={theme === "dark" ? "Sun" : "Moon"} size={15} />
        </button>

        <div className="brand-identity" data-testid="brand-identity">
          <span className="identity-dot" data-authenticated={authenticated} />
          {authenticated ? (organizationName ?? "Signed in") : "Not signed in"}
        </div>
      </div>
    </header>
  );
}
