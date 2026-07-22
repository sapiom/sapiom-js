import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  AppState,
  HarnessEntry,
  HarnessKind,
  HarnessSession,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";

import type { FsListResponse } from "../lib/api";
import type { StudioTemplate } from "../lib/templates";
import { AnchoredPopover } from "./AnchoredPopover";
import { BrandHeader } from "./BrandHeader";
import { EmptyState } from "./EmptyState";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { Icon } from "./Icon";
import { NewSessionModal } from "./NewSessionModal";
import { SettingsPopover } from "./SettingsPopover";
import { TemplatesDialog } from "./TemplatesDialog";
import { WorkflowRow } from "./WorkflowRow";
import { isMockMode } from "../lib/api";
import { HARNESS_LABELS, historyRowMeta } from "../lib/history-meta";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
import { buildWorkspaceTree } from "../lib/workspace-tree";

const SAPIOM_DASHBOARD_URL = "https://app.sapiom.ai";

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
  /** Session-plus-scaffold-prompt at a folder that doesn't exist yet. */
  onScaffoldSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Bare-scaffold folder affordance: ask the folder's live session to
   *  scaffold its first agent (sapiom.json) in place. */
  onScaffoldInSession: (sessionId: string) => void;
  onUseTemplate: (dir: string, template: StudioTemplate) => Promise<void>;
  onScanWorkflows: (root: string) => Promise<number>;
  /** Opens a project in the user's editor — URL scheme, cwd-scoped. */
  onOpenInEditor: (path: string) => void;
  /** Push a message onto the app's toast rail (copy confirmations etc.). */
  onToast: (message: string) => void;
  telemetryOptIn: boolean;
  consentSource?: AppState["consentSource"];
  consentEnvReason?: string | null;
  authenticated: boolean;
  organizationName: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
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

/** Merged past-sessions row: exited registry sessions and history
 *  entries share this anatomy — title, one meta line, path, TEXT status tag. */
function PastSessionRow({
  testid,
  harness,
  title,
  meta,
  cwd,
  resumable,
  isSelected,
  onOpen,
}: {
  testid: string;
  harness: HarnessKind;
  title: string;
  meta: string;
  cwd: string;
  resumable: boolean;
  isSelected: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      data-testid={testid}
      className={"session-dropdown-item" + (isSelected ? " is-selected" : "")}
      onClick={onOpen}
    >
      <span className="session-item-icon">
        <HarnessBrandIcon kind={harness} size={13} />
      </span>
      <span className="session-item-copy">
        <span className="session-item-title">{title}</span>
        <span className="session-item-meta">{meta}</span>
        <span className="session-item-cwd">{cwd}</span>
      </span>
      <span className="past-session-tag" data-resumable={resumable}>
        {resumable ? "resumable" : "archived"}
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
  onUseTemplate,
  onScanWorkflows,
  onOpenInEditor,
  onToast,
  telemetryOptIn,
  consentSource,
  consentEnvReason,
  authenticated,
  organizationName,
  onToggleTelemetry,
  settingsOpen,
  onSetSettingsOpen,
}: WorkflowsRailProps): JSX.Element {
  const [addDialogMode, setAddDialogMode] = useState<"session" | "workspace" | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const connectTriggerRef = useRef<HTMLButtonElement>(null);

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
    setHistoryOpen(next);
    if (next) {
      const dirs: string[] = [];
      const push = (dir?: string | null): void => {
        if (dir && !dirs.includes(dir)) dirs.push(dir);
      };
      push(sessions.find((session) => session.id === activeSessionId)?.cwd);
      sessions.forEach((session) => push(session.cwd));
      recentDirs.forEach((dir) => push(dir));
      if (dirs.length > 0) onOpenHistory(dirs.slice(0, 12));
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

      <div className="rail-header">
        Workspace
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
            aria-label="Add project"
            title="Register an existing agent project folder (sapiom.json). Its agent appears in the rail."
            onClick={() => {
              setHistoryOpen(false);
              setAddDialogMode("workspace");
            }}
          >
            <Icon name="Plus" size={14} />
          </button>
        </div>
      </div>
      <div className="rail-tree">
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
              className="skill-back connect-card-close"
              onClick={closeHistory}
              aria-label="Close"
              title="Close"
            >
              <Icon name="X" size={13} />
            </button>
          </div>
          <div className="connect-card-body history-card-body">
            <button
              className="session-dropdown-item session-dropdown-new"
              data-testid="new-session-btn"
              onClick={() => {
                setHistoryOpen(false);
                setAddDialogMode("session");
              }}
            >
              <span className="session-item-icon">
                <Icon name="Plus" size={13} />
              </span>
              <span className="session-item-copy">
                <span className="session-item-title">New session…</span>
              </span>
            </button>

            <div className="session-dropdown-section">Past sessions</div>
            {pastRows.map((row) =>
              row.kind === "exited" ? (
                <PastSessionRow
                  key={row.session.id}
                  testid={`exited-session-${row.session.id}`}
                  harness={row.session.harness}
                  title={row.session.title}
                  meta={historyRowMeta(row.session)}
                  cwd={row.session.cwd}
                  resumable={row.session.agentSessionId != null}
                  isSelected={row.session.id === activeSessionId}
                  onOpen={() => {
                    onSelectSession(row.session.id);
                    setHistoryOpen(false);
                  }}
                />
              ) : (
                <PastSessionRow
                  key={row.summary.agentSessionId}
                  testid={`history-${row.summary.agentSessionId}`}
                  harness={row.summary.harness}
                  title={row.summary.title}
                  meta={historyRowMeta(row.summary)}
                  cwd={row.summary.cwd}
                  resumable={false}
                  isSelected={false}
                  onOpen={() => {
                    onReviewSummary(row.summary);
                    setHistoryOpen(false);
                  }}
                />
              ),
            )}
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
              body="Start a session in a project directory, or add a workspace. Agents (sapiom.json) appear here automatically."
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
          authenticated={authenticated}
          organizationName={organizationName}
          telemetryOptIn={telemetryOptIn}
          consentSource={consentSource}
          consentEnvReason={consentEnvReason}
          onToggleTelemetry={onToggleTelemetry}
          settingsOpen={settingsOpen}
          onSetSettingsOpen={onSetSettingsOpen}
          overviewSelected={overviewSelected}
          onSelectOverview={onSelectOverview}
        />
      </div>

      {addDialogMode && (
        <NewSessionModal
          mode={addDialogMode}
          recentDirs={recentDirs}
          launchDir={launchDir}
          listDir={listDir}
          onClose={() => setAddDialogMode(null)}
          onCreate={onCreateSession}
          listHarnesses={listHarnesses}
          onScaffold={onScaffoldSession}
          onScan={onScanWorkflows}
          onConnect={async (cwd) => {
            await onConnect(cwd);
          }}
          onBrowseTemplates={() => {
            setAddDialogMode(null);
            setTemplatesOpen(true);
          }}
          triggerRef={addDialogMode === "workspace" ? connectTriggerRef : historyTriggerRef}
        />
      )}

      {templatesOpen && (
        <TemplatesDialog
          launchDir={launchDir}
          onClose={() => setTemplatesOpen(false)}
          onUse={onUseTemplate}
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
function ProfileRow({
  authenticated,
  organizationName,
  telemetryOptIn,
  consentSource,
  consentEnvReason,
  onToggleTelemetry,
  settingsOpen,
  onSetSettingsOpen,
  overviewSelected,
  onSelectOverview,
}: {
  authenticated: boolean;
  organizationName: string | null;
  telemetryOptIn: boolean;
  consentSource?: AppState["consentSource"];
  consentEnvReason?: string | null;
  onToggleTelemetry: (next: boolean) => Promise<void>;
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
  overviewSelected: boolean;
  onSelectOverview: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeSettings = useCallback(() => onSetSettingsOpen(false), [onSetSettingsOpen]);

  const demo = isMockMode();
  const name = demo ? "Demo workspace" : authenticated ? (organizationName ?? "Signed in") : "Not signed in";
  const meta = demo ? "no account connected" : authenticated ? "Sapiom account" : "connect to get started";
  const initial = (demo ? "D" : (organizationName ?? "S")).charAt(0).toUpperCase();

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
        <span className="identity-dot" data-authenticated={demo ? false : authenticated} />
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
          consentSource={consentSource}
          consentEnvReason={consentEnvReason}
          onToggleTelemetry={onToggleTelemetry}
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
        <button
          role="menuitem"
          className="profile-menu-item"
          data-testid="profile-switch-account"
          disabled={!demo && authenticated}
          title={
            !demo && authenticated
              ? "Identity binds when the server starts. Sign out at app.sapiom.ai or clear ~/.sapiom/credentials.json, then restart the Studio server."
              : "Sign in at app.sapiom.ai, then start the Studio server. It picks up the cached credential."
          }
          onClick={() => {
            window.open(SAPIOM_DASHBOARD_URL, "_blank", "noopener,noreferrer");
            closeMenu();
          }}
        >
          <Icon name="Plug" size={13} />
          {demo || !authenticated ? "Connect Sapiom account" : "Switch account"}
        </button>
      </AnchoredPopover>
    </div>
  );
}
