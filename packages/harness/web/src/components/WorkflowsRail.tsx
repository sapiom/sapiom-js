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

import type { AuthStartResponse, ConnectGitHubRequest, FsListResponse } from "../lib/api";
import type { GitHubDeviceApi } from "./GitHubDeviceConnect";
import { AddProjectMenu } from "./AddProjectMenu";
import { AnchoredPopover } from "./AnchoredPopover";
import { BrandHeader } from "./BrandHeader";
import { EmptyState } from "./EmptyState";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { Icon } from "./Icon";
import { AddWorkspaceDialog, DoorList, DoorRow } from "./AddWorkspaceDialog";
import type { Door } from "./AddWorkspaceDialog";
import { NewSessionModal } from "./NewSessionModal";
import { SettingsPopover } from "./SettingsPopover";
import { describeUpdateOutcome, getDesktopBridge } from "../lib/desktop";
import { WorkflowRow } from "./WorkflowRow";
import { isMockMode } from "../lib/api";
import { HARNESS_LABELS, historyDirs, historyRowMeta, sessionRowState } from "../lib/history-meta";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
import { buildWorkspaceTree } from "../lib/workspace-tree";

const SAPIOM_DASHBOARD_URL = "https://app.sapiom.ai/workflows";

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
  /** Clone a GitHub repo via the user's local git and register it in the workspace. */
  onConnectGitHub: (req: ConnectGitHubRequest) => Promise<string>;
  /**
   * GitHub Device Flow API adapter. When provided the Device Flow panel is
   * offered as the primary GitHub connect experience; the URL-paste form becomes
   * a fallback. When absent only the URL-paste form is shown.
   */
  githubDeviceApi?: GitHubDeviceApi;
  /** Collapses the rail — the session bar grows an expand affordance. */
  onCollapse: () => void;
  /** Selects a session from the history menu (a past/exited session). */
  onSelectSession: (id: string) => void;
  /** Overview lives in the account menu: it shows the intro panel in the
   *  main slot. Selecting any session leaves it. */
  overviewSelected: boolean;
  onSelectOverview: () => void;
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
  /** Opens a project in the user's editor — URL scheme, cwd-scoped. */
  onOpenInEditor: (path: string) => void;
  /** Push a message onto the app's toast rail (copy confirmations etc.). */
  onToast: (message: string) => void;
  telemetryOptIn: boolean;
  rollingSummary: boolean;
  consentSource?: AppState["consentSource"];
  consentEnvReason?: string | null;
  authenticated: boolean;
  organizationName: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
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
 * trailing hover actions (copy path, open in editor) act on the folder. It
 * never focuses an agent — that is the agent rows' job.
 */
function FolderHeader({
  label,
  cwd,
  collapsed,
  onToggleCollapsed,
  onOpenInEditor,
  onCopyPath,
}: {
  label: string;
  cwd: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenInEditor: (path: string) => void;
  onCopyPath: (path: string) => void;
}): JSX.Element {
  return (
    <div className="workspace-row" data-testid={`workspace-group-${label}`}>
      <button
        className="workspace-row-main"
        onClick={onToggleCollapsed}
        title={cwd}
        aria-expanded={!collapsed}
      >
        <Icon name="Folder" size={13} />
        <span className="tree-row-label">{label}</span>
        <span className={"workspace-caret" + (collapsed ? "" : " is-open")} aria-hidden="true">
          <Icon name="ChevronDown" size={13} />
        </span>
      </button>
      <button
        className="workspace-row-action"
        aria-label={`Copy path for ${label}`}
        data-tooltip="Copy path"
        onClick={() => onCopyPath(cwd)}
      >
        <Icon name="Copy" size={13} />
      </button>
      <button
        className="workspace-row-action"
        data-testid={`workspace-open-editor-${label}`}
        aria-label={`Open ${label} in editor`}
        data-tooltip="Open in editor"
        onClick={() => onOpenInEditor(cwd)}
      >
        <Icon name="Code" size={13} />
      </button>
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
  onOpenInEditor,
  onCopyPath,
}: {
  label: string;
  cwd: string;
  sessionId: string;
  isFocused: boolean;
  onFocus: (path: string) => void;
  onScaffold: (sessionId: string) => void;
  onOpenInEditor: (path: string) => void;
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
        data-testid={`workspace-open-editor-${label}`}
        aria-label={`Open ${label} in editor`}
        data-tooltip="Open in editor"
        onClick={() => onOpenInEditor(cwd)}
      >
        <Icon name="Code" size={13} />
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
  onConnectGitHub,
  onCollapse,
  onSelectSession,
  overviewSelected,
  onSelectOverview,
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
  onOpenInEditor,
  onToast,
  telemetryOptIn,
  rollingSummary,
  consentSource,
  consentEnvReason,
  authenticated,
  organizationName,
  onToggleTelemetry,
  onToggleRollingSummary,
  onStartAuth,
  onDisconnect,
  settingsOpen,
  onSetSettingsOpen,
  githubDeviceApi,
}: WorkflowsRailProps): JSX.Element {
  const [addDialogMode, setAddDialogMode] = useState<"session" | "workspace" | null>(null);
  const [githubMenuOpen, setGithubMenuOpen] = useState(false);
  const connectTriggerRef = useRef<HTMLButtonElement>(null);

  /**
   * The Add menu — the intent question, asked in a popover hanging off the +
   * rather than in a full modal.
   *
   * A centred, scrimmed dialog to pick one of three words was the heaviest
   * possible container for the lightest possible choice, and it read as a
   * different surface from the History menu one button to its left. Same
   * primitive, same card, same rows now.
   *
   * `addDoor` is which door the modal that follows opens at. Only ever set from
   * here, so the modal is never re-asked the question this menu just answered.
   */
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addDoor, setAddDoor] = useState<Door>("have");
  const closeAddMenu = useCallback(() => setAddMenuOpen(false), []);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

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
    // Two popovers hanging off adjacent buttons: opening one closes the other,
    // or they overlap and the top one looks like a child of the wrong trigger.
    if (next) setAddMenuOpen(false);
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

  const { workspaces, orphanAgents } = buildWorkspaceTree(workflows, sessions);

  const copyPath = (path: string): void => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => onToast("Path copied."))
      .catch(() => onToast("Couldn't copy the path."));
  };

  return (
    <aside className="rail rail-workflows" style={{ width, minWidth }}>
      <BrandHeader onCollapse={onCollapse} />

      <div className="rail-search">
        <button
          className="palette-trigger"
          data-testid="palette-trigger"
          aria-label="Jump to session, workflow, or path"
          onClick={onOpenPalette}
        >
          <Icon name="Search" size={13} />
          <span className="palette-trigger-text">Jump to…</span>
          <span className="palette-trigger-hint">{SHORTCUT_HINT}</span>
        </button>
      </div>

      {/* Templates is a destination the rail navigates to, so it gets a nav row
          of its own above the tree rather than hiding behind the "+" — the
          catalog is how someone with an empty rail gets their first workflow,
          and a surface reachable only from inside a dialog was the reason it
          went unfound. */}
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

      <div className="rail-header">
        Workspaces
        <div className="rail-header-actions">
          <button
            ref={historyTriggerRef}
            className="theme-toggle rail-header-btn"
            data-testid="history-trigger"
            aria-label="Sessions and history"
            title="Sessions and history"
            onClick={toggleHistory}
          >
            <Icon name="History" size={14} />
            {exitedSessions.length > 0 && (
              <span className="session-history-badge" data-testid="session-history-badge">
                {exitedSessions.length}
              </span>
            )}
          </button>

          <button
            ref={connectTriggerRef}
            className="theme-toggle rail-header-btn"
            data-testid="add-workspace"
            aria-label="Add workspace"
            aria-expanded={addMenuOpen}
            title="Add a workspace: a folder containing an agent project (sapiom.json). Its agent appears in the rail."
            onClick={() => {
              setHistoryOpen(false);
              setAddMenuOpen((open) => !open);
            }}
          >
            <Icon name="Plus" size={14} />
          </button>
        </div>
      </div>
      <div className="rail-tree">
        {/* The intent question. Same primitive and same card as the History
            menu beside it — and the SAME rows the dialog used to show, so the
            list moved out of the modal rather than being reworded into a
            second copy of itself. Picking a door opens the dialog already at
            that door; picking templates leaves for the destination that owns
            the catalog. */}
        <AnchoredPopover
          open={addMenuOpen}
          anchorRef={connectTriggerRef}
          onDismiss={closeAddMenu}
          // Beside the rail, not over it. The + is pinned to the rail's right
          // edge, so a downward panel grows back across the workspace tree it
          // is about to add to — covering the list you are checking against.
          placement="right-start"
          className="connect-card add-card"
          testid="add-menu"
        >
          <div className="connect-card-header">
            <span>Add</span>
            <button
              className="theme-toggle connect-card-close"
              onClick={closeAddMenu}
              aria-label="Close"
              title="Close"
            >
              <Icon name="X" size={13} />
            </button>
          </div>
          <div className="connect-card-body">
            <DoorList
              // "New session…" leads the menu: it is the most common thing the
              // + is pressed for, and it is an ADD — it was only ever in the
              // Sessions menu because that menu existed first. That put the
              // one action you take daily behind the button for reviewing
              // finished work, and split "start something" across two popovers.
              leading={
                <DoorRow
                  icon="Plus"
                  title="New session…"
                  sub="Start an agent in a folder"
                  testid="new-session-btn"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddDialogMode("session");
                  }}
                />
              }
              onPick={(door) => {
                setAddMenuOpen(false);
                if (door === "template") {
                  onBrowseTemplates();
                  return;
                }
                setAddDoor(door);
                setAddDialogMode("workspace");
              }}
            />
            <DoorRow
              icon="GitBranch"
              title="Connect to GitHub"
              sub="Clone and register a GitHub repo"
              testid="aw-door-github"
              onClick={() => {
                setAddMenuOpen(false);
                setGithubMenuOpen(true);
              }}
            />
          </div>
        </AnchoredPopover>
        {/* GitHub connect sub-flow: Device Flow (primary) or URL-paste (fallback).
            Anchors to the same + trigger so it appears in the same position. */}
        <AddProjectMenu
          triggerRef={connectTriggerRef}
          open={githubMenuOpen}
          onDismiss={() => setGithubMenuOpen(false)}
          onOpenFolder={() => {
            setGithubMenuOpen(false);
            setAddDoor("have");
            setAddDialogMode("workspace");
          }}
          onConnectGitHub={onConnectGitHub}
          onAfterConnect={(path) => {
            // The server already registered the path; focus the new entry.
            void onConnect(path);
          }}
          githubDeviceApi={githubDeviceApi}
        />

        <AnchoredPopover
          open={historyOpen}
          anchorRef={historyTriggerRef}
          onDismiss={closeHistory}
          placement="down-end"
          className="connect-card history-card"
          testid="history-menu"
        >
          <div className="connect-card-header">
            <span>Sessions</span>
            <button
              className="theme-toggle connect-card-close"
              onClick={closeHistory}
              aria-label="Close"
              title="Close"
            >
              <Icon name="X" size={13} />
            </button>
          </div>
          <div className="connect-card-body history-card-body">
            {/* "New session…" used to lead this menu; it lives in the Add menu
                now. This popover reviews work that already happened — the one
                thing you do here is reopen a past session. */}
            <div className="session-dropdown-section">Past sessions</div>
            {pastRows.map((row) => {
              if (row.kind === "exited") {
                // No agentSessionId at all: the agent never established a
                // session, so there is provably nothing to resume — no need to
                // wait on history to say so.
                const summary =
                  row.session.agentSessionId == null
                    ? undefined
                    : historyByAgentId.get(row.session.agentSessionId);
                const resumeMode =
                  row.session.agentSessionId == null ? ("rehydrate" as const) : summary?.resumeMode;
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
                      setHistoryOpen(false);
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
                    setHistoryOpen(false);
                  }}
                />
              );
            })}
            {historyLoading && <div className="session-dropdown-empty">Loading…</div>}
            {!historyLoading && pastRows.length === 0 && (
              <div className="session-dropdown-empty">No past sessions yet</div>
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
                    onOpenInEditor={onOpenInEditor}
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
                  collapsed={collapsed}
                  onToggleCollapsed={() => toggleCollapsed(workspace.cwd)}
                  onOpenInEditor={onOpenInEditor}
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
        <ProfileRow
          onToast={onToast}
          authenticated={authenticated}
          organizationName={organizationName}
          telemetryOptIn={telemetryOptIn}
          rollingSummary={rollingSummary}
          consentSource={consentSource}
          consentEnvReason={consentEnvReason}
          onToggleTelemetry={onToggleTelemetry}
          onToggleRollingSummary={onToggleRollingSummary}
          onStartAuth={onStartAuth}
          onDisconnect={onDisconnect}
          settingsOpen={settingsOpen}
          onSetSettingsOpen={onSetSettingsOpen}
          overviewSelected={overviewSelected}
          onSelectOverview={onSelectOverview}
        />
      </div>

      {/* Two intents, two dialogs — deliberately not one component with a
          `mode`. The workspace intent is three doors (AddWorkspaceDialog); a
          session is one question (which folder) plus which agent. They shared
          375 lines and almost no UI, which is how the workspace side ended up
          showing five jobs at once.

          The workspace dialog now always opens AT a door: the Add popover above
          is the door list, so reaching here means the intent is already known. */}
      {addDialogMode === "workspace" && (
        <AddWorkspaceDialog
          recentDirs={recentDirs}
          projectRoot={projectRoot}
          listDir={listDir}
          onClose={() => setAddDialogMode(null)}
          onConnect={async (cwd) => {
            await onConnect(cwd);
          }}
          onScan={onScanWorkflows}
          onScaffold={onScaffoldSession}
          onSaveProjectRoot={onSaveProjectRoot}
          listHarnesses={listHarnesses}
          onBrowseTemplates={() => {
            setAddDialogMode(null);
            onBrowseTemplates();
          }}
          triggerRef={connectTriggerRef}
          initialDoor={addDoor}
        />
      )}
      {addDialogMode === "session" && (
        <NewSessionModal
          recentDirs={recentDirs}
          launchDir={launchDir}
          listDir={listDir}
          onClose={() => setAddDialogMode(null)}
          onCreate={onCreateSession}
          listHarnesses={listHarnesses}
          triggerRef={historyTriggerRef}
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
  rollingSummary,
  consentSource,
  consentEnvReason,
  onToggleTelemetry,
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
  rollingSummary: boolean;
  consentSource?: AppState["consentSource"];
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
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
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="rail-profile-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="rail-profile-copy">
          <span className="rail-profile-name">{name}</span>
          <span className="rail-profile-meta">{meta}</span>
        </span>
        <span className="identity-dot" data-authenticated={demo ? false : authenticated} data-pending={isPending} />
        <Icon name="ChevronDown" size={13} />
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
          rollingSummary={rollingSummary}
          consentSource={consentSource}
          consentEnvReason={consentEnvReason}
          onToggleTelemetry={onToggleTelemetry}
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
            window.open(SAPIOM_DASHBOARD_URL, "_blank", "noopener,noreferrer");
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
              window.open(SAPIOM_DASHBOARD_URL, "_blank", "noopener,noreferrer");
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
