import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";
import type {
  AppState,
  EditorKind,
  HarnessEntry,
  HarnessKind,
  HarnessSession,
  SessionResumeMode,
  SessionSummary,
  WorkflowInfo,
} from "@shared/types";
import type { WorkspaceKey } from "@shared/system-graph";
import type {
  StudioProjectSummary,
  StudioWorkspaceSelection,
} from "@shared/agent-map";

import type { AuthStartResponse, FsListResponse } from "../lib/api";
import type { ToastTone } from "../lib/toast";
import { AnchoredPopover } from "./AnchoredPopover";
import { BrandHeader } from "./BrandHeader";
import { EmptyState } from "./EmptyState";
import { HarnessBrandIcon } from "./HarnessBrandIcon";
import { openHelpOverlay } from "./HelpOverlay";
import { Icon } from "./Icon";
import { StartDialog } from "./StartDialog";
import type { StartMode } from "./StartDialog";
import { PlanCard } from "./PlanCard";
import { UpdateCard } from "./UpdateCard";
import { SettingsPopover } from "./SettingsPopover";
import { describeUpdateOutcome, getDesktopBridge } from "../lib/desktop";
import { chooseProjectFolder } from "../lib/folder-step";
import {
  ProjectRow,
  ProjectTreeRows,
  AgentMapRow,
  dirKey,
  projectKey,
} from "./ProjectTreeRows";
import type { RailDrag } from "./ProjectTreeRows";
import { RemoveProjectConfirm } from "./RemoveProjectConfirm";
import { UNROOTED_KEY, UnrootedAgents } from "./UnrootedAgents";
import { GroupSections } from "./GroupRow";
import type { GroupDropRequest } from "./GroupRow";
import { useRailGroups } from "../lib/use-rail-groups";
import {
  applyGroupDrop,
  canResetToDetected,
  createGroup,
  deleteGroup,
  isMaterialized,
  renameGroup,
} from "../lib/agent-groups";
import { WorkflowRow } from "./WorkflowRow";
import { ApiError, createApi, isMockMode } from "../lib/api";
import { planMove } from "../lib/agent-move";
import { useAccountPlan } from "../lib/use-account-plan";
import {
  HARNESS_LABELS,
  historyDirs,
  historyRowMeta,
  sessionRowState,
} from "../lib/history-meta";
import { loadUiPrefs, saveUiPrefs } from "../lib/ui-prefs";
import {
  agentPrefixes,
  buildProjectTree,
  projectIsEmpty,
  projectRoots,
  unrootedAgents,
} from "../lib/project-tree";
import {
  hiddenByClosedProject,
  planProjectRemoval,
} from "../lib/project-membership";
import type { RailAxis, RailSort } from "../lib/project-tree";
import { samePath } from "../lib/paths";
import type { PendingWorkspace } from "../lib/use-harness-state";
import { SAPIOM_AGENTS_URL } from "../lib/urls";
import { getTheme, subscribeTheme, toggleTheme } from "../lib/theme";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * Module-level client, matching `use-rail-groups.ts` / `use-account-plan.ts` —
 * the rail is handed callbacks rather than a client, and the Project-axis move
 * is a single fire-and-forget mutation whose result reaches the app the way the
 * server announces it (`workflows.changed`), not through a return value.
 */
const api = createApi();

interface WorkflowsRailProps {
  /** Resizable width (px) — the rail can shrink to minWidth under pressure. */
  width: number;
  minWidth: number;
  workflows: WorkflowInfo[];
  sessions: HarnessSession[];
  /** Folders whose agent is being created but has not yet landed in
   *  `workflows`/`sessions` — rendered as optimistic "Creating agent…" rows so
   *  a mid-creation agent is always findable in the rail. */
  pendingWorkspaces: PendingWorkspace[];
  /** The active session — highlights its own row in the history menu. */
  activeSessionId: string | null;
  /** The focused agent (or bare folder) path — the single filled selection. */
  focusedAgentPath: string | null;
  /** Opaque server-issued identities that join project roots to the local
   * system-graph endpoint without exposing paths in URLs. */
  workspaceScopes: AppState["workspaceScopes"];
  /** Presence selects the additive plan-first rail; absence preserves legacy. */
  studioProjects: readonly StudioProjectSummary[] | undefined;
  studioSelection: StudioWorkspaceSelection | null;
  /** The project whose dependency graph currently owns the full main area. */
  selectedWorkspaceKey: WorkspaceKey | null;
  /** Selects an exact project graph without changing the active session or
   * either preserved agent pane. */
  onSelectWorkspace: (
    workspaceKey: WorkspaceKey,
    root: string,
    label: string,
  ) => void;
  onSelectAgentMap: (projectId: string, root: string, label: string) => void;
  onSelectStudioAgent: (
    workflow: WorkflowInfo,
    projectId: string,
    agentId: string,
  ) => void;
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
  /**
   * THE ONE CREATE VERB'S SECOND STEP: make an agent in a project the user has
   * already named.
   *
   * `root` is a folder that is not necessarily a project yet — the folder step
   * runs first and hands whatever it collected straight here, so App owns the
   * "open it as a project, then create in it" order rather than the rail
   * knowing it. This replaced `onNewSession`, which opened the composer and
   * ended in an English sentence injected into a terminal (`App.tsx`'s
   * `sendScaffoldPrompt`) — the mechanism SAP-2981 removed everywhere except
   * the most prominent control in the product.
   */
  onNewAgentIn: (root: string, label?: string) => Promise<void> | void;
  /** Opens the past-session review pane for a history entry. */
  onReviewSummary: (summary: SessionSummary) => void;
  history: SessionSummary[];
  historyLoading: boolean;
  onOpenHistory: (cwds: string[]) => void;
  recentDirs: string[];
  /** Project roots the user REMOVED. A closed root hides its own subtree —
   *  itself, its agents, and the session cwds under it — minus any project
   *  opened separately inside it. See `lib/project-membership.ts`. */
  closedProjects: string[];
  /** Checkouts a scan of each root declined to enter — see the empty-project row. */
  unsearchedCheckouts: Record<string, string[]>;
  /** Removes a project: out of `recentDirs`, out of the rail, and the live
   *  sessions rooted in it end. Nothing on disk is touched. */
  onRemoveProject: (root: string) => Promise<void>;
  /**
   * OPENS A FOLDER AS A PROJECT — the other half of `onRemoveProject`, and the
   * one round 1 was missing.
   *
   * Distinct from `onConnect`, which registers an AGENT and only remembers its
   * folder when nothing else already holds it. A project is a folder the user
   * CHOSE, agents or not: you open a project in order to build the first agent
   * in it. Round 1 routed the header `+` into agent detection, so a folder with
   * no agent in it could not be added at all.
   */
  onOpenProject: (root: string) => Promise<unknown>;
  launchDir: string | null;
  listDir: (path?: string) => Promise<FsListResponse>;
  onCreateSession: (cwd: string, harness: HarnessKind) => Promise<void>;
  /** Adapter registry fetch — the add dialog's picker and MCP setup block. */
  listHarnesses: () => Promise<HarnessEntry[]>;
  /**
   * Compatibility path for a state payload without a durable Studio project.
   * Opens the create dialog App owns; the harness then does the scaffold and
   * the agent joins the rail before any session starts.
   *
   * It used to be `onScaffoldSession(root, harness)` — start a pty and inject
   * an English sentence asking the coding agent to call the scaffold MCP tool.
   * The row's own menu item said "Create an agent in {project}" while the thing
   * it did was send a chat message, which is why a failed create arrived as a
   * confused model instead of an error.
   */
  onCreateAgent: (root: string, label: string) => void;
  /** Where NEW projects are created (resolveProjectRoot in App). */
  projectRoot: string | null;
  /** Persist a changed project root as the user's default. */
  onSaveProjectRoot: (root: string) => Promise<void>;
  /** Compatibility-only bare-project affordance: create the folder's first
   *  agent, binding the live session it already has rather than opening a
   *  second one. */
  onScaffoldInSession: (sessionId: string) => void;
  /** Navigate to the templates destination (App owns the center view). */
  onBrowseTemplates: () => void;
  /** True while that destination is the visible view, so the nav row can say so. */
  templatesActive: boolean;
  onScanWorkflows: (root: string) => Promise<number>;
  /** Push a message onto the app's toast rail (copy confirmations etc.).
   *  Defaults to the "error" tone; result announcements opt into "info". */
  onToast: (message: string, tone?: ToastTone) => void;
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
  editor: EditorKind;
  onSelectEditor: (next: EditorKind) => Promise<void>;
  /** Kick off the browser OAuth flow for the in-app Connect button. */
  onStartAuth: () => Promise<AuthStartResponse>;
  /** Sign out and clear credentials. */
  onDisconnect: () => Promise<void>;
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = IS_MAC ? "⌘K" : "Ctrl+K";

/**
 * The axes the filing panel offers, and their copy.
 *
 * TWO entries. `workspace` accumulated a row for every directory that had ever
 * hosted a session, and `deployment` filed on `definitionId != null` — a fact
 * every agent row already prints as a cloud glyph, so it re-sorted the rail to
 * tell you nothing new. Both are retired. `group` (what an agent is RELATED to,
 * read off launch edges) took the slot, and is the only kind of axis that earns
 * one: a fact the row cannot already show. Any future axis has to clear the same
 * bar.
 */
/** The agent the user last chose in the composer, for actions that must pick one
 *  without asking. Defaults to Claude Code, which is what a fresh install has. */
const RAIL_AXES: readonly RailAxis[] = ["project", "group"];
const AXIS_LABELS: Record<RailAxis, string> = {
  project: "Project",
  group: "Group",
};
/** A stored value from a retired axis falls back to the default rather than
 *  rendering a section that no longer exists. */
const resolveAxis = (stored: unknown): RailAxis =>
  RAIL_AXES.includes(stored as RailAxis) ? (stored as RailAxis) : "project";

const SORT_LABELS: Record<RailSort, string> = {
  recent: "Recent activity",
  name: "Name",
};

/**
 * The project row's ONE trailing action control.
 *
 * A `⋮` rather than a row of glyphs, because the actions a project row offers
 * do not share a subject: creating an agent acts on an AGENT inside the
 * project, removing acts on the PROJECT. Two adjacent 13px marks cannot say
 * which noun they take, and side by side they claimed a symmetry that was not
 * there — see the call site for the pair this replaces.
 *
 * Named items say it instead. Each carries the project's own label, so the
 * subject is read rather than inferred, and the destructive one is last and
 * marked.
 *
 * The trigger keeps its own open state and its own ref: `triggerRef` is what
 * the remove confirmation returns focus to, and the menu item that opened it
 * has unmounted by then.
 */
function ProjectRowMenu({
  label,
  create,
  onRemove,
}: {
  label: string;
  /** The compatibility create action this project currently offers, or null
   *  when its Agent Map owns creation / while one is mid-creation. A bare
   *  project (sessions, no agent) scaffolds into its existing session; every
   *  other project starts a new one rooted at the project. */
  create: {
    kind: "create" | "scaffold";
    testid: string;
    label: string;
    run: () => void;
  } | null;
  onRemove: (trigger: HTMLButtonElement | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="workspace-row-action project-row-menu-trigger"
        data-testid={`project-menu-${label}`}
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="Project actions"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="EllipsisVertical" size={13} />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={() => setOpen(false)}
        placement="down-end"
        className="menu-flyer"
        testid={`project-menu-card-${label}`}
      >
        <div className="connect-card project-row-menu">
          <div className="connect-card-body" role="menu">
            {create && (
              <button
                type="button"
                role="menuitem"
                className="session-dropdown-item"
                data-testid={create.testid}
                onClick={() => {
                  setOpen(false);
                  create.run();
                }}
              >
                <span className="session-item-icon">
                  <Icon
                    name={create.kind === "scaffold" ? "Sparkles" : "Plus"}
                    size={13}
                  />
                </span>
                <span className="session-item-copy">
                  <span className="session-item-title">{create.label}</span>
                </span>
              </button>
            )}
            {/* REMOVE. An `X`, not a trash can: this closes a project and ends
                its sessions, and never touches a file — a bin glyph would say
                the opposite of the copy in the confirm. */}
            <button
              type="button"
              role="menuitem"
              className="session-dropdown-item project-row-menu-danger"
              data-testid={`project-remove-${label}`}
              onClick={() => {
                setOpen(false);
                onRemove(triggerRef.current);
              }}
            >
              <span className="session-item-icon">
                <Icon name="X" size={13} />
              </span>
              <span className="session-item-copy">
                <span className="session-item-title">
                  Remove {label} from the rail
                </span>
              </span>
            </button>
          </div>
        </div>
      </AnchoredPopover>
    </>
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
  const resumableAttr =
    resumeMode === "agent-resume"
      ? "true"
      : resumeMode === "rehydrate"
        ? "false"
        : "unknown";
  return (
    <button
      data-testid={testid}
      className={"session-dropdown-item" + (isSelected ? " is-selected" : "")}
      data-resumable={resumableAttr}
      title={cwd}
      onClick={onOpen}
      // `title` is the absolute path and the row renders the session title,
      // which is the user's first prompt.
      {...trackingAttrs({ object: "session" })}
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
 * tree (project roots > directory branches > agent rows), and the account row.
 * Sessions are not a rail concern — they live in the main panel's tab strip,
 * keyed to the focused agent.
 */
export function WorkflowsRail({
  width,
  minWidth,
  workflows,
  sessions,
  pendingWorkspaces,
  activeSessionId,
  focusedAgentPath,
  workspaceScopes,
  studioProjects,
  studioSelection,
  selectedWorkspaceKey,
  onSelectWorkspace,
  onSelectAgentMap,
  onSelectStudioAgent,
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
  onNewAgentIn,
  onReviewSummary,
  history,
  historyLoading,
  onOpenHistory,
  recentDirs,
  closedProjects,
  unsearchedCheckouts,
  onRemoveProject,
  onOpenProject,
  launchDir,
  listDir,
  onCreateSession,
  listHarnesses,
  onCreateAgent,
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
  editor,
  onSelectEditor,
  onStartAuth,
  onDisconnect,
  settingsOpen,
  onSetSettingsOpen,
}: WorkflowsRailProps): JSX.Element {
  // The footer's plan card. Keyed on the auth state the rail already receives,
  // so sign-in/out re-reads without a second events subscription. MockApi
  // serves the demo fixture, which is what the static Pages build renders.
  const accountPlan = useAccountPlan(authenticated);
  // The footer's "Update now" card — exists only while the desktop app says a
  // downloaded update is waiting. The push protocol re-sends current state on
  // every page load, so subscribing at mount is the whole handshake; a browser
  // (no bridge) or an older desktop build (no subscription) never sets this.
  const [updateReady, setUpdateReady] = useState<{ version: string } | null>(
    null,
  );
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onUpdateState) return;
    return bridge.onUpdateState((state) => {
      setUpdateReady(
        state.kind === "downloaded" ? { version: state.version } : null,
      );
    });
  }, []);
  /**
   * THE CREATE VERB'S FIRST STEP, and the folder dialog it may or may not need.
   *
   * `newAgentOpen` is the "where does it live" step: the projects you already
   * have, plus one way out to a folder you do not. It is a popover rather than
   * a dialog on purpose — it is a choice among places the rail is already
   * showing, and the modal family is owned elsewhere.
   *
   * `startMode` is the folder dialog, and it is now the WEB fallback for that
   * step plus the ⋮ menu's "Add existing agents". `startIntent` says what the
   * answer is for, because the same dialog serves two questions and only one of
   * them continues into creation. Pointing both at one intent is round 1's bug
   * in mirror image: it made "add a project" mean "add a project that already
   * contains an agent".
   */
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [startMode, setStartMode] = useState<StartMode | null>(null);
  const [startIntent, setStartIntent] = useState<"create" | "register">(
    "register",
  );
  const startOpen = startMode !== null;
  const addProjectTriggerRef = useRef<HTMLButtonElement>(null);

  /**
   * NATIVE ON DESKTOP, TYPED PATH ON THE WEB — gated HERE, at the entry point.
   *
   * The split already existed one level too deep, inside `FolderField`, where
   * the bridge only decided whether to render a `<datalist>`. That is the wrong
   * question: with a real OS folder browser available, a modal wrapping a text
   * input is not a smaller version of it, it is a different and worse control.
   * So the bridge decides whether the DIALOG opens at all. When it is there the
   * user gets Finder/Explorer; when it is not (the `npx` browser host) the
   * dialog is the fallback, unchanged.
   *
   * Feature-detected, never assumed: an older desktop build without
   * `chooseDirectory` reads as a browser and gets the fallback, which is always
   * safe. See `lib/desktop.ts`.
   */
  const chooseDirectory = getDesktopBridge()?.chooseDirectory ?? null;

  const pickFolderForNewAgent = (): void => {
    setNewAgentOpen(false);
    void chooseProjectFolder({
      chooseDirectory,
      startingAt: projectRoot ?? launchDir,
      openDialog: () => {
        setStartIntent("create");
        setStartMode("open");
      },
      onPicked: (root) => void onNewAgentIn(root),
    });
  };
  // The ⋮ menu opens BESIDE the rail (not over it), so it clears the whole
  // rail's right edge rather than just the header glyph's.
  const railRef = useRef<HTMLElement>(null);

  // The ⋮ overflow menu: how the tree is grouped, how it is sorted, and the
  // sessions that have ended. Grouping and sort are persisted so the explorer
  // resumes as the user left it (docs/IA.md).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  // `project` (where an agent lives) and `group` (what it is related to).
  // `deployment` is retired — it bucketed a fact every agent row already prints
  // as a glyph — and `workspace` is replaced by `project`.
  const [axis, setAxis] = useState<RailAxis>(() =>
    resolveAxis(loadUiPrefs().railAxis),
  );
  const [sort, setSort] = useState<RailSort>(() =>
    loadUiPrefs().railSort === "name" ? "name" : "recent",
  );
  const pickAxis = (next: RailAxis): void => {
    setAxis(next);
    saveUiPrefs({ railAxis: next });
    // A click that changes the filing also collapses the Past-sessions
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

  // Per-row collapse, restored across reloads. Keys are NAMESPACED
  // (`project:` / `dir:`): a path is not unique across row kinds, and one
  // shared key collapsed a nested project and the same-named subdirectory of
  // its parent at the same time.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(
    () => new Set(loadUiPrefs().collapsedKeys ?? []),
  );
  const toggleCollapsed = useCallback((key: string): void => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const revealProject = useCallback((root: string): void => {
    setCollapsedKeys((previous) => {
      const key = projectKey(root);
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    saveUiPrefs({ collapsedKeys: Array.from(collapsedKeys) });
  }, [collapsedKeys]);
  const selectedStudioRoot = studioSelection
    ? ((workspaceScopes ?? []).find(
        (scope) => scope.projectId === studioSelection.projectId,
      )?.cwd ?? null)
    : null;
  const selectedStudioKey = studioSelection
    ? studioSelection.kind === "agent"
      ? `${studioSelection.kind}:${studioSelection.projectId}:${studioSelection.agentId}`
      : `${studioSelection.kind}:${studioSelection.projectId}`
    : null;
  useLayoutEffect(() => {
    if (!selectedStudioRoot) return;
    revealProject(selectedStudioRoot);
  }, [revealProject, selectedStudioKey, selectedStudioRoot]);

  const exitedSessions = sessions.filter(
    (session) => session.status === "exited",
  );

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
    sessions
      .map((session) => session.agentSessionId)
      .filter((id): id is string => id != null),
  );
  const pastSummaries = history.filter(
    (summary) =>
      !(
        summary.harnessSessionId != null &&
        registryIds.has(summary.harnessSessionId)
      ) && !registryAgentIds.has(summary.agentSessionId),
  );
  const pastRows = [
    ...exitedSessions.map((session) => ({
      kind: "exited" as const,
      at: session.lastActiveAt,
      session,
    })),
    ...pastSummaries.map((summary) => ({
      kind: "summary" as const,
      at: summary.lastActiveAt,
      summary,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  // Exited registry rows render from the session record (it carries live status
  // history can't), but only the server knows whether the agent still holds
  // their conversation, what branch it was on, and how many turns it ran — so
  // those come from the matching history row. Absent until history loads for
  // that directory, which the row renders as "checking…" rather than guessing.
  // The whole summary is kept, not just `resumeMode`: the same lookup now feeds
  // the meta line's branch and turn count, which exited rows could never show
  // because a registry session carries neither field.
  const historyByAgentId = new Map(
    history.map((summary) => [summary.agentSessionId, summary] as const),
  );

  // The PROJECT axis: root folders the user opened > directories that actually
  // branch > agents. Which folders qualify is `projectRoots`, one sentence: a
  // project is a directory you chose that holds agents. Nothing a user had
  // disappears, because the rule is derivational and `recentDirs` is untouched.
  const pendingCwds = pendingWorkspaces.map((pending) => pending.cwd);
  // A REMOVED project takes its whole subtree with it (SAP-2932): its own row,
  // its agents — which would otherwise reappear as strays — and the session
  // cwds under it, which are project roots in their own right and would
  // otherwise replace one row with a row per folder a session had run in. The
  // exception is a project opened separately inside it, which `openRoots`
  // (explicit choices only, never a session cwd) rescues.
  const openRoots = [...recentDirs, ...pendingCwds];
  const shown = (path: string): boolean =>
    !hiddenByClosedProject(path, closedProjects, openRoots);
  const visibleWorkflows = workflows.filter((workflow) => shown(workflow.path));
  const roots = projectRoots({
    recentDirs,
    sessions,
    pendingCwds,
    // Hidden agents are deliberately NOT passed. A removed project's agents are
    // not on screen, so they cannot be the reason a folder is filed away.
    agentPaths: visibleWorkflows.map((workflow) => workflow.path),
    sort,
  }).filter(shown);
  const projects = buildProjectTree(visibleWorkflows, roots, sort);
  // Agents no open root contains. Rarer than the old "No workspace" bucket,
  // but dropping them would hide an agent that exists.
  const strays = unrootedAgents(visibleWorkflows, roots, sort);
  // Every REGISTERED agent path, hidden ones included: "Open as project" counts
  // what a folder would bring in, and a folder that would un-hide a removed
  // project's agents is exactly the case that number has to be honest about.
  const workflowPaths = workflows.map((workflow) => workflow.path);
  // The project whose remove confirm is open, and the row control focus
  // returns to when it closes.
  const [removing, setRemoving] = useState<{
    root: string;
    label: string;
  } | null>(null);
  // Set imperatively from the clicked row's own control, so Escape hands focus
  // back to the button the flow started from rather than to the document.
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null);

  // The directory currently under the pointer during a Project-axis drag. Held
  // HERE rather than by each row: only one row may be the target at a time, and
  // rows that track their own hover disagree mid-drag.
  const [dropDir, setDropDir] = useState<string | null>(null);

  /**
   * PROJECT-AXIS DROP. A real directory move on disk — the Project axis is
   * derived from real paths, so a drag has exactly two honest outcomes: move, or
   * refuse. A display override would make the axis assert a location that is not
   * true, which is the one thing it exists to be trustworthy about. (Rearranging
   * without touching disk is the Group axis, above.)
   *
   * Offered ONLY on the project axis. The plan comes from `lib/agent-move.ts`;
   * the endpoint guards itself again, so a refusal can still arrive for a plan
   * this rail blessed — a planner is not a permission system.
   */
  const drag: RailDrag | undefined =
    axis === "project"
      ? {
          dropDir,
          setDropDir,
          onDropInto: (from, targetDir) => {
            setDropDir(null);
            const plan = planMove(
              from,
              targetDir,
              workflows.map((workflow) => workflow.path),
            );
            if (!plan.ok) {
              // An EMPTY reason is the silent refusal — dropped into the folder
              // it already occupies. The user let go somewhere harmless and
              // deserves silence, not a complaint.
              if (plan.reason) onToast(plan.reason);
              return;
            }
            void api.moveAgent(plan.from, plan.to).catch((err: unknown) => {
              onToast(
                (err instanceof ApiError ? err.reason : null) ??
                  (err instanceof Error
                    ? err.message
                    : `Couldn't move ${plan.name}.`),
              );
            });
          },
        }
      : undefined;

  // The GROUP axis: what an agent is RELATED to, seeded from launch edges and
  // then owned by the user. One stored arrangement per project root, because
  // groups are project-scoped — the file lives in the project, which is what
  // makes the arrangement committable and shareable. Every rule about that file
  // lives in `lib/agent-groups.ts`; this component only renders it.
  const railGroups = useRailGroups(roots, workflows, sort, axis === "group");
  // The group created by the last "New group" press, so its row mounts straight
  // into the rename input. Keyed by LABEL, not id: the id is minted inside the
  // reducer, and reading it back from there would mean calling a setter inside a
  // state updater, which React is free to run twice. The label is what we chose
  // before the call.
  const [freshGroupLabel, setFreshGroupLabel] = useState<{
    root: string;
    label: string;
  } | null>(null);

  /** "New group", then "New group 2" — never a duplicate label, because two rows
   *  saying one thing cannot be told apart. */
  const nextGroupLabel = (existing: readonly { label: string }[]): string => {
    const taken = new Set(existing.map((group) => group.label));
    if (!taken.has("New group")) return "New group";
    let n = 2;
    while (taken.has(`New group ${n}`)) n++;
    return `New group ${n}`;
  };

  /**
   * GROUP-AXIS DROP. Nothing moves on disk — a group is a label over agents, so
   * the only thing a drop changes is membership. (The Project axis gets a real
   * directory move; that is a different axis with a different contract.)
   *
   * Refused across projects: an arrangement lives in one project's `.sapiom/`,
   * so a group holding an agent from a neighbouring project would be a group
   * with nowhere to be stored.
   */
  const onGroupDrop = (root: string, request: GroupDropRequest): void => {
    const rootAgents = railGroups.agentsIn(root);
    if (!rootAgents.some((workflow) => workflow.path === request.path)) return;
    setFreshGroupLabel(null);
    railGroups.edit(root, rootAgents, (state) =>
      applyGroupDrop(state, request),
    );
  };

  // Live, UNBOUND sessions sitting exactly at a project root. Meaningful only
  // for a project with no agents at all — that row becomes the focus target so
  // its sessions can open as tabs, and can grow its first sapiom.json in place.
  const bareSessionAt = (root: string): HarnessSession | undefined =>
    sessions
      .filter(
        (session) =>
          session.status !== "exited" &&
          session.boundWorkflowPath == null &&
          samePath(session.cwd, root),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      )[0];

  // `projectIsEmpty` is the ONE emptiness answer, and it consults `rootAgent`:
  // a merged root-agent project has nothing in `dirs` or `agents`, so a naive
  // check here would render its agent row underneath "No agents yet".
  const hasAgents = projects.some((project) => !projectIsEmpty(project));
  // A first-run rail (no agents anywhere) promotes the Create-new CTA to the
  // primary style — the one action that gets the user their first agent.
  const isEmpty = !hasAgents && strays.length === 0 && projects.length === 0;
  const nothingToShow = !hasAgents && strays.length === 0;

  return (
    <aside
      ref={railRef}
      className="rail rail-workflows"
      style={{ width, minWidth }}
      {...trackingAttrs({ surface: "agent_rail" })}
    >
      <BrandHeader
        onCollapse={onCollapse}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
      />

      {/* THE NAV IS DESTINATIONS ONLY. Search opens the command palette
          (carrying the unboxed ⌘K / Ctrl+K shortcut) and Templates opens the
          catalog; they read as rows, not a boxed field or a bare magnifier,
          because a destination is not chrome.

          A VERB USED TO LIVE HERE and does not any more. "Create new agent" sat
          as the first row of this list, "Add existing agents" as the last, and
          the Projects header carried a third folder-plus — three controls doing
          folder-or-create work, two of them inside a list of places. IA-REVIEW
          names the rule: "One create verb, `New agent`, as the rail header's
          `+`. Not a row among places: a verb in a list of destinations is the
          F-18 confusion." The verb moved to the header below. Registering a
          folder that already holds agents is a different job and it moved into
          the rail's own ⋮ menu, so it is reachable without competing. */}
      <nav className="rail-nav" aria-label="Primary">
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

      </nav>

      {/* A TITLE, not a control. Folding this header hid the only thing the
          rail is for and left a header sitting on nothing — so it has no
          disclosure of its own. Its two buttons ask two different questions:
          `+` is THE create verb, the ellipsis opens the rail's settings. */}
      <div className="rail-header">
        {/* ALWAYS "Projects". This used to swap to "Groups" on the group axis,
            on the reasoning that a header should name what the list is filed
            by. That reads the tree wrong: the rail lists PROJECTS either way,
            and the axis only changes how they are arranged — so swapping the
            title announced a different subject when the subject had not
            changed, and "Groups" over a list still full of project rows was the
            more misleading of the two. The axis is already stated, on the face
            of the Group-by control that set it. */}
        <span className="rail-header-label">Projects</span>
        <div className="rail-header-actions">
          {/* THE ONE CREATE VERB. It sits to the LEFT OF THE ELLIPSIS, both in
              the trailing group: the label owns the leading edge, and a control
              there made the header read as one more nav button in the stack
              above it rather than as the title of the tree below.

              A PLUS, not a folder-plus. It used to be "Add a project" and what
              it added was a folder, so the glyph was right for the job it had.
              The job changed: this opens the create flow, whose FIRST step is
              where the agent lives (a project you already have, or a folder you
              pick). A folder is now something that flow collects, not the thing
              the control makes.

              One `+` per question still holds — this one makes an agent;
              starting another session is the tab strip's trailing `+`; project
              rows carry none, because a project's Agent Map owns creation
              inside it. */}
          <button
            type="button"
            className={
              "theme-toggle rail-header-btn" + (isEmpty ? " is-empty" : "")
            }
            ref={addProjectTriggerRef}
            data-testid="rail-create-new"
            aria-label="New agent"
            aria-haspopup="menu"
            aria-expanded={newAgentOpen}
            data-tooltip={
              isEmpty ? "New agent — start here" : "New agent"
            }
            onClick={() => {
              setHistoryOpen(false);
              setNewAgentOpen((prev) => !prev);
            }}
          >
            <Icon name="Plus" size={14} />
          </button>
          {/* AN ELLIPSIS, deliberately reversing the design doc's "sliders, not
              an ellipsis". That rule's reasoning was "an ellipsis has no
              subject, so it can only mean more stuff; this panel has exactly
              one". The panel no longer has exactly one: it carries filing
              (Group by / Sort by) AND past sessions, i.e. the rail's settings.
              Once a control genuinely holds more than one subject, the ellipsis
              is the honest glyph and a sliders icon is the misleading one —
              sliders promise filing and nothing else. */}
          <button
            ref={historyTriggerRef}
            className="theme-toggle rail-header-btn"
            data-testid="history-trigger"
            aria-label="Rail settings"
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            data-tooltip="Filing, sorting and past sessions"
            onClick={toggleHistory}
          >
            <Icon name="EllipsisVertical" size={14} />
          </button>
        </div>
      </div>

      {/* WHERE DOES IT LIVE — the create verb's first step.
          Every agent lives somewhere, and the old top control did not ask: it
          opened a composer that invented a folder from a slug of whatever you
          typed. So the first thing this asks is the one thing creation cannot
          proceed without, and it answers it with the places the rail is already
          showing rather than a blank field.
          A popover, not a modal: this is a choice among destinations, and it
          reuses the ⋮ menu's card so the create flow adds no new dialog. */}
      <AnchoredPopover
        open={newAgentOpen}
        anchorRef={addProjectTriggerRef}
        onDismiss={() => setNewAgentOpen(false)}
        placement="right-start"
        besideRef={railRef}
        className="menu-flyer"
        testid="new-agent-menu"
      >
        <div className="connect-card project-row-menu">
          <div className="connect-card-header">
            <span>New agent in</span>
          </div>
          <div className="connect-card-body" role="menu">
            {projects.map((project) => (
              <button
                key={project.root}
                type="button"
                role="menuitem"
                className="session-dropdown-item"
                data-testid={`new-agent-in-${project.label}`}
                title={project.root}
                onClick={() => {
                  setNewAgentOpen(false);
                  void onNewAgentIn(project.root, project.label);
                }}
              >
                <span className="session-item-icon">
                  <Icon name="Folder" size={13} />
                </span>
                <span className="session-item-copy">
                  <span className="session-item-title">{project.label}</span>
                </span>
              </button>
            ))}
            {/* THE WAY OUT, and on desktop it is the OS folder browser rather
                than a dialog of ours — see `pickFolderForNewAgent`. */}
            <button
              type="button"
              role="menuitem"
              className="session-dropdown-item"
              data-testid="new-agent-choose-folder"
              onClick={pickFolderForNewAgent}
            >
              <span className="session-item-icon">
                <Icon name="FolderPlus" size={13} />
              </span>
              <span className="session-item-copy">
                <span className="session-item-title">
                  {projects.length > 0
                    ? "Another folder…"
                    : "Choose a folder…"}
                </span>
              </span>
            </button>
          </div>
        </div>
      </AnchoredPopover>

      <div className="rail-tree">
        {/* The ⋮ overflow menu. The popover is the TRACK, not the card: it
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
                <span>Projects</span>
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
                {/* ADD EXISTING AGENTS, from here rather than from a nav row.
                    Pointing a folder at Studio so it registers what is already
                    in it is a real job and it stays one click deep — but it is
                    not creating anything, and standing it beside the create
                    verb as a peer is what made three controls read as three
                    ways to make an agent. This menu is where the rail's own
                    housekeeping already lives. */}
                <button
                  type="button"
                  role="menuitem"
                  className="session-dropdown-item"
                  data-testid="add-existing-agents"
                  onClick={() => {
                    closeHistory();
                    setStartIntent("register");
                    setStartMode("detect");
                  }}
                >
                  <span className="session-item-icon">
                    <Icon name="FolderPlus" size={13} />
                  </span>
                  <span className="session-item-copy">
                    <span className="session-item-title">
                      Add existing agents
                    </span>
                  </span>
                </button>
                {/* Hovering the fixed choices closes the Past-sessions flyout,
                    so moving off that row collapses its sub-card — the
                    hover-open's natural inverse. (A plain wrapper would flatten
                    the row gap; menu-choice-group re-states the column.) */}
                {/* VISIBLE dropdowns, not a menu of radio rows. Both settings
                    state their current value on the face of the control, so
                    "how is this list filed?" is answerable without opening
                    anything — a radio row only says what is checked once you
                    are already inside the menu you had to guess to open. */}
                <div
                  className="menu-choice-group"
                  onMouseEnter={() => setPastOpen(false)}
                >
                  <label className="filing-field">
                    <span className="filing-field-label">Group by</span>
                    <select
                      className="filing-field-select"
                      data-testid="filing-group-by"
                      value={axis}
                      onChange={(event) =>
                        pickAxis(resolveAxis(event.target.value))
                      }
                    >
                      {RAIL_AXES.map((option) => (
                        <option key={option} value={option}>
                          {AXIS_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="filing-field">
                    <span className="filing-field-label">Sort by</span>
                    <select
                      className="filing-field-select"
                      data-testid="filing-sort-by"
                      value={sort}
                      onChange={(event) =>
                        pickSort(
                          event.target.value === "name" ? "name" : "recent",
                        )
                      }
                    >
                      {(["recent", "name"] as const).map((option) => (
                        <option key={option} value={option}>
                          {SORT_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {/* One row that opens a sub-card beside the menu — the set is
                    unbounded (every session this install has finished), so a
                    list nailed here would give a card of four choices a
                    scrollbar. The count rides the row, not the ⋮ trigger.
                    Opens on hover (moving onto it) as well as click. */}
                <button
                  type="button"
                  className={
                    "session-dropdown-item nested-trigger" +
                    (pastOpen ? " is-open" : "")
                  }
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
                    <span
                      className="session-history-badge"
                      data-testid="session-history-badge"
                    >
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
                                state: sessionRowState({
                                  resumeMode,
                                  turnCount: summary?.turnCount,
                                }),
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
                    {historyLoading && (
                      <div className="session-dropdown-empty">Loading…</div>
                    )}
                    {!historyLoading && pastRows.length === 0 && (
                      <div className="session-dropdown-empty">
                        No past sessions yet
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </AnchoredPopover>

        <div className="rail-list">
          {nothingToShow && projects.length === 0 && (
            <EmptyState
              className="rail-empty"
              icon="Folder"
              title="No agents yet"
              body="Add a project folder to start a session in it. Agents (sapiom.json) anywhere inside it appear here automatically."
            />
          )}

          {projects.map((project) => {
            const collapsed = collapsedKeys.has(projectKey(project.root));
            // The browser never invents graph identities from a path. Join this
            // exact Project-axis root to the opaque key issued by the server.
            // Segment-aware equality matters on Windows and avoids basename
            // collisions between neighbouring projects.
            const workspaceScope = (workspaceScopes ?? []).find((scope) =>
              samePath(scope.cwd, project.root),
            );
            const studioProject = studioProjects?.find(
              (candidate) => candidate.projectId === workspaceScope?.projectId,
            );
            // Current servers issue a durable Studio project for every scope,
            // and that project's Agent Map owns creation. The absent case is a
            // compatibility payload, not a second creation mode. Keep ownership
            // independent of the selected axis so Group cannot restore a bypass.
            const mapOwnsCreation = studioProject != null;
            const planFirst = axis === "project" && mapOwnsCreation;
            const mapSelected =
              planFirst &&
              studioSelection?.kind === "agent-map" &&
              studioSelection.projectId === studioProject.projectId;
            const focusProjectAgent = (path: string): void => {
              const workflow = workflows.find((candidate) =>
                samePath(candidate.path, path),
              );
              const binding = workflow?.studioBindings?.find(
                (candidate) => candidate.projectId === studioProject?.projectId,
              );
              if (planFirst && workflow && binding) {
                revealProject(project.root);
                onSelectStudioAgent(
                  workflow,
                  binding.projectId,
                  binding.agentId,
                );
              } else onFocusAgent(path);
            };
            const pending = pendingCwds.some((cwd) =>
              samePath(cwd, project.root),
            );
            const empty = projectIsEmpty(project);
            const bare = empty ? bareSessionAt(project.root) : undefined;
            // Being created: the folder is known but its session/agent has not
            // landed yet. A focusable, busy placeholder so the in-progress
            // agent stays findable — it self-clears the moment a real agent or
            // session arrives under the same root.
            const creating = pending && empty && bare == null;
            // GROUP AXIS. Every agent this root contains, filed by relationship
            // instead of by directory.
            //
            // Fewer than TWO agents means there is no relationship to file — a
            // group is a relationship, and one agent has none — so those
            // projects keep the Project axis's own anatomy, root-agent merge
            // included, and simply list what they hold. With two or more, the
            // project row becomes a pure SCOPE header (`rootAgent={null}`): on
            // this axis it is the project the arrangement is stored in, not a
            // directory row, so merging an agent into it would put an agent row
            // where a scope header belongs — and the root agent is often the
            // head of the very group being shown.
            const groupAgents =
              axis === "group" ? railGroups.agentsIn(project.root) : [];
            const showGroups = axis === "group" && groupAgents.length > 1;
            const soloAgents = groupAgents.filter(
              (workflow) => workflow.path !== project.rootAgent?.workflow.path,
            );
            const groupNodes = showGroups
              ? railGroups.groupsFor(project.root, groupAgents)
              : [];
            const groupState = railGroups.stateFor(project.root);
            return (
              <div
                key={project.root}
                className="workspace-group"
                data-testid={`workspace-group-${project.label}`}
              >
                <ProjectRow
                  label={project.label}
                  root={project.root}
                  rootAgent={planFirst || showGroups ? null : project.rootAgent}
                  collapsed={collapsed}
                  onToggleCollapsed={() =>
                    toggleCollapsed(projectKey(project.root))
                  }
                  workspaceKey={workspaceScope?.workspaceKey ?? null}
                  selected={
                    mapSelected ||
                    (!planFirst &&
                      workspaceScope?.workspaceKey === selectedWorkspaceKey)
                  }
                  onSelectProject={onSelectWorkspace}
                  focusedAgentPath={focusedAgentPath}
                  onFocusAgent={focusProjectAgent}
                  focusable={creating || bare != null}
                  disclosable={
                    planFirst
                      ? true
                      : axis === "group"
                        ? showGroups || soloAgents.length > 0
                        : project.dirs.length > 0 || project.agents.length > 0
                  }
                  busy={creating}
                  disclosureOnly={planFirst}
                  drag={drag}
                  mainTestid={
                    workspaceScope
                      ? undefined
                      : creating
                        ? `workspace-pending-${project.label}`
                        : bare
                          ? `workspace-focus-${project.label}`
                          : undefined
                  }
                  tooltip={
                    creating
                      ? "Creating agent…"
                      : bare
                        ? "Project with sessions, no agent yet. Focus to work in it."
                        : undefined
                  }
                  trailing={
                    <>
                      {creating && (
                        <span
                          className="workspace-row-spinner"
                          aria-hidden="true"
                        />
                      )}
                      {/* THE MAP, when the row's click is spoken for.
                          A merged root-agent row now opens the AGENT, which is
                          the whole of the B4 fix, so the project's graph needs
                          somewhere else to live on exactly those rows. An
                          unmerged project row keeps the graph on its label and
                          renders no glyph here: one control per question, and a
                          second door to the same place on a row that already
                          leads there would be the duplicate this rail keeps
                          removing. */}
                      {!planFirst &&
                        project.rootAgent &&
                        !showGroups &&
                        workspaceScope?.workspaceKey != null && (
                          <button
                            type="button"
                            className="workspace-row-action"
                            data-testid={`project-map-${project.label}`}
                            aria-label={`Open dependency graph for ${project.label}`}
                            aria-pressed={
                              workspaceScope.workspaceKey ===
                              selectedWorkspaceKey
                            }
                            data-tooltip="Open dependency graph"
                            onClick={() =>
                              onSelectWorkspace(
                                workspaceScope.workspaceKey,
                                project.root,
                                project.label,
                              )
                            }
                          >
                            <Icon name="Waypoints" size={13} />
                          </button>
                        )}
                      {/* ONE CONTROL, and it opens a menu of NAMED actions.
                          `+` and `×` used to sit here side by side: same size,
                          same hover-reveal, adjacent — so they read as a
                          matched pair operating on one subject. They never
                          were. `+` created an AGENT inside the project; `×`
                          removed the PROJECT from the rail. The pair made `+`
                          read as "add project", and the `×` next to it
                          confirmed the misreading rather than correcting it.
                          The same defect had a second form on a bare project,
                          where a Sparkles "scaffold an agent" glyph sat beside
                          the same `×`.

                          A menu fixes the grammar rather than re-tuning the
                          glyphs, because the ambiguity was never in the icons:
                          it was in asking a 13px mark to carry a noun. Every
                          item here states its own subject in words — "Create an
                          agent in acme-app", "Remove acme-app from the rail"
                          — so there is nothing left to infer from adjacency.

                          What is left on the row is a `⋮` and, on a merged
                          root-agent row, the map. Both speak for the project,
                          so no pair on this row spans two nouns any more. */}
                      <ProjectRowMenu
                        label={project.label}
                        create={
                          mapOwnsCreation || creating
                            ? null
                            : bare
                              ? {
                                  kind: "scaffold",
                                  testid: `workspace-scaffold-${project.label}`,
                                  label: `Scaffold an agent in ${project.label}`,
                                  run: () => onScaffoldInSession(bare.id),
                                }
                              : {
                                  kind: "create",
                                  testid: `project-create-agent-${project.label}`,
                                  label: `Create an agent in ${project.label}`,
                                  run: () =>
                                    onCreateAgent(project.root, project.label),
                                }
                        }
                        onRemove={(trigger) => {
                          // Focus returns to the ⋮, not to the menu item that
                          // opened the dialog: that item unmounts with the
                          // popover, and a `triggerRef` pointing at a detached
                          // node restores focus to <body>.
                          removeTriggerRef.current = trigger;
                          setRemoving({
                            root: project.root,
                            label: project.label,
                          });
                        }}
                      />
                    </>
                  }
                />
                {!collapsed && planFirst && studioProject && (
                  <>
                    <AgentMapRow
                      selected={mapSelected}
                      onSelect={() => {
                        revealProject(project.root);
                        onSelectAgentMap(
                          studioProject.projectId,
                          project.root,
                          project.label,
                        );
                      }}
                    />
                    {project.rootAgent && (
                      <WorkflowRow
                        workflow={project.rootAgent.workflow}
                        isFocused={
                          studioSelection?.kind === "agent" &&
                          studioSelection.agentId ===
                            project.rootAgent.workflow.studioBindings?.find(
                              (candidate) =>
                                candidate.projectId === studioProject.projectId,
                            )?.agentId
                        }
                        onFocus={focusProjectAgent}
                        depth={0}
                      />
                    )}
                  </>
                )}
                {/* AN EMPTY LEGACY PROJECT SAYS SO, on its own row.
                    `projectIsEmpty` is the one emptiness answer and it consults
                    `rootAgent` — a merged root-agent project has nothing in
                    `dirs` or `agents` and a naive check would print this line
                    under an agent row. A planner-managed project deliberately
                    renders no direct-create row: its pinned Agent Map is the
                    only route to generating agents. `creating` already has its
                    own spinner, and a bare legacy project with a live session
                    already has its Scaffold affordance, so neither reaches
                    this. */}
                {!collapsed && empty && !creating && bare == null && (
                  <>
                    {!mapOwnsCreation && (
                      <div className="workspace-row is-nested workspace-row-empty">
                        <span
                          className="row-disclosure row-disclosure-static"
                          aria-hidden="true"
                        />
                        <button
                          type="button"
                          className="tree-row tree-row-empty-action"
                          data-testid={`project-empty-${project.label}`}
                          data-tooltip={`Start an agent in ${project.root}`}
                          onClick={() =>
                            onCreateAgent(project.root, project.label)
                          }
                        >
                          <Icon name="Sparkles" size={13} />
                          <span className="tree-row-label">
                            {(unsearchedCheckouts[project.root]?.length ?? 0) >
                            0
                              ? "Create an agent here"
                              : "Create the first agent here"}
                          </span>
                        </button>
                      </div>
                    )}
                    {/* THE BOUNDARY'S OWN ANSWER, when there is one.
                        A scan stops at every separate checkout, so a folder that
                        is not itself a repo but holds several clones finds
                        NOTHING while the agents are right there. Rendering only
                        "Create the FIRST agent here" over that folder states
                        something false, and falsely in the worst direction: it
                        tells the user the agents they can see on disk do not
                        exist. The count is the difference between "there is
                        nothing here" and "I did not look in there". */}
                    {(unsearchedCheckouts[project.root]?.length ?? 0) > 0 && (
                      <div className="workspace-row is-nested">
                        <span
                          className="row-disclosure row-disclosure-static"
                          aria-hidden="true"
                        />
                        <div
                          className="tree-row tree-row-note"
                          data-testid={`project-unsearched-${project.label}`}
                          /* The ROW states the fact; the tooltip carries the
                             remedy and the paths. A 320px rail cannot hold both
                             in one line, and truncating the remedy would leave
                             the fact looking like a dead end. */
                          title={`Open one as its own project to see its agents:\n${unsearchedCheckouts[
                            project.root
                          ]!.join("\n")}`}
                        >
                          <Icon name="GitBranch" size={13} />
                          <span className="tree-row-label">
                            {unsearchedCheckouts[project.root]!.length === 1
                              ? "1 checkout not searched"
                              : `${unsearchedCheckouts[project.root]!.length} checkouts not searched`}
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {!collapsed && axis === "project" && (
                  <ProjectTreeRows
                    dirs={project.dirs}
                    agents={project.agents}
                    depth={0}
                    focusedAgentPath={focusedAgentPath}
                    onFocusAgent={focusProjectAgent}
                    collapsedKeys={collapsedKeys}
                    onToggleCollapsed={toggleCollapsed}
                    drag={drag}
                  />
                )}
                {!collapsed && showGroups && (
                  <GroupSections
                    sectionLabel={project.label}
                    groups={groupNodes}
                    /* Computed over EVERY agent in the project, not per group:
                       two rows collide because they are both on screen, and
                       which group each sits in has nothing to do with it. */
                    prefixes={agentPrefixes(groupAgents, project.root)}
                    editable={railGroups.isReady(project.root)}
                    isDerived={!isMaterialized(groupState)}
                    freshLabel={
                      freshGroupLabel?.root === project.root
                        ? freshGroupLabel.label
                        : null
                    }
                    collapsedKeys={collapsedKeys}
                    onToggleCollapsed={toggleCollapsed}
                    focusedAgentPath={focusedAgentPath}
                    onFocusAgent={onFocusAgent}
                    onCreate={() => {
                      const label = nextGroupLabel(groupNodes);
                      railGroups.edit(project.root, groupAgents, (state) =>
                        createGroup(state, label),
                      );
                      setFreshGroupLabel({ root: project.root, label });
                    }}
                    onRename={(groupId, label) => {
                      setFreshGroupLabel(null);
                      railGroups.edit(project.root, groupAgents, (state) =>
                        renameGroup(state, groupId, label),
                      );
                    }}
                    onDelete={(groupId) => {
                      setFreshGroupLabel(null);
                      railGroups.edit(project.root, groupAgents, (state) =>
                        deleteGroup(state, groupId),
                      );
                    }}
                    onDrop={(request) => onGroupDrop(project.root, request)}
                    onReset={
                      canResetToDetected(groupState)
                        ? () => {
                            setFreshGroupLabel(null);
                            railGroups.reset(project.root);
                          }
                        : undefined
                    }
                    resetCount={
                      isMaterialized(groupState) ? groupState.groups.length : 0
                    }
                  />
                )}
                {/* One agent (or none but a live session) has no relationship to
                    file, so the group axis simply shows what the project holds
                    rather than a group row wrapping a single name. */}
                {!collapsed &&
                  axis === "group" &&
                  !showGroups &&
                  soloAgents.map((workflow) => {
                    const node = agentPrefixes(soloAgents, project.root).get(
                      workflow.path,
                    );
                    return (
                      <WorkflowRow
                        key={workflow.path}
                        workflow={workflow}
                        prefix={node?.prefix ?? ""}
                        prefixFull={node?.prefixFull ?? ""}
                        isFocused={workflow.path === focusedAgentPath}
                        onFocus={onFocusAgent}
                      />
                    );
                  })}
              </div>
            );
          })}

          {/* LAST, ALWAYS. Every project the user chose outranks a folder they
              never opened, and on the Group axis the groups have to be what
              moves when the axis changes — a section that can hold 78 rows
              cannot sit between the user and the thing they just switched to.
              Collapsed by default, and it names its count so a closed row
              still says how much it is holding. */}
          {strays.length > 0 && (
            <UnrootedAgents
              agents={strays}
              collapsed={!collapsedKeys.has(UNROOTED_KEY)}
              onToggleCollapsed={() => toggleCollapsed(UNROOTED_KEY)}
              focusedAgentPath={focusedAgentPath}
              onFocusAgent={onFocusAgent}
              agentPaths={workflowPaths}
              onOpenAsProject={(root) => {
                void onOpenProject(root).catch((err: unknown) => {
                  onToast(
                    err instanceof Error
                      ? err.message
                      : "Couldn't open that folder.",
                  );
                });
              }}
            />
          )}
        </div>
      </div>

      <div className="rail-footer">
        {/* Update card over plan card over account row — all in the SAME
            footer block. The update card exists only while the desktop app
            holds a downloaded update (see the onUpdateState subscription). */}
        {updateReady &&
          (() => {
            const bridge = getDesktopBridge();
            return bridge ? (
              <UpdateCard
                desktop={bridge}
                version={updateReady.version}
                onToast={onToast}
              />
            ) : null;
          })()}
        {/* The plan summary: the server's /api/account/plan relay (MockApi's
            fixture in demo); a view with nothing to state renders nothing. */}
        <PlanCard plan={accountPlan} />
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
          editor={editor}
          onSelectEditor={onSelectEditor}
          onStartAuth={onStartAuth}
          onDisconnect={onDisconnect}
          settingsOpen={settingsOpen}
          onSetSettingsOpen={onSetSettingsOpen}
          overviewSelected={overviewSelected}
          onSelectOverview={onSelectOverview}
        />
      </div>

      {/* THE FOLDER DIALOG, on the web host only for `create`.
          `startIntent` is why it opened, and it decides whether opening the
          folder is the END of the flow (⋮ "Add existing agents": register what
          is in there) or its FIRST STEP (the create verb's folder fallback,
          which continues into `onNewAgentIn`). The dialog itself is unchanged:
          it collects a folder, and the caller says what the folder is for. */}
      {startMode && (
        <StartDialog
          mode={startMode}
          recentDirs={recentDirs}
          launchDir={launchDir}
          projectRoot={projectRoot}
          listDir={listDir}
          onClose={() => setStartMode(null)}
          onConnect={onConnect}
          onOpenProject={async (root) => {
            // ONE OPEN PER CLICK. `onNewAgentIn` opens the folder itself — it
            // has to, since the create verb can be pointed at a folder that is
            // not a project yet — so calling `onOpenProject` first as well ran
            // two `rememberProjectDir` writes and two registry sweeps of the
            // same root, and let the remembered workspace be restored and then
            // immediately overwritten.
            if (startIntent === "create") await onNewAgentIn(root);
            else await onOpenProject(root);
          }}
          onScan={onScanWorkflows}
          /* Escape returns focus to a control that is still MOUNTED. The
             detect dialog is opened from an item inside the ⋮ menu, and that
             menu closes with the click — a `triggerRef` pointing at the item
             would restore focus to <body>, which is the same detached-node bug
             `ProjectRowMenu` documents on its remove item. So the ⋮ itself is
             the trigger for that route. */
          triggerRef={
            startMode === "open" ? addProjectTriggerRef : historyTriggerRef
          }
        />
      )}

      {removing && (
        <RemoveProjectConfirm
          label={removing.label}
          root={removing.root}
          /* Counted from the SAME plan that does the ending, so the number the
             dialog names and the sessions that die cannot drift apart. */
          runningCount={
            planProjectRemoval({ root: removing.root, recentDirs, sessions })
              .endSessionIds.length
          }
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const root = removing.root;
            setRemoving(null);
            void onRemoveProject(root);
          }}
          triggerRef={removeTriggerRef}
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
  editor,
  onSelectEditor,
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
  editor: EditorKind;
  onSelectEditor: (next: EditorKind) => Promise<void>;
  onStartAuth: () => Promise<AuthStartResponse>;
  onDisconnect: () => Promise<void>;
  settingsOpen: boolean;
  onSetSettingsOpen: (open: boolean) => void;
  overviewSelected: boolean;
  onSelectOverview: () => void;
  onToast: (message: string, tone?: ToastTone) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => subscribeTheme(setTheme), []);
  const [authProgress, setAuthProgress] = useState<ProfileAuthProgress>({
    status: "idle",
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeSettings = useCallback(
    () => onSetSettingsOpen(false),
    [onSetSettingsOpen],
  );

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
      // process ALSO re-raises its own update window ("Restart now / Later /
      // Skip this version") — that
      // dialog is the only way to apply one, deliberately (see the desktop app's
      // ipc.ts: page code has no restart channel).
      const result = await desktop.checkForUpdates();
      const view = describeUpdateOutcome(result);
      // Positive terminals (already current, or on disk awaiting a restart)
      // get the green check; in-flight and empty outcomes stay neutral.
      onToast(
        view.text,
        view.tone === "error"
          ? "error"
          : result.kind === "up-to-date" || result.kind === "downloaded"
            ? "success"
            : "info",
      );
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
  const initial = (demo ? "D" : (organizationName ?? "S"))
    .charAt(0)
    .toUpperCase();

  const handleConnectFromMenu = async (): Promise<void> => {
    closeMenu();
    setAuthProgress({ status: "pending" });
    try {
      await onStartAuth();
      // Server returns immediately — auth completes via auth.changed bus message.
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not start sign-in. Try again.";
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
        title={
          demo
            ? "Static demo. No Sapiom account, server, or agent is connected."
            : "Account"
        }
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
          editor={editor}
          onSelectEditor={onSelectEditor}
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
          className={
            "profile-menu-item" + (overviewSelected ? " is-selected" : "")
          }
          data-testid="rail-overview"
          onClick={() => {
            onSelectOverview();
            closeMenu();
          }}
        >
          <Icon name="Info" size={13} />
          Overview
        </button>
        {/* BESIDE Overview, because they answer adjacent questions — "what is
            this app" and "what are these rows" — and a user who has dismissed
            the explainer and wants it back looks where the other explanation
            is. It calls the card directly rather than through a prop: see
            `openHelpOverlay`. */}
        <button
          role="menuitem"
          className="profile-menu-item"
          data-testid="rail-help"
          onClick={() => {
            openHelpOverlay();
            closeMenu();
          }}
        >
          <Icon name="BookOpen" size={13} />
          How Studio is organised
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
          <p
            className="profile-menu-auth-error"
            data-testid="profile-auth-error"
          >
            {authProgress.message}
          </p>
        )}
      </AnchoredPopover>
    </div>
  );
}
