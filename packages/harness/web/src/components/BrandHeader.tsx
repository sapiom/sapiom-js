import type { JSX, RefObject } from "react";

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
 * the tools on the right anchor: the history glyph, then back/forward. The
 * rail toggle carries a resting surface (.rail-toggle): full-screen macOS hides
 * the lights, and a bare glyph sitting alone in their reserved clearance reads
 * as a gap rather than a control. Theme lives in the account menu with the
 * rest of the workspace preferences.
 *
 * THE HISTORY GLYPH (flow-creation.md §4.7, Q9). Past sessions used to sit in
 * the Projects options menu beside Group by and Sort by: a settings card that
 * also held an unbounded list. It is a glyph in this header now, and it opens
 * the existing Past sessions side card beside the rail. Search (⌘K) keeps
 * listing past sessions too.
 */
export function BrandHeader({
  onCollapse,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  historyOpen,
  onToggleHistory,
  historyTriggerRef,
}: {
  onCollapse: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** Whether the Past sessions side card is open; drives `aria-expanded`. */
  historyOpen: boolean;
  onToggleHistory: () => void;
  /** The glyph, for the side card to anchor to and return focus to. */
  historyTriggerRef: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  return (
    <header className="brand-header">
      {/* Left of the chrome line. In the frameless host the OS lights are
          inset ahead of this group, so collapse reads as the next window
          control rather than a stray tool at the far edge. */}
      <div className="brand-header-window">
        <button
          className="theme-toggle rail-toggle"
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

      {/* The right anchor of the chrome line: history, then back/forward. One
          cluster, so the frameless-mac grid places it as one thing. */}
      <div className="brand-header-tools">
        <button
          ref={historyTriggerRef}
          type="button"
          className="theme-toggle brand-header-history"
          data-testid="rail-history"
          aria-label="Past sessions"
          aria-haspopup="menu"
          aria-expanded={historyOpen}
          data-tooltip="Past sessions"
          onClick={onToggleHistory}
        >
          <Icon name="History" size={14} />
        </button>
        <SessionNav
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
        />
      </div>
    </header>
  );
}
