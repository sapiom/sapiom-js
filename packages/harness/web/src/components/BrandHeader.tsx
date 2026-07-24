import { useEffect, useState } from "react";
import type { JSX } from "react";

import sapiomMark from "../assets/sapiom-mark.svg";
import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";
import { Icon } from "./Icon";

/**
 * Brand header row at the top of the workspace rail — the product lockup on
 * the left; theme toggle and the rail collapse control on the right. Shares
 * --pane-header-h with the session bar and right-pane tabs so all three
 * read as one continuous header line across the app. Workspace status
 * (telemetry chip, identity) lives in the rail footer.
 */
export function BrandHeader({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => subscribeTheme(setTheme), []);

  return (
    <header className="brand-header">
      <div className="brand-lockup">
        <img src={sapiomMark} alt="" className="brand-mark" />
        <span className="brand-name">Sapiom</span>
        <span className="brand-divider" />
        <span className="brand-product">Studio</span>
      </div>

      <div className="brand-header-tools">
        <button
          className="theme-toggle"
          data-testid="theme-toggle"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
        >
          <Icon name={theme === "dark" ? "Sun" : "Moon"} size={15} />
        </button>
        <button
          className="theme-toggle"
          data-testid="rail-collapse"
          aria-label="Collapse workspace panel"
          title="Collapse workspace panel"
          onClick={onCollapse}
        >
          <Icon name="PanelLeftClose" size={15} />
        </button>
      </div>
    </header>
  );
}
