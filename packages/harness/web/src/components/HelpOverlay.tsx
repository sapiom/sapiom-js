import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { isMockMode } from "../lib/api";
import { Icon } from "./Icon";

/**
 * The one-time explainer: what a Project is, what an Agent is, and what
 * happened to the rows an upgrading user had.
 *
 * It exists because the taxonomy the rail was rebuilt around lived only in
 * commit messages. On screen, "project" and "agent" were two kinds of row that
 * looked alike and behaved differently, and nothing anywhere said which was
 * which — so the rules had to be inferred from what clicking did.
 *
 * A CARD ON TOP, wearing `OverviewModal`'s own recipe (`.overview-modal*`)
 * rather than a second modal system: the two are the same object — a card
 * summoned over the shell that explains the app — and they sit next to each
 * other in the account menu, so a card that composed differently would read as
 * a different kind of thing.
 */

/**
 * Its own key, deliberately NOT a field in `ui-prefs`.
 *
 * `ui-prefs` is the UI's ARRANGEMENT — which rows are folded, how the rail is
 * filed, how wide the panes are — and it is a blob a user may reasonably want
 * to reset. "I have already been told what a project is" is not an arrangement
 * and must not come back when the arrangement does.
 */
const SEEN_KEY = "sapiom-harness-help-seen";

/**
 * `openHelpOverlay()` reaches the mounted overlay through a window event rather
 * than a prop.
 *
 * The account menu that re-opens it lives inside `WorkflowsRail`, and the card
 * mounts at the app root beside `OverviewModal` (a scrim inside the rail would
 * be a scrim inside a scrolling column). Threading `onSelectHelp` between them
 * would mean a prop, a handler and a piece of state in `App.tsx` for a card
 * that has exactly one input: "show yourself".
 */
const OPEN_EVENT = "sapiom:open-help";

export function openHelpOverlay(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

function hasSeenHelp(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode / blocked storage: showing the card is the safe failure.
    // The cost of the wrong answer here is one dismissal, not a broken shell.
    return false;
  }
}

function markHelpSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Best-effort, exactly as `saveUiPrefs` is: the card is a courtesy and
    // never a gate.
  }
}

/**
 * Whether the card should raise itself on this load.
 *
 * Two conditions, and the second one is about the test suite rather than the
 * product. Under `VITE_MOCK` every e2e spec starts with empty storage, so an
 * unconditional first-run card would open a full-screen scrim over ~40 specs
 * that have nothing to do with it — the fixture would be testing this card
 * instead of what it came for. `?help=1` opts a mock page back into the real
 * behaviour, which is how the auto-show is proven in `help-overlay.spec.ts`;
 * it does NOT force the card open, so "dismiss, reload, still gone" is the
 * same code path there as in a real install.
 */
function shouldAutoOpen(): boolean {
  if (hasSeenHelp()) return false;
  if (!isMockMode()) return true;
  return new URLSearchParams(window.location.search).get("help") === "1";
}

export function HelpOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(shouldAutoOpen);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    // FOCUS THE CARD, not the button inside it. A screen reader has to land on
    // the dialog rather than on the scrim behind it, but focusing "Got it"
    // put a 2px focus ring on the way OUT of a card the reader has not read
    // yet — the loudest thing on a first-run screen, pointing at the exit.
    cardRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // SEEN IS RECORDED ON DISMISS, not on show. A card the user never got to —
  // the window was closed, the app crashed, they walked away — has not taught
  // anything, and "shown once" means once it has been read past.
  function dismiss(): void {
    markHelpSeen();
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      className="overview-modal help-overlay"
      data-testid="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="How Studio is organised"
      onClick={(e) => {
        // Click-out: only presses on the scrim itself, never inside the card.
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="overview-modal-card help-overlay-card" ref={cardRef} tabIndex={-1}>
        <button
          type="button"
          className="theme-toggle overview-modal-close"
          data-testid="help-overlay-close"
          aria-label="Close"
          data-tooltip="Close"
          onClick={dismiss}
        >
          <Icon name="X" size={14} />
        </button>

        <div className="overview-modal-body">
          <h1 className="overview-modal-title">How Studio is organised</h1>
          <p className="overview-modal-intro">
            Two kinds of row in the rail, and the difference decides what a
            click does.
          </p>

          {/* ONE ANATOMY PER NOUN. The two rows are deliberately identical in
              shape and different only in content: the pair IS the lesson, and
              stating each in its own paragraph inside one block would let the
              reader carry away only the first. */}
          <div className="overview-modal-path" data-testid="help-projects">
            <span className="overview-modal-path-icon" aria-hidden="true">
              <Icon name="Folder" size={20} />
            </span>
            <span className="overview-modal-path-copy">
              <span className="overview-modal-path-title">Projects</span>
              <span className="overview-modal-path-desc">
                Folders you chose that hold agents. Selecting a project shows
                its map and its conversation.
              </span>
            </span>
          </div>

          <div className="overview-modal-path" data-testid="help-agents">
            <span className="overview-modal-path-icon" aria-hidden="true">
              <Icon name="Play" size={20} />
            </span>
            <span className="overview-modal-path-copy">
              <span className="overview-modal-path-title">Agents</span>
              <span className="overview-modal-path-desc">
                What you run. Selecting an agent shows that agent.
              </span>
            </span>
          </div>

          {/* THE UPGRADE LINE. Desktop 0.4.0 is the first stable build with
              the rebuilt rail, and its own changelog says rows may disappear on
              upgrade. An existing user therefore opens this build to a rail
              that has been rearranged by something they did not do — and the
              worst reading of that, "it deleted my work", is the one they will
              reach on their own if nothing here says otherwise. */}
          <p className="help-overlay-note" data-testid="help-upgrade-note">
            <span className="help-overlay-note-icon" aria-hidden="true">
              <Icon name="Info" size={14} />
            </span>
            <span>
              Your projects were rebuilt from the folders you opened. Nothing
              was deleted — use <strong>Add a project</strong> to bring a folder
              back.
            </span>
          </p>

          <div className="help-overlay-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid="help-overlay-dismiss"
              onClick={dismiss}
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
