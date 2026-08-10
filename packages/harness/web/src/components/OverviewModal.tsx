import { useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";

import type { FsListResponse } from "../lib/api";
import { SAPIOM_QUICKSTART_URL } from "../lib/urls";
import { Icon } from "./Icon";
import { StartDialog } from "./StartDialog";

interface OverviewModalProps {
  /** Genuine first run: the greeting welcomes, otherwise it just names the app. */
  firstRun: boolean;
  /** The running build, shown under the title. Never empty in practice: the
   *  desktop bridge reports the app build, the browser host the bundled
   *  harness version. */
  appVersion: string | null;
  recentDirs: string[];
  projectRoot: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  /** Register an existing agent project (the picker's `project` outcome). */
  onConnect: (cwd: string) => Promise<void>;
  /** Bulk-register every project under a root (its `multi` outcome). */
  onScan: (root: string) => Promise<number>;
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
  recentDirs,
  projectRoot,
  listDir,
  onConnect,
  onScan,
  onBrowseTemplates,
  onDismiss,
}: OverviewModalProps): JSX.Element {
  const [addOpen, setAddOpen] = useState(false);
  const openFolderRef = useRef<HTMLButtonElement>(null);

  // Esc dismisses the card, but only while the nested picker is closed, so a
  // single press closes the picker first (its own handler) rather than both
  // layers at once.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (addOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismissRef.current();
    };
    // Attached a tick late: the Esc that closes the nested picker flushes
    // state mid-dispatch, so listening immediately would catch the SAME
    // keydown at window and close both layers on one press.
    const id = window.setTimeout(() => window.addEventListener("keydown", onKey), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

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
              ref={openFolderRef}
              type="button"
              className="btn-primary overview-modal-cta"
              data-testid="overview-open-folder"
              onClick={() => setAddOpen(true)}
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

      {addOpen && (
        <StartDialog
          recentDirs={recentDirs}
          projectRoot={projectRoot}
          listDir={listDir}
          onClose={() => setAddOpen(false)}
          onConnect={onConnect}
          onScan={onScan}
          triggerRef={openFolderRef as RefObject<HTMLElement | null>}
        />
      )}
    </div>
  );
}
