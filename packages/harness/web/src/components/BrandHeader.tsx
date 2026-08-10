import type { JSX } from "react";

import { BrandLogotype } from "./BrandLogotype";
import { Icon } from "./Icon";
import { SessionNav } from "./SessionNav";

/**
 * Brand header row at the top of the workspace rail: the Sapiom wordmark plus
 * the PRODUCT name, `agent.studio`. The wordmark already IS "Sapiom", so the S
 * mark is deliberately NOT placed beside it — mark + wordmark reads as a third
 * logo that does not exist in the brand system. The product name is lowercase
 * mono, matching the terminal masthead so the app is set in one voice wherever
 * it names itself. Shares --pane-header-h with the session bar and right-pane
 * tabs so all three read as one continuous header line across the app.
 *
 * The chrome line carries window controls on the left — the OS traffic lights
 * in the frameless host, then the rail collapse immediately after them — and
 * back/forward on the right anchor. Theme lives in the account menu with the
 * rest of the workspace preferences.
 */
export function BrandHeader({
  onCollapse,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: {
  onCollapse: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}): JSX.Element {
  return (
    <header className="brand-header">
      {/* Left of the chrome line. In the frameless host the OS lights are
          inset ahead of this group, so collapse reads as the next window
          control rather than a stray tool at the far edge. */}
      <div className="brand-header-window">
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

      <h1 className="brand-lockup">
        {/* The wordmark IS "Sapiom"; the accessible name comes from the two
            parts together, so neither repeats the other. Mark + product read
            inline as "sapiom agent.studio" (the wrapper is `display:contents`),
            and the whole lockup drops below the chrome line in the
            frameless-mac frame — only the window tools ride the lights' line. */}
        <span className="brand-mark">
          <BrandLogotype height={13} aria-hidden />
          <span className="visually-hidden">Sapiom </span>
        </span>
        <span className="brand-product">agent.studio</span>
      </h1>

      <SessionNav
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
      />
    </header>
  );
}
