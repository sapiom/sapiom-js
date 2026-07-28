import { useRef, useState } from "react";
import type { JSX } from "react";
import { SPAWNABLE_HARNESS_KINDS } from "@shared/types";
import type { HarnessEntry, HarnessKind, HarnessSession, WorkflowInfo } from "@shared/types";

import type { FsListResponse } from "../lib/api";
import { recentWorkspaces, unlistedAgentCount } from "../lib/recent-workspaces";
import { relativeTimeLabel } from "../lib/relative-time";
import { loadUiPrefs } from "../lib/ui-prefs";
import { Icon } from "./Icon";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog";

/* Real screenshots of THIS app (the current Studio shell in mock mode),
 * regenerated via e2e/capture-welcome-hero.mjs into public/ — BASE_URL keeps
 * the path correct under the Pages base (/sapiom-studio/). */
const welcomeHeroDark = `${import.meta.env.BASE_URL}welcome-hero-dark.png`;
const welcomeHeroLight = `${import.meta.env.BASE_URL}welcome-hero-light.png`;

interface WelcomePanelProps {
  /** Launch dirs (settings.recentDirs). One input to the Overview list, and
   *  still the picker's recents chips inside the add-workspace dialog. */
  recentDirs: string[];
  /**
   * The session registry, live AND exited. This is what makes "Recent
   * workspaces" true: every directory work has happened in, with a real
   * lastActiveAt. See lib/recent-workspaces.ts for why recentDirs alone was
   * never that list.
   */
  sessions: HarnessSession[];
  /** The workflow registry — used only to count agent projects per row (and to
   *  say how many the rail knows), never as rows of its own. */
  workflows: WorkflowInfo[];
  /** Where NEW projects are created — the templates dialog's destination.
   *  Distinct from the launch dir, which is where a SESSION opens. */
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
  /** Navigate to the templates destination. Browsing is a place you go now,
   *  not a dialog this panel owns — see TemplatesPanel. */
  onBrowseTemplates: () => void;
  /**
   * True only on a genuine first run of this install (AppState.firstRun) — the
   * hero pitch is for someone who has never seen the product. A returning user
   * gets the recent-workspaces view instead: the pitch is noise once you have
   * workspaces, and this panel also backs the Overview tab, which returning
   * users open deliberately.
   */
  firstRun: boolean;
}

/** How many workspace rows Overview shows before deferring to the rail. Eight
 *  fits the card without scrolling it; the remainder is stated, not dropped. */
const MAX_OVERVIEW_ROWS = 8;

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
  sessions,
  workflows,
  projectRoot,
  listDir,
  onCreateSession,
  onConnect,
  onScan,
  onScaffold,
  onSaveProjectRoot,
  listHarnesses,
  onBrowseTemplates,
  firstRun,
}: WelcomePanelProps): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The workspace currently being opened, so a second click is a no-op and the
   *  row can show it is working. Null when idle. */
  const [opening, setOpening] = useState<string | null>(null);
  const startProjectRef = useRef<HTMLButtonElement>(null);
  const templatesTriggerRef = useRef<HTMLButtonElement>(null);

  // Cheap enough to derive every render (a few dozen entries, string compares)
  // and always consistent with the props that drove it — memoizing would only
  // add a dependency array to get wrong.
  const workspaces = recentWorkspaces(sessions, recentDirs, workflows);
  const shownWorkspaces = workspaces.slice(0, MAX_OVERVIEW_ROWS);
  const unlisted = unlistedAgentCount(workflows, shownWorkspaces);

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

  /* Product-as-hero: the app itself, cropped to its top band with a fade into
     the card — the pitch is the picture, not paragraphs. Each theme ships its
     own capture: CSS shows the matching one so the fade always lands on the
     card surface behind it, never a dark shot dissolving into a white card.
     Both are real screenshots; regenerate via e2e/capture-welcome-hero.mjs.

     Shown in BOTH states. It began as first-run-only on the reasoning that a
     returning user needs a working surface rather than a pitch — but the image
     is the product, not a pitch, and Overview looked unfinished without it. The
     returning variant is a shorter band (see .welcome-hero--returning) so the
     list it sits above stays the thing you came for. */
  const hero = (
    <div
      className={"welcome-hero" + (firstRun ? "" : " welcome-hero--returning")}
      data-testid="welcome-hero"
      aria-hidden="true"
    >
      <img className="welcome-hero-dark" src={welcomeHeroDark} alt="" />
      <img className="welcome-hero-light" src={welcomeHeroLight} alt="" />
    </div>
  );
  return (
    <div className="welcome-panel" data-testid="welcome-panel">
      <div className="welcome-card">
        {hero}

        <div className="welcome-body">
          {/* One greeting, two readings: "Welcome to" is a thing you say once.
              This card used to fork into two whole layouts — a product pitch for
              a first run, an Overview list for a return — which meant the
              returning surface had no explanation of what Studio is and the
              first-run surface had no way into anything. One anatomy serves
              both: the recents block below simply has nothing to show on a
              brand-new install, so it renders nothing. */}
          <h1 className="welcome-title">
            {firstRun ? "Welcome to Sapiom Agent Studio" : "Sapiom Agent Studio"}
          </h1>
          {/* Three beats, in the order the product earns trust: what it makes of
              your code, what a run costs and shows, who decides to ship. The
              mechanics belong to the rows below — repeating them here would
              spend the one paragraph anybody reads on instructions they are
              about to be given. */}
          <p className="welcome-intro">
            Studio turns the agent workflows in your codebase into a diagram you can run. Local runs
            are free and offline, with every step&rsquo;s input, output and capability call on
            screen. Nothing ships until you say so.
          </p>
          {error && <div className="welcome-error">{error}</div>}

          {/* Primary path: point Studio at a folder. Opens the three-door add
              dialog, whose first door is exactly this question — and which is
              the only surface that can tell an agent project from any folder
              (GET /api/fs/list carries the marker flag). */}
          <div className="welcome-open" data-testid="welcome-open-card">
            <span className="welcome-open-icon" aria-hidden="true">
              <Icon name="FolderOpen" size={20} />
            </span>
            <span className="welcome-open-copy">
              <span className="welcome-open-title">Open a folder</span>
              <span className="welcome-open-desc">
                Workflows in the folder appear in the rail. Nothing is uploaded.
              </span>
            </span>
            <button
              ref={startProjectRef}
              type="button"
              className="btn-primary welcome-open-cta"
              data-testid="welcome-start-project"
              onClick={() => setModalOpen(true)}
            >
              Open folder
            </button>
          </div>

          {/* Secondary path: the catalog, same row anatomy. */}
          <div className="welcome-open" data-testid="welcome-templates-card">
            <span className="welcome-open-icon" aria-hidden="true">
              <Icon name="LayoutTemplate" size={20} />
            </span>
            <span className="welcome-open-copy">
              <span className="welcome-open-title">Start from a template</span>
              <span className="welcome-open-desc">
                Runnable starters, cloned locally and free to test.
              </span>
            </span>
            <button
              ref={templatesTriggerRef}
              type="button"
              className="btn-line welcome-open-cta"
              data-testid="welcome-browse-templates"
              onClick={onBrowseTemplates}
            >
              Browse templates
            </button>
          </div>

          <a
            className="welcome-docs-btn"
            data-testid="welcome-docs"
            href="https://docs.sapiom.ai/agents/quick-start"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read documentation <Icon name="ArrowUpRight" size={12} />
          </a>

          {/* Where you have already been. Absent on a first run because there is
              genuinely nothing to list — see lib/recent-workspaces.ts for why
              this is the session registry and not settings.recentDirs. */}
          {workspaces.length > 0 && (
            <div className="welcome-recents-block">
              <h2 className="welcome-recents-title">Recent workspaces</h2>
              <ul className="welcome-recents" data-testid="welcome-recents">
                {shownWorkspaces.map((workspace) => (
                  <li key={workspace.cwd}>
                    <button
                      type="button"
                      className="welcome-recent"
                      data-testid={`welcome-recent-${workspace.label}`}
                      title={workspace.cwd}
                      disabled={opening !== null}
                      onClick={() => void openWorkspace(workspace.cwd)}
                    >
                      <Icon name="Folder" size={13} />
                      <span className="welcome-recent-name">{workspace.label}</span>
                      <span className="welcome-recent-path">
                        {opening === workspace.cwd ? "Opening…" : workspace.cwd}
                      </span>
                      {/* How many agents are in it, and when it was last worked
                          in. A launch dir that never hosted a session has no
                          honest timestamp, so it shows none. */}
                      <span className="welcome-recent-meta">
                        {workspace.agentCount > 0 &&
                          `${workspace.agentCount} agent${workspace.agentCount === 1 ? "" : "s"}`}
                        {workspace.agentCount > 0 && workspace.lastActiveAt && " · "}
                        {workspace.lastActiveAt &&
                          relativeTimeLabel(Date.parse(workspace.lastActiveAt))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {/* The gap this panel used to hide: the rail scans recursively for
                  sapiom.json and routinely knows dozens of projects, while this
                  list is scoped to where work happened and capped. Say so,
                  rather than letting a short list imply a small installation. */}
              {unlisted > 0 && (
                <p className="welcome-recents-note" data-testid="welcome-recents-note">
                  {workflows.length} agent {workflows.length === 1 ? "project" : "projects"} known in
                  total — the rail lists them all.
                </p>
              )}
            </div>
          )}

          <span className="welcome-hints-kbd">
            or press <kbd>⌘K</kbd>
          </span>
        </div>
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
            onBrowseTemplates();
          }}
          triggerRef={startProjectRef}
        />
      )}
    </div>
  );
}
