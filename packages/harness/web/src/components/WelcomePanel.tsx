import { useRef, useState } from "react";
import type { JSX } from "react";
import { SPAWNABLE_HARNESS_KINDS } from "@shared/types";
import type { HarnessEntry, HarnessKind, TemplateDetailView, TemplateListResponse } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import type { StudioTemplate } from "../lib/templates";
import { loadUiPrefs } from "../lib/ui-prefs";
import { Icon } from "./Icon";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog";
import { TemplatesDialog } from "./TemplatesDialog";

/* Real screenshots of THIS app (the current Studio shell in mock mode),
 * regenerated via e2e/capture-welcome-hero.mjs into public/ — BASE_URL keeps
 * the path correct under the Pages base (/sapiom-studio/). */
const welcomeHeroDark = `${import.meta.env.BASE_URL}welcome-hero-dark.png`;
const welcomeHeroLight = `${import.meta.env.BASE_URL}welcome-hero-light.png`;

interface WelcomePanelProps {
  recentDirs: string[];
  launchDir: string | null;
  /** Where NEW projects are created — the templates dialog's destination.
   *  Distinct from launchDir, which is where a SESSION opens. */
  projectRoot: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  /** Session creation — still used by the recents rows (opening a recent
   *  workspace starts a session in it). NOT what "New workspace" does. */
  onCreateSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** "New workspace" opens the SAME three-door dialog the rail's + does.
   *  It used to open NewSessionModal, which meant the panel's most prominent
   *  CTA said "workspace" and delivered the one-question session dialog. */
  onConnect: (cwd: string) => Promise<void>;
  onScan: (root: string) => Promise<number>;
  onScaffold: (cwd: string, harness: HarnessKind, idea?: string) => Promise<void>;
  onSaveProjectRoot: (root: string) => Promise<void>;
  /** Adapter registry fetch — keeps this modal's picker registry-driven too. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  /** Templates journey (App.handleUseTemplate): starts a session in the
   *  destination folder and hands the agent the clone/scaffold prompt. */
  onUseTemplate: (dir: string, template: StudioTemplate) => Promise<void>;
  /** Forwarded to TemplatesDialog — the live catalog fetchers. */
  listTemplates: () => Promise<TemplateListResponse>;
  getTemplate: (id: string) => Promise<TemplateDetailView>;
  /**
   * True only on a genuine first run of this install (AppState.firstRun) — the
   * hero pitch is for someone who has never seen the product. A returning user
   * gets the recent-workspaces view instead: the pitch is noise once you have
   * workspaces, and this panel also backs the Overview tab, which returning
   * users open deliberately.
   */
  firstRun: boolean;
}

/** Basename of a workspace path — the folder name is what the rail shows. */
function folderName(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/**
 * Overview / first-run panel — rendered in the terminal slot when no session is
 * live, and whenever the Overview tab is selected.
 *
 * Two states, because the audiences are different. On a genuine first run the
 * hero pitches the product. For a returning user (the Overview tab's usual
 * visitor) the pitch is dead weight — they get their recent workspaces, which is
 * the thing they actually came here to pick from. Both states share the action
 * band, so Templates / New workspace are always one click away.
 */
export function WelcomePanel({
  recentDirs,
  launchDir,
  projectRoot,
  listDir,
  onCreateSession,
  onConnect,
  onScan,
  onScaffold,
  onSaveProjectRoot,
  listHarnesses,
  onUseTemplate,
  listTemplates,
  getTemplate,
  firstRun,
}: WelcomePanelProps): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The workspace currently being opened, so a second click is a no-op and the
   *  row can show it is working. Null when idle. */
  const [opening, setOpening] = useState<string | null>(null);
  const startProjectRef = useRef<HTMLButtonElement>(null);
  const templatesTriggerRef = useRef<HTMLButtonElement>(null);

  const openWorkspace = async (dir: string): Promise<void> => {
    // Guarded because opening spans two awaits (registry, then session create)
    // and `handleCreateSession` does not dedupe by cwd — an impatient second
    // click would spawn a second agent PTY in the same folder. The Sample
    // project button this replaces had the same guard.
    if (opening) return;
    setOpening(dir);
    setError(null);
    try {
      // Opening a workspace you already used shouldn't re-ask which agent to
      // run, so resolve a default: the user's persisted preference when it is
      // actually installed, else the first installed spawnable adapter. Same
      // registry-driven correction NewSessionModal applies to its default.
      const entries = await listHarnesses();
      const spawnable = entries.filter(
        (entry) => entry.installed && (SPAWNABLE_HARNESS_KINDS as readonly string[]).includes(entry.id),
      );
      const preferred = loadUiPrefs().preferredHarness;
      const chosen =
        (preferred && spawnable.some((entry) => entry.id === preferred) ? preferred : undefined) ??
        (spawnable[0]?.id as HarnessKind | undefined) ??
        "claude-code";
      await onCreateSession(dir, chosen);
      // Success unmounts this panel (a live session now exists), so `opening`
      // is only cleared on the failure path below.
    } catch (err) {
      setError((err as Error).message);
      setOpening(null);
    }
  };

  const actions = (
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
        title="Start from a template: the Sapiom template gallery and bundled starters"
      >
        Templates
      </button>
      <button
        ref={startProjectRef}
        className="btn-primary welcome-action"
        data-testid="welcome-start-project"
        onClick={() => setModalOpen(true)}
      >
        New workspace
      </button>
    </div>
  );

  return (
    <div className="welcome-panel" data-testid="welcome-panel">
      <div className={"welcome-card" + (firstRun ? "" : " welcome-card--returning")}>
        {firstRun ? (
          <>
            {/* Product-as-hero: the app itself, cropped to its top band with a
                fade into the card — the pitch is the picture, not paragraphs.
                Each theme ships its own capture: CSS shows the matching one so
                the fade always lands on the card surface behind it, never a dark
                shot dissolving into a white card. Both are real screenshots;
                regenerate via e2e/capture-welcome-hero.mjs. */}
            <div className="welcome-hero" aria-hidden="true">
              <img className="welcome-hero-dark" src={welcomeHeroDark} alt="" />
              <img className="welcome-hero-light" src={welcomeHeroLight} alt="" />
            </div>

            <div className="welcome-copy">
              <h1 className="welcome-title">Sapiom Studio for full-stack agentic products.</h1>
              <p className="welcome-intro">
                Your coding agent in a Sapiom-configured workspace: build agent workflows, see them on the canvas, run
                and deploy them in one click.
              </p>
              {error && <div className="welcome-error">{error}</div>}

              <div className="welcome-hints" data-testid="welcome-hints">
                <div className="welcome-hint-chips">
                  <span className="welcome-hint-chip">
                    <Icon name="Workflow" size={11} /> Visualize
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
          </>
        ) : (
          <div className="welcome-copy welcome-copy--returning">
            <h1 className="welcome-title welcome-title--returning">Overview</h1>
            {error && <div className="welcome-error">{error}</div>}
            {recentDirs.length > 0 ? (
              <>
                <h2 className="welcome-recents-title">Recent workspaces</h2>
                <ul className="welcome-recents" data-testid="welcome-recents">
                  {recentDirs.slice(0, 8).map((dir) => (
                    <li key={dir}>
                      <button
                        type="button"
                        className="welcome-recent"
                        data-testid={`welcome-recent-${folderName(dir)}`}
                        title={dir}
                        disabled={opening !== null}
                        onClick={() => void openWorkspace(dir)}
                      >
                        <Icon name="Folder" size={13} />
                        <span className="welcome-recent-name">{folderName(dir)}</span>
                        <span className="welcome-recent-path">
                          {opening === dir ? "Opening…" : dir}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              // Reachable: a workspace can be in the rail without ever having
              // hosted a session (a scanned folder), so recents can be empty
              // for someone who is not a first-run user.
              <p className="welcome-intro" data-testid="welcome-no-recents">
                No recent workspaces yet. Open a folder or start from a template.
              </p>
            )}
            <span className="welcome-hints-kbd">
              or press <kbd>⌘K</kbd>
            </span>
          </div>
        )}

        {/* Bottom-anchored action band: docs link leftmost, then the CTAs build
            rightward, primary at the right edge. Shared by both states. */}
        {actions}
      </div>

      {modalOpen && (
        <AddWorkspaceDialog
          recentDirs={recentDirs}
          projectRoot={projectRoot}
          listDir={listDir}
          onClose={() => setModalOpen(false)}
          onConnect={onConnect}
          onScan={onScan}
          onScaffold={onScaffold}
          onSaveProjectRoot={onSaveProjectRoot}
          listHarnesses={listHarnesses}
          onBrowseTemplates={() => {
            setModalOpen(false);
            setTemplatesOpen(true);
          }}
          triggerRef={startProjectRef}
        />
      )}

      {/* Templates journey: using one creates a session, which unmounts this
          whole panel — the session pane is the destination. */}
      {templatesOpen && (
        <TemplatesDialog
          projectRoot={projectRoot}
          onClose={() => setTemplatesOpen(false)}
          onUse={onUseTemplate}
          listTemplates={listTemplates}
          getTemplate={getTemplate}
          triggerRef={templatesTriggerRef}
        />
      )}
    </div>
  );
}
