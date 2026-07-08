import { useEffect, useState } from "react";
import type { JSX } from "react";

import sapiomMark from "../assets/sapiom-mark.svg";
import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";
import { Icon } from "./Icon";

interface BrandHeaderProps {
  authenticated: boolean;
  organizationName: string | null;
  onOpenPalette: () => void;
}

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = IS_MAC ? "⌘K" : "Ctrl+K";

export function BrandHeader({ authenticated, organizationName, onOpenPalette }: BrandHeaderProps): JSX.Element {
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => subscribeTheme(setTheme), []);

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
