import { useEffect, useRef } from "react";
import type { JSX } from "react";

import { SAPIOM_QUICKSTART_URL } from "../lib/urls";
import { Icon } from "./Icon";

interface OverviewModalProps {
  /** Genuine first run: the greeting welcomes, otherwise it just names the app. */
  firstRun: boolean;
  /** The running build, shown under the title. Never empty in practice: the
   *  desktop bridge reports the app build, the browser host the bundled
   *  harness version. */
  appVersion: string | null;
  /**
   * Open a folder as a project: the folder step (flow-creation.md §4.5), the
   * OS picker on desktop and the one-field dialog on the web. The card closes
   * first so the step is never asked from behind a scrim.
   */
  onAddProject: () => void;
  /** Leaves the card and opens the template catalog. */
  onBrowseTemplates: () => void;
  /** Click-out, Esc, or the close glyph: the card is never a trap. */
  onDismiss: () => void;
}

/**
 * The Overview card, summoned from Overview in the account menu.
 *
 * It is a CARD ON TOP, not a destination: the shell behind it keeps whatever
 * was on screen, so re-reading what Studio is never costs you your place. One
 * title, the running version, three sentences, two full-width paths (open a
 * folder / browse templates) and a documentation line.
 */
export function OverviewModal({
  firstRun,
  appVersion,
  onAddProject,
  onBrowseTemplates,
  onDismiss,
}: OverviewModalProps): JSX.Element {
  // Esc dismisses the card. Claimed for the card before the shell's pane
  // shortcut sees it.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      dismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className="overview-modal"
      data-testid="overview-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sapiom agent.studio overview"
      onClick={(e) => {
        // Click-out: only presses on the scrim itself, never inside the card.
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="overview-modal-card">
        <button
          type="button"
          className="theme-toggle overview-modal-close"
          data-testid="overview-exit"
          aria-label="Close"
          data-tooltip="Close"
          onClick={onDismiss}
        >
          <Icon name="X" size={14} />
        </button>

        <div className="overview-modal-body">
          <h1 className="overview-modal-title">
            {firstRun ? "Welcome to Sapiom agent.studio" : "Sapiom agent.studio"}
          </h1>
          {appVersion && (
            <p className="overview-modal-version" data-testid="overview-version">
              v{appVersion}
            </p>
          )}
          {/* Three beats, in the order the product earns trust: what it makes
              of your code, what a run costs and shows, who decides to ship.
              The mechanics belong to the cards below. */}
          <p className="overview-modal-intro">
            Studio turns the agents in your codebase into diagrams you can inspect and
            run. Local agent runs are free and offline, with every step&apos;s input, output
            and capability call on screen. Nothing ships until you say so.
          </p>

          <div className="overview-modal-path" data-testid="overview-open-card">
            <span className="overview-modal-path-icon" aria-hidden="true">
              <Icon name="FolderOpen" size={20} />
            </span>
            <span className="overview-modal-path-copy">
              <span className="overview-modal-path-title">Open a folder</span>
              <span className="overview-modal-path-desc">
                Agents in the folder appear in the rail. Nothing is uploaded.
              </span>
            </span>
            <button
              type="button"
              className="btn-primary overview-modal-cta"
              data-testid="overview-open-folder"
              onClick={() => {
                onDismiss();
                onAddProject();
              }}
            >
              Open folder
            </button>
          </div>

          <div className="overview-modal-path" data-testid="overview-templates-card">
            <span className="overview-modal-path-icon" aria-hidden="true">
              <Icon name="LayoutTemplate" size={20} />
            </span>
            <span className="overview-modal-path-copy">
              <span className="overview-modal-path-title">Start from a template</span>
              <span className="overview-modal-path-desc">
                Runnable starters, cloned locally and free to test.
              </span>
            </span>
            <button
              type="button"
              className="btn-line overview-modal-cta"
              data-testid="overview-browse-templates"
              onClick={onBrowseTemplates}
            >
              Browse templates
            </button>
          </div>

          <a
            className="overview-modal-docs"
            data-testid="overview-docs"
            href={SAPIOM_QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Read documentation <Icon name="ArrowUpRight" size={12} />
          </a>
        </div>
      </div>
    </div>
  );
}
