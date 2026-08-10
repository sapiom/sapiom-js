import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  AppState,
  HarnessEntry,
  HarnessKind,
  HarnessSession,
  SessionResumeMode,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

import type { AuthStartResponse, FsListResponse } from "../lib/api";
import { AnchoredPopover } from "./AnchoredPopover";
import { BrandHeader } from "./BrandHeader";
import { EmptyState } from "./EmptyState";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { Icon } from "./Icon";
import { StartDialog } from "./StartDialog";
import { DEMO_ACCOUNT_PLAN, PlanCard } from "./PlanCard";
import { MenuChoice } from "./MenuChoice";
import { SettingsPopover } from "./SettingsPopover";
import { describeUpdateOutcome, getDesktopBridge } from "../lib/desktop";
import { WorkflowRow } from "./WorkflowRow";
import { isMockMode } from "../lib/api";
import { HARNESS_LABELS, historyDirs, historyRowMeta, sessionRowState } from "../lib/history-meta";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
import { buildWorkspaceTree } from "../lib/workspace-tree";
import type { RailGrouping, RailSort } from "../lib/workspace-tree";
import { SAPIOM_AGENTS_URL } from "../lib/urls";
import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";

interface WorkflowsRailProps {
  /** Resizable width (px) — the rail can shrink to minWidth under pressure. */
  width: number;
  minWidth: number;
  workflows: WorkflowInfo[];
  sessions: HarnessSession[];
  /** The active session — highlights its own row in the history menu. */
  activeSessionId: string | null;
  /** The focused agent (or bare folder) path — the single filled selection. */
  focusedAgentPath: string | null;
  /** Focuses an agent (or a bare-scaffold folder): swaps the main panel's
   *  session tab strip to that subject's sessions. */
  onFocusAgent: (path: string) => void;
  onOpenPalette: () => void;
  onConnect: (path: string) => Promise<void>;
  /** Collapses the rail — the session bar grows an expand affordance. */
  onCollapse: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** Selects a session from the history menu (a past/exited session). */
  onSelectSession: (id: string) => void;
  /** Overview lives in the account menu: it opens the Overview destination —
   *  an introduction to the app — in the main slot. Selecting any session,
   *  agent, or other destination leaves it. */
  overviewSelected: boolean;
  onSelectOverview: () => void;
  /** The "Create new" CTA opens the composer-first "new session" home. */
  onNewSession: () => void;
  /** Opens the past-session review pane for a history entry. */
  onReviewSummary: (summary: SessionSummary) => void;
  history: SessionSummary[];
  historyLoading: boolean;
  onOpenHistory: (cwds: string[]) => void;
  recentDirs: string[];
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onCreateSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Adapter registry fetch — the add dialog's picker and MCP setup block. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  /** Session-plus-scaffold-prompt at a folder that doesn't exist yet. `idea`
   *  is the "start from an idea" door's text, passed verbatim to the agent. */
  onScaffoldSession: (cwd: string, harness: HarnessKind, idea?: string) => Promise<void>;
  /** Where NEW projects are created (resolveProjectRoot in App). */
  projectRoot: string | null;
  /** Persist a changed project root as the user's default. */
  onSaveProjectRoot: (root: string) => Promise<void>;
  /** Bare-scaffold folder affordance: ask the folder's live session to
   *  scaffold its first agent (sapiom.json) in place. */
  onScaffoldInSession: (sessionId: string) => void;
  /** Navigate to the templates destination (App owns the center view). */
  onBrowseTemplates: () => void;
  /** True while that destination is the visible view, so the nav row can say so. */
  templatesActive: boolean;
  onScanWorkflows: (root: string) => Promise<number>;
  /** Push a message onto the app's toast rail (copy confirmations etc.). */
  onToast: (message: string) => void;
  telemetryOptIn: boolean;
  productAnalyticsOptIn: boolean;
  rollingSummary: boolean;
  consentSource?: AppState["consentSource"];
  consentEnvReason?: string | null;
  authenticated: boolean;
  organizationName: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  onToggleProductAnalytics: (next: boolean) => Promise<void>;
  onToggleRollingSummary: (next: boolean) => Promise<void>;
  /** Kick off the browser OAuth flow for the in-app Connect button. */
  onStartAuth: () => Promise<AuthStartResponse>;
  /** Sign out and clear credentials. */
  onDisconnect: () => Promise<void>;
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
}

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = IS_MAC ? "⌘K" : "Ctrl+K";

/**
 * LEVEL 1 workspace folder header: a quiet, non-interactive-to-open label
 * that only groups the agents beneath it. The main button toggles collapse;
 * a trailing hover action (copy path) acts on the folder. It never focuses an
 * agent — that is the agent rows' job.
 */
function FolderHeader({
  label,
  cwd,
  isDirectory = true,
  collapsed,
  onToggleCollapsed,
  onCopyPath,
}: {
  label: string;
  cwd: string;
  /** A real directory (Workspace grouping) carries a folder glyph and the
   *  copy-path action; a deployment FACET bucket has no path behind it, so it
   *  is a bare label + caret. */
  isDirectory?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCopyPath: (path: string) => void;
}): JSX.Element {
  return (
    <div className="workspace-row" data-testid={`workspace-group-${label}`}>
      <button
        className="workspace-row-main"
        onClick={onToggleCollapsed}
        title={isDirectory ? cwd : label}
        aria-expanded={!collapsed}
      >
        {isDirectory && <Icon name={collapsed ? "Folder" : "FolderOpen"} size={13} />}
        <span className="tree-row-label">{label}</span>
        <span className={"workspace-caret" + (collapsed ? "" : " is-open")} aria-hidden="true">
          <Icon name="ChevronDown" size={13} />
        </span>
      </button>
      {isDirectory && (
        <button
          className="workspace-row-action"
          aria-label={`Copy path for ${label}`}
          data-tooltip="Copy path"
          onClick={() => onCopyPath(cwd)}
        >
          <Icon name="Copy" size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The ONE case a folder row is itself a focus target: a folder with live
 * sessions but NO agent (a bare scaffold session). Focusing it opens its
 * sessions as tabs in the main panel; a quiet "scaffold an agent here"
 * affordance lets the folder grow its first sapiom.json.
 */
function BareFolderRow({
  label,
  cwd,
  sessionId,
  isFocused,
  onFocus,
  onScaffold,
  onCopyPath,
}: {
  label: string;
  cwd: string;
  sessionId: string;
  isFocused: boolean;
  onFocus: (path: string) => void;
  onScaffold: (sessionId: string) => void;
  onCopyPath: (path: string) => void;
}): JSX.Element {
  return (
    <div
      className={"workspace-row" + (isFocused ? " is-selected" : "")}
      data-testid={`workspace-group-${label}`}
    >
      <button
        className="workspace-row-main"
        data-testid={`workspace-focus-${label}`}
        aria-label={`Focus ${label}`}
        aria-pressed={isFocused}
        data-tooltip="Folder with sessions, no agent yet. Focus to work in it."
        onClick={() => onFocus(cwd)}
      >
        <Icon name="Folder" size={13} />
        <span className="tree-row-label">{label}</span>
      </button>
      <button
        className="workspace-row-action"
        data-testid={`workspace-scaffold-${label}`}
        aria-label={`Scaffold an agent in ${label}`}
        data-tooltip="Scaffold an agent here"
        onClick={() => onScaffold(sessionId)}
      >
        <Icon name="Sparkles" size={13} />
      </button>
      <button
        className="workspace-row-action"
        aria-label={`Copy path for ${label}`}
        data-tooltip="Copy path"
        onClick={() => onCopyPath(cwd)}
      >
        <Icon name="Copy" size={13} />
      </button>
    </div>
  );
}

/**
 * Merged past-sessions row: exited registry sessions and history entries share
 * this anatomy — title, then one meta line carrying everything else.
 *
 * TWO LINES, NOT THREE (2026-07). The row used to print the path on its own
 * line under the title, and a status pill beside them. But `title` IS the cwd's
 * basename — identical in 62 of 62 rows on a real machine — so the path line
 * repeated the title and then truncated exactly where it would have started to
 * disambiguate (`/Users/me/sapiom/ha…` for both `harness-e2e` and
 * `harness-e2e-hn-comic`). It cost a line and a pill's width to say nothing.
 * The full path moves to the row's tooltip, and the space buys the two fields
 * that DO tell sessions apart — git branch and turn count, which the server
 * already computes and nothing rendered.
 *
 * The state word lives in the meta line rather than a pill for the same reason:
 * a pill wide enough for "from summary" is a column the list can't spare, and
 * `resume` — the ordinary case — needs no word at all.
 *
 * `data-resumable` stays on the row (it moved off the retired pill) because it
 * is the documented hook the e2e suite addresses these rows by. Always one of
 * three strings, never a boolean rendered as one: a mixed type invites
 * `=== "true"` checks that silently miss the unknown state.
 */
function PastSessionRow({
  testid,
  harness,
  title,
  meta,
  cwd,
  resumeMode,
  isSelected,
  onOpen,
}: {
  testid: string;
  harness: HarnessKind;
  title: string;
  meta: string;
  cwd: string;
  resumeMode: SessionResumeMode | undefined;
  isSelected: boolean;
  onOpen: () => void;
}): JSX.Element {
  const resumableAttr = resumeMode === "agent-resume" ? "true" : resumeMode === "rehydrate" ? "false" : "unknown";
  return (
    <button
      data-testid={testid}
      className={"session-dropdown-item" + (isSelected ? " is-selected" : "")}
      data-resumable={resumableAttr}
      title={cwd}
      onClick={onOpen}
    >
      <span className="session-item-icon">
        <HarnessBrandIcon kind={harness} size={13} />
      </span>
      <span className="session-item-copy">
        <span className="session-item-title">{title}</span>
        <span className="session-item-meta">{meta}</span>
      </span>
    </button>
  );
}

/**
 * Full-height workspace rail: brand header, a jump/search field, the explorer
 * tree (workspace folder headers > agent rows), and the account row.
 * Sessions are not a rail concern — they live in the main panel's tab strip,
 * keyed to the focused agent.
 */
export function WorkflowsRail({
  width,
  minWidth,
  workflows,
  sessions,
  activeSessionId,
  focusedAgentPath,
  onFocusAgent,
  onOpenPalette,
  onConnect,
  onCollapse,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onSelectSession,
  overviewSelected,
  onSelectOverview,
  onNewSession,
  onReviewSummary,
  history,
  historyLoading,
  onOpenHistory,
  recentDirs,
  launchDir,
  listDir,
  onCreateSession,
  listHarnesses,
  onScaffoldSession,
  onScaffoldInSession,
  projectRoot,
  onSaveProjectRoot,
  onBrowseTemplates,
  templatesActive,
  onScanWorkflows,
  onToast,
  telemetryOptIn,
  productAnalyticsOptIn,
  rollingSummary,
  consentSource,
  consentEnvReason,
  authenticated,
  organizationName,
  onToggleTelemetry,
  onToggleProductAnalytics,
  onToggleRollingSummary,
  onStartAuth,
  onDisconnect,
  settingsOpen,
  onSetSettingsOpen,
}: WorkflowsRailProps): JSX.Element {
  // "Add existing agents" opens the detection-driven StartDialog (register a
  // folder that already holds an agent project). "Create new" goes to the
  // composer home instead. connectTriggerRef anchors Escape focus return.
  const [startOpen, setStartOpen] = useState(false);
  const connectTriggerRef = useRef<HTMLButtonElement>(null);
  // The ⋯ menu opens BESIDE the rail (not over it), so it clears the whole
  // rail's right edge rather than just the header glyph's.
  const railRef = useRef<HTMLElement>(null);

  // The ⋯ overflow menu: how the tree is grouped, how it is sorted, and the
  // sessions that have ended. Grouping and sort are persisted so the explorer
  // resumes as the user left it (docs/IA.md).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  const [grouping, setGrouping] = useState<RailGrouping>(
    () => loadUiPrefs().railGrouping ?? "workspace",
  );
  const [sort, setSort] = useState<RailSort>(() => loadUiPrefs().railSort ?? "recent");
  const pickGrouping = (next: RailGrouping): void => {
    setGrouping(next);
    saveUiPrefs({ railGrouping: next });
    // A click that changes the section also collapses the Past-sessions
    // sub-card, matching the hover behaviour on the fixed choices.
    setPastOpen(false);
  };
  const pickSort = (next: RailSort): void => {
    setSort(next);
    saveUiPrefs({ railSort: next });
    setPastOpen(false);
  };
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  // Closing the menu also folds its Past-sessions sub-card, so it never
  // reopens already flown out.
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setPastOpen(false);
  }, []);

  // Per-workspace collapse, restored across reloads.
  const [collapsedCwds, setCollapsedCwds] = useState<Set<string>>(
    () => new Set(loadUiPrefs().collapsedCwds ?? []),
  );
  const toggleCollapsed = (cwd: string): void => {
    setCollapsedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };
  useEffect(() => {
    saveUiPrefs({ collapsedCwds: Array.from(collapsedCwds) });
  }, [collapsedCwds]);

  const exitedSessions = sessions.filter((session) => session.status === "exited");

  const toggleHistory = (): void => {
    const next = !historyOpen;
    // Every open lands on the menu, never mid-flyout.
    setPastOpen(false);
    setHistoryOpen(next);
    if (next) {
      const dirs = historyDirs(sessions, recentDirs, activeSessionId);
      if (dirs.length > 0) onOpenHistory(dirs);
    }
  };

  // ONE past-sessions list. Exited registry sessions and history
  // entries merge, deduped, newest first.
  const registryIds = new Set(sessions.map((session) => session.id));
  const registryAgentIds = new Set(
    sessions.map((session) => session.agentSessionId).filter((id): id is string => id != null),
  );
  const pastSummaries = history.filter(
    (summary) =>
      !(summary.harnessSessionId != null && registryIds.has(summary.harnessSessionId)) &&
      !registryAgentIds.has(summary.agentSessionId),
  );
  const pastRows = [
    ...exitedSessions.map((session) => ({ kind: "exited" as const, at: session.lastActiveAt, session })),
    ...pastSummaries.map((summary) => ({ kind: "summary" as const, at: summary.lastActiveAt, summary })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  // Exited registry rows render from the session record (it carries live status
  // history can't), but only the server knows whether the agent still holds
  // their conversation, what branch it was on, and how many turns it ran — so
  // those come from the matching history row. Absent until history loads for
  // that directory, which the row renders as "checking…" rather than guessing.
  // The whole summary is kept, not just `resumeMode`: the same lookup now feeds
  // the meta line's branch and turn count, which exited rows could never show
  // because a registry session carries neither field.
  const historyByAgentId = new Map(history.map((summary) => [summary.agentSessionId, summary] as const));

  const { workspaces, orphanAgents } = buildWorkspaceTree(
    workflows,
    sessions,
    grouping,
    sort,
    recentDirs,
  );

  // A first-run rail (no agents, no orphans) promotes the Create-new CTA to the
  // primary style — the one action that gets the user their first agent.
  const isEmpty = workspaces.length === 0 && orphanAgents.length === 0;

  const copyPath = (path: string): void => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => onToast("Path copied."))
      .catch(() => onToast("Couldn't copy the path."));
  };

  return (
    <aside ref={railRef} className="rail rail-workflows" style={{ width, minWidth }}>
      <BrandHeader
        onCollapse={onCollapse}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
      />

      {/* The rail's top stack of labelled destinations. "Create new" leads as
          the primary affirmative action (a solid ink button — the app's primary
          CTA, like Deploy); Search opens the command palette (carrying the
          unboxed ⌘K / Ctrl+K shortcut) and Templates opens the catalog. Search
          and Templates read as rows, not a boxed field or a bare magnifier — a
          destination is not chrome. */}
      <nav className="rail-nav" aria-label="Primary">
        {/* The primary creative action, promoted out of the header + ABOVE
            Search: the fastest path to a new agent. It opens the composer-first
            "new session" home. A standing ink-button CTA; when the rail has
            nothing yet it gains a soft brand halo so an empty workspace has an
            obvious next step. */}
        <button
          type="button"
          className={"rail-nav-cta" + (isEmpty ? " is-empty" : "")}
          data-testid="rail-create-new"
          aria-label="Create a new agent"
          onClick={() => {
            setHistoryOpen(false);
            onNewSession();
          }}
        >
          <Icon name="Plus" size={14} />
          <span>Create new</span>
        </button>

        <button
          type="button"
          className="rail-nav-row"
          data-testid="palette-trigger"
          aria-label="Search sessions, agents, and paths"
          onClick={onOpenPalette}
        >
          <Icon name="Search" size={14} />
          <span>Search</span>
          <span className="rail-nav-kbd">{SHORTCUT_HINT}</span>
        </button>

        <button
          type="button"
          className={"rail-nav-row" + (templatesActive ? " is-selected" : "")}
          data-testid="rail-templates"
          aria-current={templatesActive ? "page" : undefined}
          onClick={onBrowseTemplates}
        >
          <Icon name="LayoutTemplate" size={14} />
          <span>Templates</span>
        </button>

        {/* Add EXISTING agents — a folder that already holds an agent project.
            Creating a new one is "Create new" (the composer). */}
        <button
          type="button"
          ref={connectTriggerRef}
          className="rail-nav-row"
          data-testid="add-existing-agents"
          aria-haspopup="dialog"
          aria-expanded={startOpen}
          onClick={() => {
            setHistoryOpen(false);
            setStartOpen(true);
          }}
        >
          <Icon name="FolderPlus" size={14} />
          <span>Add existing agents</span>
        </button>
      </nav>

      <div className="rail-header">
        <Icon name="Folder" size={14} />
        <span className="rail-header-label">Workspaces</span>
        <div className="rail-header-actions">
          <button
            ref={historyTriggerRef}
            className="theme-toggle rail-header-btn"
            data-testid="history-trigger"
            aria-label="Workspace options"
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            data-tooltip="Grouping, sorting and past sessions"
            onClick={toggleHistory}
          >
            <Icon name="MoreHorizontal" size={14} />
          </button>
        </div>
      </div>
      <div className="rail-tree">
        {/* The ⋯ overflow menu. The popover is the TRACK, not the card: it
            opens BESIDE the rail (never over the tree it configures), and its
            one unbounded set — Past sessions — opens as a sub-card beside the
            options card rather than a scrolling list nailed under four fixed
            choices. */}
        <AnchoredPopover
          open={historyOpen}
          anchorRef={historyTriggerRef}
          onDismiss={closeHistory}
          placement="right-start"
          besideRef={railRef}
          noClip
          className="menu-flyer"
          testid="history-menu"
        >
          <div className="menu-flyer-track">
            <div className="connect-card history-card">
              <div className="connect-card-header">
                <span>Workspaces</span>
                <button
                  className="theme-toggle connect-card-close"
                  onClick={closeHistory}
                  aria-label="Close"
                  title="Close"
                >
                  <Icon name="X" size={13} />
                </button>
              </div>
              <div className="connect-card-body" role="menu">
                {/* Hovering the fixed choices closes the Past-sessions flyout,
                    so moving off that row collapses its sub-card — the
                    hover-open's natural inverse. (A plain wrapper would flatten
                    the row gap; menu-choice-group re-states the column.) */}
                <div className="menu-choice-group" onMouseEnter={() => setPastOpen(false)}>
                  {/* Only axes the registry actually sends: a folder and a
                      deployment state are real groupings; a repository is not
                      (sapiom.json holds repoFullName, but the registry drops
                      it). */}
                  <div className="session-dropdown-section">Group by</div>
                  <MenuChoice
                    testid="group-workspace"
                    icon="FolderOpen"
                    label="Workspace"
                    checked={grouping === "workspace"}
                    onPick={() => pickGrouping("workspace")}
                  />
                  <MenuChoice
                    testid="group-deployment"
                    icon="Cloud"
                    label="Deployment"
                    checked={grouping === "deployment"}
                    onPick={() => pickGrouping("deployment")}
                  />

                  <div className="session-dropdown-section">Sort</div>
                  <MenuChoice
                    testid="sort-recent"
                    icon="History"
                    label="Recent activity"
                    checked={sort === "recent"}
                    onPick={() => pickSort("recent")}
                  />
                  <MenuChoice
                    testid="sort-name"
                    icon="ArrowDown"
                    label="Name"
                    checked={sort === "name"}
                    onPick={() => pickSort("name")}
                  />
                </div>

                {/* One row that opens a sub-card beside the menu — the set is
                    unbounded (every session this install has finished), so a
                    list nailed here would give a card of four choices a
                    scrollbar. The count rides the row, not the ⋯ trigger.
                    Opens on hover (moving onto it) as well as click. */}
                <button
                  type="button"
                  className={"session-dropdown-item nested-trigger" + (pastOpen ? " is-open" : "")}
                  data-testid="past-sessions-trigger"
                  aria-haspopup="menu"
                  aria-expanded={pastOpen}
                  onMouseEnter={() => setPastOpen(true)}
                  onClick={() => setPastOpen((open) => !open)}
                >
                  <span className="session-item-icon">
                    <Icon name="History" size={13} />
                  </span>
                  <span className="session-item-copy">
                    <span className="session-item-title">Past sessions</span>
                  </span>
                  {exitedSessions.length > 0 && (
                    <span className="session-history-badge" data-testid="session-history-badge">
                      {exitedSessions.length}
                    </span>
                  )}
                  <Icon name="ChevronRight" size={13} />
                </button>
              </div>
            </div>

            {pastOpen && (
              <>
                {/* A real, hit-testable 2px bridge, not a margin: crossing it
                    with the pointer must not drop the hover and close the card
                    being reached for. */}
                <div className="menu-flyer-bridge" aria-hidden="true" />
                <div className="connect-card menu-flyer-nested">
                  <div className="connect-card-header">
                    <span>Past sessions</span>
                    <button
                      className="theme-toggle connect-card-close"
                      onClick={() => setPastOpen(false)}
                      aria-label="Back"
                      title="Back"
                    >
                      <Icon name="X" size={13} />
                    </button>
                  </div>
                  <div
                    className="connect-card-body past-sessions-list"
                    data-testid="past-sessions-card"
                  >
                    {pastRows.map((row) => {
                      if (row.kind === "exited") {
                        // No agentSessionId at all: the agent never established
                        // a session, so there is provably nothing to resume —
                        // no need to wait on history to say so.
                        const summary =
                          row.session.agentSessionId == null
                            ? undefined
                            : historyByAgentId.get(row.session.agentSessionId);
                        const resumeMode =
                          row.session.agentSessionId == null
                            ? ("rehydrate" as const)
                            : summary?.resumeMode;
                        return (
                          <PastSessionRow
                            key={row.session.id}
                            testid={`exited-session-${row.session.id}`}
                            harness={row.session.harness}
                            title={row.session.title}
                            meta={historyRowMeta(
                              {
                                ...row.session,
                                gitBranch: summary?.gitBranch,
                                turnCount: summary?.turnCount,
                                messageCount: summary?.messageCount,
                              },
                              undefined,
                              {
                                includeHarness: false,
                                state: sessionRowState({ resumeMode, turnCount: summary?.turnCount }),
                              },
                            )}
                            cwd={row.session.cwd}
                            resumeMode={resumeMode}
                            isSelected={row.session.id === activeSessionId}
                            onOpen={() => {
                              onSelectSession(row.session.id);
                              closeHistory();
                            }}
                          />
                        );
                      }
                      return (
                        <PastSessionRow
                          key={row.summary.agentSessionId}
                          testid={`history-${row.summary.agentSessionId}`}
                          harness={row.summary.harness}
                          title={row.summary.title}
                          meta={historyRowMeta(row.summary, undefined, {
                            includeHarness: false,
                            state: sessionRowState(row.summary),
                          })}
                          cwd={row.summary.cwd}
                          resumeMode={row.summary.resumeMode}
                          isSelected={false}
                          onOpen={() => {
                            onReviewSummary(row.summary);
                            closeHistory();
                          }}
                        />
                      );
                    })}
                    {historyLoading && <div className="session-dropdown-empty">Loading…</div>}
                    {!historyLoading && pastRows.length === 0 && (
                      <div className="session-dropdown-empty">No past sessions yet</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </AnchoredPopover>

        <div className="rail-list">
          {workspaces.length === 0 && orphanAgents.length === 0 && (
            <EmptyState
              className="rail-empty"
              icon="Folder"
              title="No agents yet"
              body="Open a workspace folder to start a session, or add one. Agents (sapiom.json) appear here automatically."
            />
          )}

          {workspaces.map((workspace) => {
            const collapsed = collapsedCwds.has(workspace.cwd);
            // Bare case: no agents, a live scaffold session — the folder row
            // itself is the focus target (the only clickable folder row).
            const bare = workspace.agents.length === 0 && workspace.bareSessions.length > 0;
            if (bare) {
              const primary = workspace.bareSessions[0];
              return (
                <div key={workspace.cwd} className="workspace-group">
                  <BareFolderRow
                    label={workspace.label}
                    cwd={workspace.cwd}
                    sessionId={primary.id}
                    isFocused={workspace.cwd === focusedAgentPath}
                    onFocus={onFocusAgent}
                    onScaffold={onScaffoldInSession}
                    onCopyPath={copyPath}
                  />
                </div>
              );
            }
            return (
              <div key={workspace.cwd} className="workspace-group">
                <FolderHeader
                  label={workspace.label}
                  cwd={workspace.cwd}
                  isDirectory={workspace.isDirectory}
                  collapsed={collapsed}
                  onToggleCollapsed={() => toggleCollapsed(workspace.cwd)}
                  onCopyPath={copyPath}
                />
                {!collapsed &&
                  workspace.agents.map((agent) => (
                    <WorkflowRow
                      key={agent.workflow.path}
                      workflow={agent.workflow}
                      isFocused={agent.workflow.path === focusedAgentPath}
                      onFocus={onFocusAgent}
                    />
                  ))}
              </div>
            );
          })}

          {orphanAgents.length > 0 && (
            <div className="workspace-group">
              <div className="workspace-row">
                <div
                  className="workspace-row-main workspace-row-static"
                  data-tooltip="Agents that live outside any session folder. Focus one to start a session in its own folder."
                >
                  <Icon name="Folder" size={13} />
                  <span className="tree-row-label">No workspace</span>
                </div>
              </div>
              {orphanAgents.map((agent) => (
                <WorkflowRow
                  key={agent.workflow.path}
                  workflow={agent.workflow}
                  isFocused={agent.workflow.path === focusedAgentPath}
                  onFocus={onFocusAgent}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rail-footer">
        {/* The plan summary sits in the SAME footer block as the account row
            (no divider). Only the demo fixture supplies a plan; live mode
            passes null and the card renders nothing. */}
        <PlanCard plan={isMockMode() ? DEMO_ACCOUNT_PLAN : null} />
        <ProfileRow
          onToast={onToast}
          authenticated={authenticated}
          organizationName={organizationName}
          telemetryOptIn={telemetryOptIn}
          productAnalyticsOptIn={productAnalyticsOptIn}
          rollingSummary={rollingSummary}
          consentSource={consentSource}
          consentEnvReason={consentEnvReason}
          onToggleTelemetry={onToggleTelemetry}
          onToggleProductAnalytics={onToggleProductAnalytics}
          onToggleRollingSummary={onToggleRollingSummary}
          onStartAuth={onStartAuth}
          onDisconnect={onDisconnect}
          settingsOpen={settingsOpen}
          onSetSettingsOpen={onSetSettingsOpen}
          overviewSelected={overviewSelected}
          onSelectOverview={onSelectOverview}
        />
      </div>

      {/* Add EXISTING agents: one detection-driven dialog that registers a
          folder holding an agent project (or a folder of them). Creating a NEW
          agent is "Create new" → the composer home (onNewSession). */}
      {startOpen && (
        <StartDialog
          recentDirs={recentDirs}
          launchDir={launchDir}
          projectRoot={projectRoot}
          listDir={listDir}
          onClose={() => setStartOpen(false)}
          onConnect={onConnect}
          onScan={onScanWorkflows}
          triggerRef={connectTriggerRef}
        />
      )}

    </aside>
  );
}

/**
 * Account row pinned at the rail's very bottom: avatar tile, identity,
 * live-auth dot, and a switch/account menu. Identity binds at server start,
 * so every menu action is a real surface — never a fake account switcher.
 */
/** In-progress sign-in state tracked inside ProfileRow (and its sub-component). */
type ProfileAuthProgress =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string };

function ProfileRow({
  authenticated,
  organizationName,
  telemetryOptIn,
  productAnalyticsOptIn,
  rollingSummary,
  consentSource,
  consentEnvReason,
  onToggleTelemetry,
  onToggleProductAnalytics,
  onToggleRollingSummary,
  onStartAuth,
  onDisconnect,
  settingsOpen,
  onSetSettingsOpen,
  overviewSelected,
  onSelectOverview,
  onToast,
}: {
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  productAnalyticsOptIn: boolean;
  rollingSummary: boolean;
  consentSource?: AppState["consentSource"];
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  onToggleProductAnalytics: (next: boolean) => Promise<void>;
  onToggleRollingSummary: (next: boolean) => Promise<void>;
  onStartAuth: () => Promise<AuthStartResponse>;
  onDisconnect: () => Promise<void>;
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
  overviewSelected: boolean;
  onSelectOverview: () => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => subscribeTheme(setTheme), []);
  const [authProgress, setAuthProgress] = useState<ProfileAuthProgress>({ status: "idle" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeSettings = useCallback(() => onSetSettingsOpen(false), [onSetSettingsOpen]);

  const demo = isMockMode();
  const isPending = authProgress.status === "pending";
  // Null in a browser (`npx @sapiom/harness`), where there is nothing to update —
  // the item is then absent rather than present-and-dead.
  const desktop = getDesktopBridge();
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const handleCheckForUpdates = async (): Promise<void> => {
    if (!desktop || checkingUpdate) return;
    setCheckingUpdate(true);
    closeMenu();
    try {
      // A toast, because the menu closes on click and the outcome is the entire
      // point of pressing this. When an update is already downloaded the main
      // process ALSO re-raises its native "Restart now / Later" prompt — that
      // dialog is the only way to apply one, deliberately (see the desktop app's
      // ipc.ts: page code has no restart channel).
      onToast(describeUpdateOutcome(await desktop.checkForUpdates()).text);
    } catch {
      onToast("Couldn't check for updates.");
    } finally {
      setCheckingUpdate(false);
    }
  };

  // When auth.changed arrives and authenticated flips to true, clear pending.
  if (authenticated && authProgress.status === "pending") {
    setAuthProgress({ status: "idle" });
  }

  const name = demo
    ? "Demo workspace"
    : isPending
      ? "Connecting…"
      : authenticated
        ? (organizationName ?? "Signed in")
        : "Not signed in";
  const meta = demo
    ? "no account connected"
    : isPending
      ? "opening browser"
      : authenticated
        ? "Sapiom account"
        : "connect to get started";
  const initial = (demo ? "D" : (organizationName ?? "S")).charAt(0).toUpperCase();

  const handleConnectFromMenu = async (): Promise<void> => {
    closeMenu();
    setAuthProgress({ status: "pending" });
    try {
      await onStartAuth();
      // Server returns immediately — auth completes via auth.changed bus message.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not start sign-in. Try again.";
      setAuthProgress({ status: "error", message });
    }
  };

  return (
    <div className="rail-footer-row rail-profile-wrap">
      <button
        ref={triggerRef}
        className="rail-profile"
        data-testid="brand-identity"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={demo ? "Static demo. No Sapiom account, server, or agent is connected." : "Account"}
        onClick={() => {
          // Opening the account menu collapses the settings card so the two
          // never stack — one section of the profile is open at a time.
          const willOpen = !menuOpen;
          setMenuOpen(willOpen);
          if (willOpen) closeSettings();
        }}
      >
        <span className="rail-profile-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="rail-profile-copy">
          <span className="rail-profile-name">{name}</span>
          <span className="rail-profile-meta">
            <span
              className="identity-dot"
              data-authenticated={demo ? false : authenticated}
              data-pending={isPending}
            />
            {meta}
          </span>
        </span>
        <Icon name="ChevronDown" size={14} />
      </button>

      <AnchoredPopover
        open={settingsOpen}
        anchorRef={triggerRef}
        onDismiss={closeSettings}
        placement="up-start"
        matchWidth
        className="settings-popover"
        testid="settings-popover"
      >
        <SettingsPopover
          authenticated={authenticated}
          organizationName={organizationName}
          telemetryOptIn={telemetryOptIn}
          productAnalyticsOptIn={productAnalyticsOptIn}
          rollingSummary={rollingSummary}
          consentSource={consentSource}
          consentEnvReason={consentEnvReason}
          onToggleTelemetry={onToggleTelemetry}
          onToggleProductAnalytics={onToggleProductAnalytics}
          onToggleRollingSummary={onToggleRollingSummary}
          onStartAuth={onStartAuth}
          onDisconnect={onDisconnect}
        />
      </AnchoredPopover>

      <AnchoredPopover
        open={menuOpen}
        anchorRef={triggerRef}
        onDismiss={closeMenu}
        placement="up-start"
        matchWidth
        className="profile-menu"
        role="menu"
        testid="profile-menu"
      >
        <button
          role="menuitem"
          className={"profile-menu-item" + (overviewSelected ? " is-selected" : "")}
          data-testid="rail-overview"
          onClick={() => {
            onSelectOverview();
            closeMenu();
          }}
        >
          <Icon name="Info" size={13} />
          Overview
        </button>
        <button
          role="menuitem"
          className="profile-menu-item"
          data-testid="profile-open-dashboard"
          onClick={() => {
            window.open(SAPIOM_AGENTS_URL, "_blank", "noopener,noreferrer");
            closeMenu();
          }}
        >
          <Icon name="ExternalLink" size={13} />
          Open Sapiom dashboard
        </button>
        <button
          role="menuitem"
          className="profile-menu-item"
          data-testid="settings-trigger"
          onClick={() => {
            onSetSettingsOpen(true);
            closeMenu();
          }}
        >
          <Icon name="Settings" size={13} />
          Settings
        </button>
        {/* Appearance sits with the rest of the workspace preferences: the
            rail's chrome line belongs to window controls and navigation. */}
        <button
          role="menuitem"
          className="profile-menu-item"
          data-testid="theme-toggle"
          onClick={() => {
            toggleTheme();
            closeMenu();
          }}
        >
          <Icon name={theme === "dark" ? "Sun" : "Moon"} size={13} />
          {theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        </button>
        {desktop && (
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="profile-check-updates"
            disabled={checkingUpdate}
            onClick={() => void handleCheckForUpdates()}
          >
            <Icon name={checkingUpdate ? "Loader" : "RefreshCw"} size={13} />
            {checkingUpdate ? "Checking…" : "Check for updates"}
            {/* The app's own version, so the user always sees which build they're
                on right where they'd check for a newer one. Empty on older
                desktop builds that predate the appVersion bridge field. */}
            {desktop.appVersion && (
              <span className="profile-menu-version" data-testid="app-version">
                v{desktop.appVersion}
              </span>
            )}
          </button>
        )}
        {!demo && !authenticated && (
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="profile-connect-account"
            disabled={isPending}
            onClick={() => void handleConnectFromMenu()}
          >
            <Icon name="Plug" size={13} />
            {isPending ? "Connecting…" : "Connect account"}
          </button>
        )}
        {!demo && authenticated && (
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="profile-disconnect-account"
            onClick={() => {
              void onDisconnect();
              closeMenu();
            }}
          >
            <Icon name="LogOut" size={13} />
            Disconnect
          </button>
        )}
        {demo && (
          <button
            role="menuitem"
            className="profile-menu-item"
            data-testid="profile-switch-account"
            onClick={() => {
              window.open(SAPIOM_AGENTS_URL, "_blank", "noopener,noreferrer");
              closeMenu();
            }}
          >
            <Icon name="Plug" size={13} />
            Connect Sapiom account
          </button>
        )}
        {authProgress.status === "error" && (
          <p className="profile-menu-auth-error" data-testid="profile-auth-error">
            {authProgress.message}
          </p>
        )}
      </AnchoredPopover>
    </div>
  );
}
