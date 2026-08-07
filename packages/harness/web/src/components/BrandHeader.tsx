import { useEffect, useState } from "react";
import type { JSX } from "react";

import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";
import { BrandLogotype } from "./BrandLogotype";
import { Icon } from "./Icon";

/**
 * Brand header row at the top of the workspace rail: the Sapiom wordmark plus
 * the PRODUCT name, `agent.studio`. The wordmark already IS "Sapiom", so the S
 * mark is deliberately NOT placed beside it — mark + wordmark reads as a third
 * logo that does not exist in the brand system. The product name is lowercase
 * mono, matching the terminal masthead so the app is set in one voice wherever
 * it names itself. Shares --pane-header-h with the session bar and right-pane
 * tabs so all three read as one continuous header line across the app.
 * Workspace status (telemetry chip, identity) lives in the rail footer.
 */
export function BrandHeader({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => subscribeTheme(setTheme), []);

  return (
    <header className="brand-header">
      <h1 className="brand-lockup">
        {/* The wordmark IS "Sapiom"; the accessible name comes from the two
            parts together, so neither repeats the other. Mark + product read
            inline as "sapiom agent.studio" (the wrapper is `display:contents`),
            and the whole lockup drops below the traffic lights in the
            frameless-mac frame — only the window tools ride the lights' line. */}
        <span className="brand-mark">
          <BrandLogotype height={13} aria-hidden />
          <span className="visually-hidden">Sapiom </span>
        </span>
        <span className="brand-product">agent.studio</span>
      </h1>

      <div className="brand-header-tools">
        <button
          className="theme-toggle"
          data-testid="theme-toggle"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
        >
          <Icon name={theme === "dark" ? "Sun" : "Moon"} size={14} />
        </button>
        <button
          className="theme-toggle"
          data-testid="rail-collapse"
          aria-label="Collapse workspace panel"
          title="Collapse workspace panel"
          onClick={onCollapse}
        >
          <Icon name="PanelLeftClose" size={14} />
        </button>
      </div>
    </header>
  );
}
