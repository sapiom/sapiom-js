import { useState } from "react";
import type { JSX } from "react";
import type { HarnessKind } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import { Icon } from "./Icon";
import { NewSessionModal } from "./NewSessionModal";

interface WelcomePanelProps {
  recentDirs: string[];
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  /** The existing new-session flow — "Start a new project" opens the same
   *  NewSessionModal the tab strip's "+" does, with the same handler. */
  onCreateSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Seeds the bundled example project and opens a session in it. On success
   *  the panel unmounts by itself (a live session now exists). */
  onRunSample: () => Promise<void>;
  /** "Skip for now" — drops to the plain empty-terminal state. */
  onDismiss: () => void;
}

/**
 * First-run welcome — rendered in the terminal slot instead of a bare
 * terminal when this install has never been used before (AppState.firstRun)
 * and no session is live yet. Returning users never see it; a first-run
 * user leaves it by taking either action (which creates a session) or
 * dismissing it.
 */
export function WelcomePanel({
  recentDirs,
  launchDir,
  listDir,
  onCreateSession,
  onRunSample,
  onDismiss,
}: WelcomePanelProps): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <div className="welcome-eyebrow">Welcome</div>
        <h1 className="welcome-title">Your coding agent, wired into Sapiom</h1>
        <p className="welcome-intro">
          This is your own coding agent — Claude Code or Codex — running in a Sapiom-configured workspace. Agent
          workflows you build here show up in the rail, get visualized live on the canvas, and can be run locally or
          deployed with one click.
        </p>

        <div className="welcome-actions">
          <button
            className="btn-primary welcome-action"
            data-testid="welcome-start-project"
            onClick={() => setModalOpen(true)}
          >
            Start a new project
          </button>
          <button
            className="btn-ghost welcome-action"
            data-testid="welcome-run-sample"
            onClick={() => void runSample()}
            disabled={sampleBusy}
          >
            {sampleBusy ? "Setting up the sample…" : "Run the sample project"}
          </button>
        </div>
        <p className="welcome-sample-note">
          The sample is <code>order-triage</code>, a small support-ticket triage agent — ready to visualize, run, and
          deploy.
        </p>
        {error && <div className="welcome-error">{error}</div>}

        <div className="welcome-hints" data-testid="welcome-hints">
          <span className="welcome-hints-label">In a project you can</span>
          <span className="welcome-hint-chip">
            <Icon name="Sparkles" size={11} /> Visualize
          </span>
          <span className="welcome-hint-chip">
            <Icon name="Play" size={11} /> Run local
          </span>
          <span className="welcome-hint-chip">
            <Icon name="Cloud" size={11} /> Deploy
          </span>
          <span className="welcome-hints-kbd">
            — or press <kbd>⌘K</kbd>
          </span>
        </div>

        <button className="welcome-dismiss" data-testid="welcome-dismiss" onClick={onDismiss}>
          Skip for now
        </button>
      </div>

      {modalOpen && (
        <NewSessionModal
          recentDirs={recentDirs}
          launchDir={launchDir}
          listDir={listDir}
          onClose={() => setModalOpen(false)}
          onCreate={onCreateSession}
        />
      )}
    </div>
  );
}
