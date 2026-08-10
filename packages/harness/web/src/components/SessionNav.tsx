import type { JSX } from "react";

import { Icon } from "./Icon";

/**
 * Back/forward through the places you have been — a session, an agent, a past
 * session, the composer home, the template catalog. It is browser-shaped on
 * purpose: one pair of arrows that works from any screen, so leaving a view is
 * never a one-way door. Right-anchored on the rail's chrome line, opposite the
 * window controls.
 */
export function SessionNav({
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}): JSX.Element {
  return (
    <div className="session-nav" data-testid="session-nav" role="group" aria-label="Go back or forward">
      <button
        type="button"
        className="theme-toggle session-nav-btn"
        data-testid="session-nav-back"
        disabled={!canGoBack}
        aria-label="Go back"
        data-tooltip="Go back"
        onClick={onGoBack}
      >
        <Icon name="ArrowLeft" size={14} />
      </button>
      <button
        type="button"
        className="theme-toggle session-nav-btn"
        data-testid="session-nav-forward"
        disabled={!canGoForward}
        aria-label="Go forward"
        data-tooltip="Go forward"
        onClick={onGoForward}
      >
        <Icon name="ArrowRight" size={14} />
      </button>
    </div>
  );
}
