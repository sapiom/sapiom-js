import { useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessEntry, HarnessKind } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import type { StudioTemplate } from "../lib/templates";
import { Icon } from "./Icon";
import { NewSessionModal } from "./NewSessionModal";
import { TemplatesDialog } from "./TemplatesDialog";

/* Real screenshots of THIS app (the current Studio shell in mock mode),
 * regenerated via e2e/capture-welcome-hero.mjs into public/ — BASE_URL keeps
 * the path correct under the Pages base (/sapiom-studio/). */
const welcomeHeroDark = `${import.meta.env.BASE_URL}welcome-hero-dark.png`;
const welcomeHeroLight = `${import.meta.env.BASE_URL}welcome-hero-light.png`;

interface WelcomePanelProps {
  recentDirs: string[];
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  /** The existing new-session flow — "Start a new project" opens the same
   *  NewSessionModal the tab strip's "+" does, with the same handler. */
  onCreateSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Adapter registry fetch — keeps this modal's picker registry-driven too. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  /** Seeds the bundled example project and opens a session in it. On success
   *  the panel unmounts by itself (a live session now exists). */
  onRunSample: () => Promise<void>;
  /** Templates journey v0 (App.handleUseTemplate): starts a session in the
   *  destination folder and hands the agent the clone/scaffold prompt. */
  onUseTemplate: (dir: string, template: StudioTemplate) => Promise<void>;
}

/**
 * First-run welcome — rendered in the terminal slot instead of a bare
 * terminal when this install has never been used before (AppState.firstRun)
 * and no session is live yet. Returning users never see it; a first-run
 * user leaves it by taking either action, which creates a session.
 */
export function WelcomePanel({
  recentDirs,
  launchDir,
  listDir,
  onCreateSession,
  listHarnesses,
  onRunSample,
  onUseTemplate,
}: WelcomePanelProps): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startProjectRef = useRef<HTMLButtonElement>(null);
  const templatesTriggerRef = useRef<HTMLButtonElement>(null);

  const runSample = async (): Promise<void> => {
    setSampleBusy(true);
    setError(null);
    try {
      await onRunSample();
      // Success unmounts the whole panel — no state left to reset.
    } catch (err) {
      setError((err as Error).message);
      setSampleBusy(false);
    }
  };

  return (
    <div className="welcome-panel" data-testid="welcome-panel">
      <div className="welcome-card">
        {/* Product-as-hero: the app itself, cropped to its top band with a
            fade into the card — the pitch is the picture, not paragraphs.
            Each theme ships its own capture: CSS shows the matching
            one so the fade always lands on the card surface behind it,
            never a dark shot dissolving into a white card. Both are real
            screenshots; regenerate via e2e/capture-welcome-hero.mjs. */}
        <div className="welcome-hero" aria-hidden="true">
          <img className="welcome-hero-dark" src={welcomeHeroDark} alt="" />
          <img className="welcome-hero-light" src={welcomeHeroLight} alt="" />
        </div>

        <div className="welcome-copy">
          <h1 className="welcome-title">Sapiom Studio for full-stack agentic products.</h1>
          <p className="welcome-intro">
            Your coding agent in a Sapiom-configured workspace: build agent workflows, see them on the canvas, run and
            deploy them in one click.
          </p>
          {error && <div className="welcome-error">{error}</div>}

          <div className="welcome-hints" data-testid="welcome-hints">
            <div className="welcome-hint-chips">
              <span className="welcome-hint-chip">
                <Icon name="Sparkles" size={11} /> Visualize
              </span>
              <span className="welcome-hint-chip">
                <Icon name="Play" size={11} /> Run local
              </span>
              <span className="welcome-hint-chip">
                <Icon name="Cloud" size={11} /> Deploy
              </span>
            </div>
            {/* Its own centered line under the pill row — trailing it inline
                read as a fourth pill. */}
            <span className="welcome-hints-kbd">
              or press <kbd>⌘K</kbd>
            </span>
          </div>
        </div>

        {/* Bottom-anchored action band: docs link leftmost, then the two CTAs
            build rightward, primary at the right edge. */}
        <div className="welcome-footer">
          <a
            className="welcome-docs"
            data-testid="welcome-docs"
            href="https://docs.sapiom.ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            Docs <Icon name="ExternalLink" size={12} />
          </a>
          <button
            ref={templatesTriggerRef}
            className="btn-ghost welcome-action"
            data-testid="welcome-browse-templates"
            onClick={() => setTemplatesOpen(true)}
            title="Start from a template: cloneable gallery templates and bundled starters"
          >
            Templates
          </button>
          <button
            className="btn-ghost welcome-action"
            data-testid="welcome-run-sample"
            onClick={() => void runSample()}
            disabled={sampleBusy}
            title="Seeds order-triage, a small support-ticket triage agent, and opens a session in it"
          >
            {sampleBusy ? "Setting up…" : "Sample project"}
          </button>
          <button
            ref={startProjectRef}
            className="btn-primary welcome-action"
            data-testid="welcome-start-project"
            onClick={() => setModalOpen(true)}
          >
            New project
          </button>
        </div>
      </div>

      {modalOpen && (
        <NewSessionModal
          recentDirs={recentDirs}
          launchDir={launchDir}
          listDir={listDir}
          onClose={() => setModalOpen(false)}
          onCreate={onCreateSession}
          listHarnesses={listHarnesses}
          triggerRef={startProjectRef}
        />
      )}

      {/* Templates journey v0: using one creates a session, which unmounts
          this whole panel — the session pane is the destination. */}
      {templatesOpen && (
        <TemplatesDialog
          launchDir={launchDir}
          onClose={() => setTemplatesOpen(false)}
          onUse={onUseTemplate}
          triggerRef={templatesTriggerRef}
        />
      )}
    </div>
  );
}
