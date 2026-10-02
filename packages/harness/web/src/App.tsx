/**
 * Harness SPA shell (plans/studio-navigation/flow-navigation.md, design.md).
 *
 * Three objects on screen, one mental model:
 *  1. THE RAIL — projects, each with its sessions under it (Project ›
 *     Sessions). One click reaches any session in any project. No agents,
 *     directories or Group axis: agents live on the project's map.
 *  2. THE CENTRE — ONE thing at a time: the selected session's workbench, or
 *     the selected project's Agent Map at full width. Never the two side by
 *     side; the map sharing the width with the chat is what the requester
 *     called out as the important part of the ask.
 *  3. THE RIGHT PANE — only beside a session, and only when that session is
 *     bound to an agent: that agent's Canvas, Steps and Secrets. Closeable,
 *     and the open/closed choice is the user's alone. The canvas stays mounted
 *     behind CSS when another tab is active, or when the pane is closed, so a
 *     running Visualize enrichment is never disturbed.
 *
 * Two values decide all of it, and they are independent on purpose:
 *
 *   The selected SESSION (`harness.activeSessionId`, persisted). Changed only
 *               by a session click, Start chat, a project's `+`, Cmd/Ctrl+N.
 *   The VIEW   (`view`, `lib/centre-pane.ts`): session, a project's map, or an
 *               agent's canvas entered from that map. A project click changes
 *               the view and leaves the selected session alone, so it stays
 *               highlighted in the rail and one click brings it back.
 *
 * What the centre shows is ONE pure function of those (`centrePane`), and
 * which sessions a project lists is ONE function (`lib/rail-sessions.ts`) read
 * by the rail, the shortcut and the map's agent panel.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";
import type {
  AppState,
  CreateSessionRequest,
  HarnessEntry,
  HarnessKind,
  HarnessSession,
  MacroDef,
  SessionSummary,
  WorkflowInfo,
  WorkflowInputContractResponse,
} from "@shared/types";
import type { StudioProjectId } from "@sapiom/agent-map";

import { CanvasPane } from "./components/CanvasPane";
import { AgentMapPane } from "./components/AgentMapPane";
import { createGraphViewportStore } from "./lib/graph-viewport";
import { CommandPalette } from "./components/CommandPalette";
import {
  ConnectivityBanner,
  ConnectivityScreen,
} from "./components/ConnectivityState";
import { McpAuthRestartNotice } from "./components/McpAuthRestartNotice";
import { DeadSessionPane, PastSessionPane } from "./components/DeadSessionPane";
import { EmptyState } from "./components/EmptyState";
import { Icon } from "./components/Icon";
import { SessionBar } from "./components/SessionBar";
import { SessionStepsBar } from "./components/SessionStepsBar";
import { RunSheet } from "./components/RunSheet";
import { TelemetryNotice } from "./components/TelemetryNotice";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { Terminal } from "./components/Terminal";
import { AssistantPane } from "./components/AssistantPane";
import type { ChatDraftStore } from "./components/OpenCodeChat";
import { Toast } from "./components/Toast";
import { TooltipLayer } from "./components/TooltipLayer";
import { NewSessionComposer } from "./components/NewSessionComposer";
import { HelpOverlay } from "./components/HelpOverlay";
import {
  ProjectFolderDialog,
  type ProjectFolderIntent,
} from "./components/ProjectFolderDialog";
import { chooseProjectFolder } from "./lib/folder-step";
import {
  SETUP_CARD,
  deriveAgentName,
  planningInstructions,
  templateIdea,
} from "./lib/creation-entry";
import { NoProjectHome } from "./components/NoProjectHome";
import { OverviewModal } from "./components/OverviewModal";
import { WorkflowsRail, type RailProject } from "./components/WorkflowsRail";
import { MapAgentPanel } from "./components/MapAgentPanel";
import { ProjectAgentGrid } from "./components/ProjectAgentGrid";
import {
  NoSessionSelected,
  ProjectView,
  projectMapMode,
} from "./components/CentrePane";
import { RemoveProjectConfirm } from "./components/RemoveProjectConfirm";
import { boundWorkflowPathOf, createApi, errorMessage } from "./lib/api";
import { classifyConnectivity, useConnectivity } from "./lib/connectivity";
import { historyDirs } from "./lib/history-meta";
import {
  basenameOf,
  isWithinDir,
  joinPath,
  parentOf,
  samePath,
} from "./lib/paths";
import { agentBelongsToProjectRoot } from "./lib/project-tree";
import { planProjectRemoval } from "./lib/project-membership";
import { refuseMove } from "./lib/agent-move";
import {
  canvasSourceFor,
  mergeSubjectRuns,
  projectRootForAgent,
  rootContains,
  runsForSubject,
  selectedRunForSubject,
  shownRunForSubject,
} from "./lib/session-scope";
import {
  railSessions,
  sessionForShortcut,
  sessionMark,
  sessionsForAgent,
} from "./lib/rail-sessions";
import {
  centrePane,
  hasRightPane,
  shownProjectId,
  type CentreView,
} from "./lib/centre-pane";
import { studioScopeForAgent } from "./lib/agent-map";
import { inputContractFromCanvasGraph } from "./lib/run-input";
import { agentUrl } from "./lib/urls";
import {
  getDesktopBridge,
  type DeepLinkAgentTarget,
  type DeepLinkTarget,
} from "./lib/desktop";
import { deepLinkFromSearch } from "./lib/deep-link";
import { editorLabel, editorUrl, resolveEditor } from "./lib/editors";
import { CloneAgentConfirm } from "./components/CloneAgentConfirm";
import {
  cloneDefinitionPrompt,
  type GalleryTemplate,
  type StudioTemplate,
} from "./lib/templates";
import { track } from "./lib/track";
import { initAnalytics, syncHarnessKind } from "./lib/analytics/posthog";
import {
  registerViewContext,
  track as trackProduct,
} from "./lib/analytics/events";
import type { HarnessView } from "./lib/analytics/journeys";
import { resolveMacroUrl } from "./lib/macro-gating";
import { directActionKind } from "./lib/macro-actions";
import { describeWorkflowPrompt } from "./lib/describe-prompt";
import { sessionDisplayName } from "./lib/session-name";
import type { PaletteAction } from "./lib/palette";
import { toggleTheme } from "./lib/theme";
import { loadUiPrefs, saveUiPrefs } from "./lib/ui-prefs";
import {
  DEFAULT_HARNESS,
  FALLBACK_HARNESSES,
  isHarnessSelectable,
  orderHarnesses,
} from "./lib/harness-registry";
import {
  useNavigationHistory,
  type NavigationVisit,
} from "./lib/navigation-history";
import {
  type NewSessionAttachment,
} from "./lib/new-session-attachments";
import {
  CANVAS_MIN,
  RAIL_MIN,
  isMobileShell,
  useMobileShell,
  usePaneWidths,
} from "./lib/use-pane-widths";
import {
  useHarnessState,
  type ObservedRun,
  type RunTarget,
} from "./lib/use-harness-state";
import { useAgentMapEntry } from "./lib/use-agent-map-entry";
import { agentMapLoader } from "./lib/agent-map-loader";
import type { AgentMapWorkspaceResponse } from "@sapiom/agent-map";
import {
  deploymentStateLabel,
  deploymentStateTitle,
  isWorkflowRunnable,
  prodRunBlockedToast,
  workflowDeploymentState,
} from "./lib/workflow-deployment";
import { SecretsPanel } from "./components/SecretsPanel";

type RightTab = "canvas" | "steps" | "secrets";

/**
 * The roots this install knows it has opened: the fallback answer to "where
 * does a session for this agent boot" when no server scope owns the agent.
 *
 * `launchDir` is included because a first boot records the launch directory
 * before `recentDirs` has it, and that is exactly the session whose cwd
 * matters most. Session cwds are deliberately NOT roots: a session an older
 * build left rooted in an agent's own folder would then be the longest "root"
 * containing that agent, and SAP-2927's bug would resolve itself straight back
 * into place. There is no default parent for new agents any more (Q8): an
 * agent is created inside a project the user opened, so nothing here has to
 * guess at one.
 */
const knownRootsOf = (
  recentDirs: readonly string[] | undefined,
  launchDir: string | null | undefined,
): string[] => [...(recentDirs ?? []), ...(launchDir ? [launchDir] : [])];

/**
 * A layer the COMMAND PALETTE must not open on top of.
 *
 * `.modal-backdrop` leads because it is the one thing every overlay in this app
 * actually has, and because `CommandPalette` itself carries no `role` — a
 * role-only selector (the shape the Escape handler below uses) cannot see it,
 * so a guard written that way looks correct and detects nothing.
 *
 * THE OVERVIEW IS CARVED OUT, and it is not an oversight: the palette is
 * deliberately reachable by shortcut while the Overview is up, and navigating
 * from it dismisses the Overview rather than stacking behind it. That is a
 * written contract with a spec behind it — `welcome.spec.ts`'s "the palette's
 * Browse templates, opened over the Overview, leaves it (never stacks)". The
 * Overview wears both `role="dialog"` and `aria-modal="true"`, so excluding it
 * has to be done on each clause rather than by dropping a class from the list.
 *
 * THE HELP CARD IS NOT CARVED OUT, although it wears `.overview-modal` too:
 * that class is `OverviewModal`'s visual recipe, shared by `HelpOverlay`
 * ("How Studio is organised"), and the help card has no contract with the
 * palette. Navigating from the palette does not dismiss it, so the palette
 * would stack over it exactly as it did over a dialog. Its own class leads the
 * list so the per-clause carve-out below cannot let it through.
 *
 * DELIBERATELY NOT the dialog shell's layer selector. That one answers "which
 * layer owns Tab", where the Overview IS a layer and belongs in the list. This
 * one answers "may ⌘K open here", where it does not. Same shape, different
 * question; collapsing them would break the contract above.
 */
const PALETTE_BLOCKING_LAYER_SELECTOR = [
  ".modal-backdrop",
  ".help-overlay",
  '[role="dialog"]:not(.overview-modal)',
  '[role="alertdialog"]:not(.overview-modal)',
  '[aria-modal="true"]:not(.overview-modal)',
].join(",");

/**
 * The project an agent's map lives in: the scope that owns it by its
 * server-issued binding, else the most specific open root containing it. Null
 * for an agent outside every open project, which is on no map.
 */
const projectIdForAgent = (
  agentPath: string,
  state: Pick<AppState, "workflows" | "workspaceScopes" | "studioProjects"> | null | undefined,
): StudioProjectId | null => {
  if (!state) return null;
  const workflow = state.workflows.find((candidate) =>
    samePath(candidate.path, agentPath),
  );
  if (!workflow) return null;
  const scopes = state.workspaceScopes ?? [];
  // A server without durable Studio projects still issues each scope an id:
  // the longest open root that holds the agent, under the rule the rail used
  // to file agents by.
  return (
    studioScopeForAgent(workflow, scopes, state.studioProjects ?? [])
      ?.projectId ??
    scopes
      .filter((scope) => agentBelongsToProjectRoot(workflow, scope.cwd, scopes))
      .sort((a, b) => b.cwd.length - a.cwd.length)[0]?.projectId ??
    null
  );
};

/**
 * How long a held initial prompt waits for the coding agent to become ready
 * (i.e. the user to finish any sign-in, trust, or onboarding step) before we
 * give up and surface the failure. The normal end of a hold is the session
 * going ready (prompt sent) or exiting — this is only a leak-guard for setup
 * the user walks away from.
 */
const HELD_PROMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * Grace before nudging the user toward the terminal. A ready agent reports
 * within a beat, so its held prompt sends before this fires and no hint shows;
 * only a session still stuck on sign-in, trust, or onboarding survives the
 * grace and surfaces the hint.
 */
const HELD_PROMPT_HINT_DELAY_MS = 4_000;

/** Where the new-agent screen is creating, as the rail labels it. */
interface ComposerProject {
  root: string;
  label: string;
  /** The durable Studio project id, when the server has minted one. */
  projectId: StudioProjectId | null;
  /** The template the screen opens with as its idea, if Use brought us here. */
  template: StudioTemplate | null;
  /** Which template surface Use was pressed on; the product metric names it. */
  templateSurface?: "welcome" | "template_gallery" | "template_detail";
}

interface CreateSessionAtOptions {
  initialPrompt?: CreateSessionRequest["initialPrompt"];
  initialAttachments?: CreateSessionRequest["initialAttachments"];
  initialSources?: CreateSessionRequest["initialSources"];
  initialSetup?: CreateSessionRequest["initialSetup"];
  /** Keep the new-agent screen mounted while inline files are materialized. */
  keepComposerOpen?: boolean;
  /** The caller already owns the session's first real user-authored turn. */
  initialUserInputPending?: boolean;
  /**
   * False when the caller binds the session before anyone sees it (Start chat,
   * design.md I6): the centre stays where it is and the session is selected
   * only once its binding lands. Default true: the new session is the centre.
   */
  select?: boolean;
  /** Runs as soon as the POST names the exact session. */
  onCreated?: (session: HarnessSession) => void;
}

/**
 * The one API client the shell reaches for directly.
 *
 * `use-harness-state` exposes every other call as a prop; the workflow-keyed
 * canvas board (IA-01) is read here instead because that hook is owned by
 * another slice of the rail rebuild this week. It belongs beside
 * `getWorkflowInputContract` in the store and should move there — module-level
 * like `use-account-plan`'s, so mock mode still holds ONE fixture instance.
 */
const shellApi = createApi();

export const App = (): JSX.Element => {
  const harness = useHarnessState();
  // A project map remounts when browsing another project or agent. Keep its
  // viewport for this signed-in UI lifetime, without persisting map data.
  const agentMapViewportStore = useMemo(
    createGraphViewportStore,
    [harness.authRevision],
  );
  const [assistantAuthorityRevision, setAssistantAuthorityRevision] = useState<
    string | null
  >(null);
  // Draft text belongs to a principal + Studio session, not to whichever
  // centre-pane branch happens to be mounted. An auth barrier replaces this
  // whole store; an app reload intentionally drops it rather than persisting
  // sensitive, unsent text.
  const assistantDrafts = useMemo<ChatDraftStore>(
    () => new Map(),
    [assistantAuthorityRevision, harness.authRevision, harness.bootToken],
  );
  // Successful session deletion removes its keyed draft. Exited sessions stay
  // in state (and keep their draft) until the user actually closes them.
  useEffect(() => {
    if (!harness.state) return;
    const sessionIds = new Set(harness.state.sessions.map(({ id }) => id));
    for (const id of assistantDrafts.keys()) {
      if (!sessionIds.has(id)) assistantDrafts.delete(id);
    }
  }, [assistantDrafts, harness.state]);
  const [selectedHarness, setSelectedHarness] = useState<HarnessKind>(
    () => loadUiPrefs().preferredHarness ?? DEFAULT_HARNESS,
  );
  const [harnessEntries, setHarnessEntries] = useState<HarnessEntry[] | null>(
    null,
  );
  // Keep the selection above the composer so every template entry point sees
  // automatic corrections and choices that could not be saved to preferences.
  useEffect(() => {
    let cancelled = false;
    harness
      .listHarnesses()
      .then((registry) => {
        if (cancelled || registry.length === 0) return;
        setHarnessEntries(orderHarnesses(registry));
        const selectable = registry.filter(isHarnessSelectable);
        setSelectedHarness((current) =>
          selectable.some((entry) => entry.id === current)
            ? current
            : ((selectable[0]?.id as HarnessKind | undefined) ?? current),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [harness.listHarnesses]);
  useEffect(() => {
    saveUiPrefs({ preferredHarness: selectedHarness });
  }, [selectedHarness]);
  // Live browser connectivity (navigator.onLine + online/offline events).
  // Combined with the boot-error kind below to pick the honest shell state.
  const online = useConnectivity();
  const isMobile = useMobileShell();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runRequest, setRunRequest] = useState<{
    workflow: WorkflowInfo;
    target: RunTarget;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const visibleInputContractsRef = useRef(
    new Map<string, WorkflowInputContractResponse>(),
  );
  const loadRunInputContract = useCallback(
    async (workflowPath: string): Promise<WorkflowInputContractResponse> => {
      const fallback = visibleInputContractsRef.current.get(workflowPath);
      try {
        const fresh = await harness.getWorkflowInputContract(workflowPath);
        return fresh.status === "unavailable" && fallback ? fallback : fresh;
      } catch (error) {
        if (fallback) return fallback;
        throw error;
      }
    },
    [harness.getWorkflowInputContract],
  );
  // The composer-first "new session" home. `composing` holds it open for
  // explicit Create-new intent or a submission from the automatic home.
  // The home also shows whenever nothing else claims the centre pane.
  const [composing, setComposing] = useState(false);
  /**
   * THE PROJECT THE NEW-AGENT SCREEN IS CREATING IN (flow-creation.md §4.3).
   *
   * Both entrances set it: New project after its folder step, and a project
   * row's New agent. The screen STATES it, never asks for it; the folder was
   * chosen before the screen opened. A template carried here is the idea the
   * screen opens with (template Use routes through this screen, CF-D11).
   */
  const [composerProject, setComposerProject] = useState<ComposerProject | null>(
    null,
  );
  // The stated project lives exactly as long as the scoped screen does. Every
  // exit (submit, Back, opening a session or a map) ends with `composing`
  // false, and the automatic home that may show afterwards must not inherit a
  // project nobody chose for it: its submit would create there.
  useEffect(() => {
    if (!composing) setComposerProject(null);
  }, [composing]);
  /**
   * The web half of the folder step, while it is open. Desktop never sets it:
   * the bridge's `chooseDirectory` answers the question directly (D29). What
   * happens after the folder is the intent's: New project continues to the
   * new-agent screen, Add project stops once the folder is in the rail.
   */
  const [folderPrompt, setFolderPrompt] = useState<{
    intent: ProjectFolderIntent;
    template: StudioTemplate | null;
    /** The control that ran the step, so Escape hands focus back to it. */
    trigger: HTMLElement | null;
  } | null>(null);
  /**
   * The planning instructions each new agent's first session was set up with
   * (flow-creation.md §4.4 step 3): shown as a quiet setup disclosure above
   * the terminal, never as the user's words. Held for this page's lifetime;
   * the pty already received the text, so nothing is lost on reload except
   * the disclosure itself.
   */
  const [setupBySession, setSetupBySession] = useState<Map<string, string>>(
    () => new Map(),
  );
  /** An agent the screen created whose first session failed to start; the
   *  next submit of the same idea in the same project reuses it. */
  const scaffoldedButUnstartedRef = useRef<{
    root: string;
    name: string;
    path: string;
  } | null>(null);
  /**
   * WHAT THE CENTRE IS POINTED AT (design.md §1, the View slot): the selected
   * session, a project's Agent Map, or an agent's canvas entered from that map.
   *
   * ONE slot. It replaced three that had to agree (a durable map selection, an
   * unresolved project, and a focused agent path), and every door had to clear
   * the right subset of them: a project click that forgot one put another
   * project's "no running session" state beside this project's map. The
   * selected session is NOT in here (`harness.activeSessionId`): a project or
   * agent click never writes it, so it stays highlighted in the rail and one
   * click brings it back (flow-navigation.md 4.3.2).
   */
  const [view, setView] = useState<CentreView>({ kind: "session" });
  /** Exited sessions hidden from the rail with `×` (flow Q4); History keeps
   *  them. Persisted beside the session renames. */
  const [hiddenSessionIds, setHiddenSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(loadUiPrefs().hiddenSessionIds ?? []),
  );
  /** The agent whose panel is open on the map, by path (flow 4.4). */
  const [mapPanelPath, setMapPanelPath] = useState<string | null>(null);
  /**
   * Sessions a Start chat created and has not bound yet. The rail leaves them
   * out until the binding lands, so a chat started FROM an agent never shows,
   * even for a frame, as an unbound session (design.md I6: `POST /sessions`
   * takes no agent, so create and bind are two requests).
   */
  const [pendingBindIds, setPendingBindIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Start chat is a one-at-a-time create/bind transaction. State renders the
  // pending button; the ref closes React's same-frame double-click window.
  const [startChatPending, setStartChatPending] = useState(false);
  const startChatPendingRef = useRef(false);
  /**
   * The clock the rail's marks and relative times read. A session quiet for ten
   * minutes turns idle without any event arriving, and "2m ago" must not read
   * "2m ago" an hour later, so the shell ticks it rather than each row.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  /**
   * Bumped by every navigation. An async door (an empty project's map read,
   * a project being opened) compares against it before landing, so a click
   * made while it was pending is never overridden by a late answer.
   */
  const navGenerationRef = useRef(0);
  /**
   * A project clicked before its durable identity reached the scope catalog.
   * The click refreshes the catalog, and its map opens when the id lands,
   * unless another navigation happened in between.
   */
  const [pendingProject, setPendingProject] = useState<{
    root: string;
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!pendingProject) return;
    if (pendingProject.generation !== navGenerationRef.current) {
      setPendingProject(null);
      return;
    }
    const projectId = harness.state?.workspaceScopes?.find((scope) =>
      samePath(scope.cwd, pendingProject.root),
    )?.projectId;
    if (!projectId) return;
    setPendingProject(null);
    setView({ kind: "project", projectId });
  }, [pendingProject, harness.state?.workspaceScopes]);
  const viewProjectId = view.kind === "session" ? null : view.projectId;
  /** The centre map's full view. Its own flag, so leaving the map can never
   *  hand an expanded frame to the right pane's canvas. */
  const [mapExpanded, setMapExpanded] = useState(false);
  useEffect(() => {
    if (view.kind !== "project") setMapExpanded(false);
  }, [view.kind]);
  const agentMapEntry = useAgentMapEntry({
    projectId: viewProjectId,
    api: harness.api,
    subscribeProposalChanges: harness.subscribeAgentMapProposalChanges,
    subscribeInitializationChanges: harness.subscribeAgentMapInitializationChanges,
    subscribeReconnects: harness.subscribeEventReconnects,
  });
  /** The project whose Remove-from-the-rail confirm is open (the map
   *  header's ×), and the control focus returns to when it closes. */
  const [removing, setRemoving] = useState<{ root: string; label: string } | null>(
    null,
  );
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // "Open in Studio" deep links (sapiom://agent/<id>). The applier is a ref
  // because it needs `state`/`openAgentCanvas`, which exist only past the loading
  // guard; the effects below reach it through the ref. The cold-start target rides
  // in on the ?agent=/?template= load-URL param; warm links come via the desktop bridge.
  const applyDeepLinkRef = useRef<((target: DeepLinkTarget) => void) | null>(
    null,
  );
  const focusExistingRef = useRef<((definitionId: string) => boolean) | null>(
    null,
  );
  const bindClonedRef = useRef<((definitionId: string) => boolean) | null>(
    null,
  );
  const openSessionRef = useRef<((sessionId: string) => void) | null>(null);
  const coldDeepLinkRef = useRef<DeepLinkTarget | null>(deepLinkFromSearch());
  const coldDeepLinkHandledRef = useRef(false);
  // A clone kicked off from a remote-only deep link: focus the agent once the
  // workspace rescan surfaces it locally.
  const pendingCloneFocusRef = useRef<string | null>(null);
  // The remote-only agent a deep link is offering to clone (drives the confirm).
  const [cloneRequest, setCloneRequest] = useState<DeepLinkAgentTarget | null>(
    null,
  );
  // A template a deep link asked to open (`sapiom://templates/<id>`): the id is
  // handed to the templates browser, which resolves it against the live catalog
  // and opens its detail. Null when no template deep link is pending.
  const [deepLinkTemplateId, setDeepLinkTemplateId] = useState<string | null>(
    null,
  );
  // Lifted so the telemetry chip in the session bar can open the settings
  // popover from outside SessionBar's own gear button.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const signInForAssistant = useCallback(() => {
    void harness.startAuth().catch((error) => {
      harness.showToast(errorMessage(error, "Could not start sign-in."));
    });
  }, [harness.showToast, harness.startAuth]);
  // Right tab is part of the held arrangement: restored on reload.
  // Guard against a stored value for a tab that no longer exists ("skills",
  // and now "code" — its snippets moved to the deploy surface) — fall back to
  // canvas rather than rendering nothing.
  const [rightTab, setRightTab] = useState<RightTab>(() => {
    const stored = loadUiPrefs().rightTab;
    return stored === "canvas" || stored === "steps" || stored === "secrets"
      ? stored
      : "canvas";
  });
  // A PAST session under review: picked from the history menu, shown
  // in the terminal slot as a review pane — resuming/starting is the pane's
  // explicit action, never a side effect of the click that got here.
  const [reviewSummary, setReviewSummary] = useState<SessionSummary | null>(
    null,
  );
  // Template gallery opened from the command palette (browse is reachable
  // from anywhere, not only the add dialog / welcome panel entries).
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // The Overview: an introduction to the app, opened from the account menu's
  // "Overview" item. A full-width destination like Templates (never the
  // composer it used to alias), cleared by any navigation the same way.
  const [overviewOpen, setOverviewOpen] = useState(false);
  // User session renames (no server rename endpoint yet, so names persist
  // client-side with the rest of the UI arrangement). State
  // here so the rail and the header re-render together on a rename.
  const [sessionNames, setSessionNames] = useState<Record<string, string>>(
    () => loadUiPrefs().sessionNames ?? {},
  );
  const renameSession = (id: string, name: string): void => {
    setSessionNames((prev) => {
      const next = { ...prev };
      const trimmed = name.trim();
      if (trimmed) next[id] = trimmed;
      else delete next[id];
      saveUiPrefs({ sessionNames: next });
      return next;
    });
  };

  // Session-then-prompt flows (scaffold, templates, clone) must NOT fire the
  // first prompt while the coding agent is still on its own login/onboarding
  // screen. Claude Code only becomes injectable once its SessionStart hook
  // sets session.ready — and that hook does not fire until the user is signed
  // in. So we HOLD the prompt keyed by session id and send it the moment the
  // session reports ready, rather than racing a fixed retry window that expires
  // mid-onboarding and silently drops the prompt (the reported first-run bug).
  const pendingPromptsRef = useRef<
    Map<
      string,
      { prompt: string; failMessage: string; timer: number; hintTimer: number }
    >
  >(new Map());
  // Latest sessions, read from the hold's async continuation (a closure over
  // `state` would go stale between the ready flip and the flush).
  const sessionsRef = useRef<HarnessSession[]>([]);

  // Forget a held prompt and stop both its timers. Returns the entry so a
  // caller can act on it (send / report), or undefined if nothing was held.
  const clearPending = useCallback((sessionId: string) => {
    const pending = pendingPromptsRef.current.get(sessionId);
    if (!pending) return undefined;
    window.clearTimeout(pending.timer);
    window.clearTimeout(pending.hintTimer);
    pendingPromptsRef.current.delete(sessionId);
    return pending;
  }, []);

  // Deliver a held prompt if its session is now ready; drop it (with the
  // failure toast) if the session exited first. A no-op while still waiting.
  const tryFlushPrompt = useCallback(
    (sessionId: string): void => {
      const pending = pendingPromptsRef.current.get(sessionId);
      if (!pending) return;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return; // not in client state yet — a later session.status retries
      if (session.ready) {
        // Delete BEFORE injecting so an overlapping flush can't double-send.
        clearPending(sessionId);
        void harness
          .injectInput(sessionId, pending.prompt)
          .catch(() => harness.showToast(pending.failMessage));
      } else if (session.status === "exited") {
        clearPending(sessionId);
        harness.showToast(pending.failMessage);
      }
    },
    [clearPending, harness.injectInput, harness.showToast],
  );

  // Register a prompt to be sent once its coding agent is ready. Sends
  // immediately if already ready. While waiting, a delayed hint (only if the
  // session is still not ready after a grace) points the user at terminal
  // setup — so first-run intent is held, not lost.
  const sendPromptWhenReady = useCallback(
    (sessionId: string, prompt: string, failMessage: string): void => {
      clearPending(sessionId);
      const timer = window.setTimeout(() => {
        if (clearPending(sessionId)) harness.showToast(failMessage);
      }, HELD_PROMPT_TIMEOUT_MS);
      const hintTimer = window.setTimeout(() => {
        if (pendingPromptsRef.current.has(sessionId)) {
          harness.showToast(
            "Finish signing in or dismiss any trust or setup prompt in the terminal — your prompt sends automatically once the coding agent is ready.",
          );
        }
      }, HELD_PROMPT_HINT_DELAY_MS);
      pendingPromptsRef.current.set(sessionId, {
        prompt,
        failMessage,
        timer,
        hintTimer,
      });
      tryFlushPrompt(sessionId);
    },
    [clearPending, harness.showToast, tryFlushPrompt],
  );

  // The ready/exited transition arrives as a session.status event → a new
  // sessions array → this effect flushes any prompt whose session just became
  // injectable. Event-driven, so no polling.
  useEffect(() => {
    sessionsRef.current = harness.state?.sessions ?? [];
    if (pendingPromptsRef.current.size === 0) return;
    for (const id of [...pendingPromptsRef.current.keys()]) tryFlushPrompt(id);
  }, [harness.state?.sessions, tryFlushPrompt]);
  // Panel collapse: the rail unmounts (no state to preserve); the right pane
  // hides via CSS so a running Visualize enrichment survives the collapse.
  const [railCollapsed, setRailCollapsed] = useState(
    () => isMobileShell() || (loadUiPrefs().railCollapsed ?? false),
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    () => isMobileShell() || (loadUiPrefs().rightCollapsed ?? false),
  );
  // Right-surface full-screen expand — lifted here so its control sits next to
  // the collapse-panel toggle in the shared tab bar. The right pane's
  // CanvasPane lifts its own frame without remounting the graph.
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const toggleCanvasExpanded = useCallback(
    () => setCanvasExpanded((value) => !value),
    [],
  );

  // Back/forward across every screen the shell can show. The stack is fed by
  // the place the shell IS (derived below), not by instrumenting each door, so
  // a new way into a view is navigable the day it lands.
  const navHistory = useNavigationHistory();

  const {
    widths,
    canvasResizing,
    railResizing,
    startRailDrag,
    startCanvasDrag,
    resetRail,
    resetCanvas,
  } = usePaneWidths();
  // The canvas slides open/shut by animating its grid column to/from 0 (the
  // transition is always-on in refine.css). During that slide the pane's content
  // must NOT reflow (squish) with the moving column — so a ResizeObserver keeps a
  // --rp-w custom property equal to the pane's settled EXPANDED width, and while
  // `paneSliding` is set the content is pinned to --rp-w and right-aligned, so a
  // shrinking column CLIPS it from the left (a drawer slide) rather than squeezing
  // it, and a growing one REVEALS it the same way. Once the slide ends the pin
  // drops: the collapsed pane's content truly goes to zero (reads as hidden), and
  // an expanded pane's content tracks the column again (window resize / drag).
  // --rp-w is frozen for the length of a slide so it holds the pre-slide width in
  // both directions.
  const [paneSliding, setPaneSliding] = useState(false);
  const rightCollapsedRef = useRef(false);
  const paneSlidingRef = useRef(false);
  const paneElRef = useRef<HTMLDivElement | null>(null);
  const rightPaneTriggerRef = useRef<HTMLButtonElement | null>(null);
  const paneObserverRef = useRef<ResizeObserver | null>(null);
  const captureExpandedWidth = useCallback(
    (el: HTMLDivElement | null): void => {
      if (el && !rightCollapsedRef.current)
        el.style.setProperty("--rp-w", `${el.offsetWidth}px`);
    },
    [],
  );
  const setRightPaneEl = useCallback(
    (el: HTMLDivElement | null) => {
      paneObserverRef.current?.disconnect();
      paneElRef.current = el;
      if (!el) {
        paneObserverRef.current = null;
        return;
      }
      // Track the expanded width on live resizes (window, rail drag), but NOT
      // mid-slide — the guard freezes --rp-w so the content clips at the pre-slide
      // width. A slide's own resizes are therefore skipped, which is why the
      // slide-end effect below re-captures the settled width.
      const observer = new ResizeObserver(() => {
        if (!paneSlidingRef.current) captureExpandedWidth(el);
      });
      observer.observe(el);
      paneObserverRef.current = observer;
    },
    [captureExpandedWidth],
  );
  rightCollapsedRef.current = rightCollapsed;
  paneSlidingRef.current = paneSliding;

  // Mark the slide as in flight whenever the collapse state flips, so refine.css
  // pins the content (via .canvas-sliding) for the transition's length. Only the
  // collapse/expand toggle animates; a resize-handle drag/reset (no collapse flip)
  // stays instant. ~260ms covers the 0.22s transition plus a small buffer; when it
  // clears we re-capture the settled EXPANDED width into --rp-w (the observer
  // skipped the slide's own resizes, and after an expand settles there is no
  // further resize to trigger one) so the NEXT collapse pins to the right width.
  useLayoutEffect(() => {
    if (isMobile) return;
    setPaneSliding(true);
    const timer = window.setTimeout(() => {
      setPaneSliding(false);
      captureExpandedWidth(paneElRef.current);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [rightCollapsed, isMobile, captureExpandedWidth]);

  // Cmd+K (any platform) or Cmd/Ctrl+P — "jump to" like Cmd+P in Cursor/VS Code.
  // Cmd/Ctrl+1..9 selects the Nth session of the SELECTED project in rail
  // order (flow-navigation.md Q2): the project whose map is showing, else the
  // selected session's project. Resolved by the same module the rail renders
  // from, so a number key can never address a row the rail is not showing.
  // The strip this replaced kept its own copy of that filter here, and the two
  // drifted the moment a project was selected over an exited session.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if (key === "escape" && isMobile && !rightCollapsed) {
        // The nearest open layer owns Escape. Dismissable menus/dialogs mark
        // the event handled at document; App-owned overlays are guarded by
        // state so their own focus restoration wins over the sheet trigger.
        if (
          e.defaultPrevented ||
          paletteOpen ||
          settingsOpen ||
          templatesOpen ||
          overviewOpen ||
          document.querySelector(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]',
          )
        ) {
          return;
        }
        e.preventDefault();
        setRightCollapsed(true);
        window.requestAnimationFrame(() =>
          rightPaneTriggerRef.current?.focus(),
        );
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "p")) {
        // A LAYER ON TOP SWALLOWS THE SHORTCUT. Unguarded, ⌘K stacked the
        // palette over an open dialog and native Tab then walked out of the
        // palette into the dialog behind it. A surface cannot contain focus for
        // a surface it does not own, so the fix is here rather than in either.
        // See the selector for what it excludes and why it is not the dialog
        // shell's list.
        //
        // PREVENTED, THEN DROPPED — never returned unhandled. This handler owns
        // ⌘P as well as ⌘K, and ⌘P is the browser's PRINT shortcut: returning
        // early without preventing it opened a native print preview over the
        // dialog, which is worse than the stacking it was added to stop. The
        // shortcut does nothing here, exactly as it did nothing before.
        if (document.querySelector(PALETTE_BLOCKING_LAYER_SELECTOR)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const target = sessionForShortcut(Number(e.key), {
          sessions: harness.state?.sessions ?? [],
          hidden: hiddenSessionIds,
          now: Date.now(),
          shownProjectId: viewProjectId,
          activeSessionId: harness.activeSessionId,
        });
        if (target) {
          e.preventDefault();
          openSessionRef.current?.(target.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    harness.state?.sessions,
    harness.activeSessionId,
    hiddenSessionIds,
    viewProjectId,
    isMobile,
    rightCollapsed,
    paletteOpen,
    settingsOpen,
    templatesOpen,
    overviewOpen,
  ]);

  // Opening the palette loads history for the same directories the rail's
  // popover asks for — one shared builder, so whichever opens second
  // coalesces against the first instead of re-fetching every directory.
  useEffect(() => {
    if (!paletteOpen || !harness.state) return;
    const dirs = historyDirs(
      harness.state.sessions,
      harness.settings?.recentDirs ?? [],
      harness.activeSessionId,
    );
    if (dirs.length > 0) void harness.loadHistory(dirs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen]);

  // Client PostHog (SAP-1988): init once state is known and re-sync identity +
  // consent whenever they change. initAnalytics is idempotent and gates itself
  // on the two consent tiers, so this is safe to call on every relevant change.
  const st = harness.state;
  useEffect(() => {
    if (st) initAnalytics(st);
  }, [
    st,
    st?.authenticated,
    st?.userId,
    st?.tenantId,
    st?.consentSource,
    st?.productAnalyticsOptIn,
    st?.version,
  ]);

  // Stamp the current journey + view as PostHog super-properties so autocapture
  // clicks group by arc of intent (the harness's replacement for the web app's
  // pathname-derived journey — it has no router).
  useEffect(() => {
    if (!st) return;
    const active = st.sessions.find(
      (session) => session.id === harness.activeSessionId,
    );
    const view: HarnessView = {
      firstRun: st.firstRun === true,
      settingsOpen,
      templatesOpen,
      hasLiveSession: st.sessions.some(
        (session) => session.status !== "exited",
      ),
      // Reviewing a finished session (active session has exited) is the observe
      // arc — without this the dead-session view falls through to `unknown`.
      inspectingDeadSession: active?.status === "exited",
      rightTab,
    };
    registerViewContext(view);
    // Which coding agent is on screen, as a super-property, so an autocaptured
    // click can be broken down by agent. `session.started` already carries the
    // kind for the session it creates, but that is one event — everything
    // after it was unattributable. Null when nothing is active, rather than
    // leaving the last session's agent stamped on an empty workbench.
    syncHarnessKind(active?.harness ?? null);
  }, [st, harness.activeSessionId, settingsOpen, templatesOpen, rightTab]);

  // Crossing the breakpoint resets both panes to that mode's default.
  const prevMobile = useRef(isMobile);
  useEffect(() => {
    if (prevMobile.current === isMobile) return;
    prevMobile.current = isMobile;
    setRailCollapsed(isMobile);
    setRightCollapsed(isMobile);
  }, [isMobile]);

  // Persist the arrangement. Mobile's forced-collapsed defaults are
  // mode behavior, not a user choice.
  useEffect(() => {
    if (!isMobile) saveUiPrefs({ railCollapsed, rightCollapsed });
  }, [railCollapsed, rightCollapsed, isMobile]);
  useEffect(() => {
    saveUiPrefs({ rightTab });
  }, [rightTab]);

  // The place the shell is showing, in the same precedence `centrePane` uses.
  // It is derived rather than pushed at each door so every screen is
  // navigable, and recording it is idempotent: applying a visit re-derives the
  // same place, which dedupes against the tip instead of branching the stack.
  const recordVisit = navHistory.record;
  const activeSessionIdForNav = harness.activeSessionId;
  // Set by applyVisit for the single re-derivation its state change triggers,
  // so the record effect skips that one run and Back/Forward stays a pure
  // replay rather than truncating the forward stack.
  const applyingVisitRef = useRef(false);
  useEffect(() => {
    if (applyingVisitRef.current) {
      applyingVisitRef.current = false;
      return;
    }
    if (templatesOpen) {
      recordVisit({ kind: "templates" });
    } else if (reviewSummary) {
      recordVisit({ kind: "review", summary: reviewSummary });
    } else if (composing) {
      recordVisit({ kind: "composer", project: composerProject });
    } else if (view.kind === "project") {
      recordVisit({ kind: "agent-map", projectId: view.projectId });
    } else if (view.kind === "agent") {
      recordVisit({ kind: "agent", agentPath: view.path });
    } else if (activeSessionIdForNav) {
      recordVisit({
        kind: "session",
        sessionId: activeSessionIdForNav,
        agentPath: null,
      });
    }
  }, [
    recordVisit,
    view,
    templatesOpen,
    reviewSummary,
    composing,
    composerProject,
    activeSessionIdForNav,
  ]);

  const setActiveSessionId = harness.setActiveSessionId;
  const applyVisit = useCallback(
    (visit: NavigationVisit | null): void => {
      if (!visit) return;
      navGenerationRef.current += 1;
      // Replaying, not navigating: tell the record effect to skip the one run
      // this state change triggers. See applyingVisitRef above.
      applyingVisitRef.current = true;
      setOverviewOpen(false);
      setTemplatesOpen(visit.kind === "templates");
      // The screen derives its label and creation root from the project the
      // visit was recorded with, not from whichever project opened it last.
      // A project removed since the visit was recorded is not restored: the
      // composer would otherwise create into a root the rail no longer holds.
      const visitProject = visit.kind === "composer" ? visit.project : null;
      const scopes = harness.state?.workspaceScopes ?? [];
      const visitProjectOpen =
        !visitProject ||
        scopes.some((scope) => samePath(scope.cwd, visitProject.root));
      setComposing(visit.kind === "composer" && visitProjectOpen);
      if (visit.kind === "composer") {
        setComposerProject(visitProjectOpen ? visitProject ?? null : null);
      }
      setReviewSummary(visit.kind === "review" ? visit.summary : null);
      setMapPanelPath(null);
      if (visit.kind === "agent-map") {
        setView(
          scopes.some((scope) => scope.projectId === visit.projectId)
            ? { kind: "project", projectId: visit.projectId }
            : { kind: "session" },
        );
      } else if (visit.kind === "project") {
        // A visit recorded before a project had its durable identity.
        const projectId = scopes.find(
          (scope) => scope.workspaceKey === visit.workspaceKey,
        )?.projectId;
        setView(projectId ? { kind: "project", projectId } : { kind: "session" });
      } else if (visit.kind === "agent") {
        const projectId = projectIdForAgent(visit.agentPath, harness.state);
        setView(
          projectId
            ? { kind: "agent", projectId, path: visit.agentPath }
            : { kind: "session" },
        );
      } else {
        setView({ kind: "session" });
        if (visit.kind === "session") setActiveSessionId(visit.sessionId);
      }
    },
    [harness.state, setActiveSessionId],
  );

  // The dead pane's Resume button has to be as honest as a history row's tag,
  // and only the server can say whether the agent still holds the
  // conversation. Its verdict rides on the history row for this session, so
  // fetch this directory's history when we don't already have it. Safe to ask
  // for one directory: `loadHistory` replaces only the rows of the directories
  // it loaded and retains the rest, so this can't evict the rail's rows.
  //
  // Declared here, above this component's early returns, so the hook list
  // stays stable regardless of boot state.
  const activeExitedSession =
    harness.state?.sessions.find(
      (session) =>
        session.id === harness.activeSessionId && session.status === "exited",
    ) ?? null;
  const deadResumeMode = activeExitedSession?.agentSessionId
    ? harness.history.find(
        (summary) =>
          summary.agentSessionId === activeExitedSession.agentSessionId,
      )?.resumeMode
    : "rehydrate";
  const deadCwdNeedingHistory =
    activeExitedSession?.agentSessionId != null && deadResumeMode === undefined
      ? activeExitedSession.cwd
      : null;
  const loadHistory = harness.loadHistory;
  useEffect(() => {
    if (deadCwdNeedingHistory) void loadHistory([deadCwdNeedingHistory]);
  }, [deadCwdNeedingHistory, loadHistory]);

  // Describe-with-AI outcome feedback. The run is a hidden background task that
  // never takes over the board — but it must never finish SILENTLY either.
  // Toast when a describe task leaves "running" (the exact "spins then stops
  // with no result and no message" report). On success the canvas also
  // re-renders on its own from the edited source.
  const describeTaskStatus = useRef(new Map<string, string>());
  useEffect(() => {
    for (const task of harness.tasks) {
      if (task.macroId !== "describe") continue;
      const prev = describeTaskStatus.current.get(task.id);
      if (prev === "running" && task.status !== "running") {
        harness.showToast(
          task.status === "failed"
            ? "Couldn't generate descriptions — check the agent terminal for details."
            : "Describe run finished — the canvas updates if the agent changed the source.",
          task.status === "failed" ? "error" : "success",
        );
      }
      describeTaskStatus.current.set(task.id, task.status);
    }
  }, [harness.tasks, harness.showToast]);

  // Warm deep link: the desktop bridge pushes a target while the app is running.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onDeepLink) return;
    return bridge.onDeepLink((target) => applyDeepLinkRef.current?.(target));
  }, []);

  // Cold-start deep link (?agent=): apply once, after the state has loaded, so a
  // locally-connected agent is matched instead of prompting to clone.
  useEffect(() => {
    if (harness.loading) return;
    const target = coldDeepLinkRef.current;
    if (!target || coldDeepLinkHandledRef.current) return;
    coldDeepLinkHandledRef.current = true;
    applyDeepLinkRef.current?.(target);
  }, [harness.loading]);

  // After a deep-link clone lands, the workspace rescan surfaces the agent with a
  // matching definitionId — bind the cloning session to it then, closing the
  // "clone → display" loop in the right pane without moving the centre off
  // the chat that is doing the clone.
  useEffect(() => {
    const wantId = pendingCloneFocusRef.current;
    if (wantId && bindClonedRef.current?.(wantId)) {
      pendingCloneFocusRef.current = null;
    }
  }, [harness.state?.workflows]);

  if (harness.loading) {
    return <div className="app-status">Loading Agent Studio…</div>;
  }
  // Boot failed (no state to render): degrade gracefully to a recoverable
  // state instead of a dead "Failed to load" white screen. The classifier
  // names it honestly from real signals — offline (browser/network), auth
  // (rejected credential — the server re-reads a rotated key on the retry's
  // request), or a generic server error — and Retry re-runs the boot fetch in
  // place. Mock mode never reaches here (its fetches always resolve).
  if (harness.error || !harness.state) {
    const status = classifyConnectivity({ online, error: harness.errorKind });
    return (
      <ConnectivityScreen
        // classify only returns "online" when there's neither an offline flag
        // nor an error; we're here because the boot failed, so treat that
        // impossible case as a generic error rather than rendering nothing.
        status={status === "online" ? "error" : status}
        onRetry={harness.reload}
        detail={harness.error}
        onStartAuth={status === "auth" ? harness.startAuth : undefined}
      />
    );
  }

  const { state } = harness;
  /** The roots this install knows it has opened — see `knownRootsOf`. */
  const knownProjectRoots = (): string[] =>
    knownRootsOf(harness.settings?.recentDirs, state.launchDir);

  const activeSession =
    state.sessions.find((session) => session.id === harness.activeSessionId) ??
    null;
  const boundWorkflowPath = boundWorkflowPathOf(activeSession);
  const boundWorkflow =
    state.workflows.find((w) => w.path === boundWorkflowPath) ?? null;
  const workspaceScopes = state.workspaceScopes ?? [];
  /** The open root a project id names, if the rail has it. */
  const projectScope = (projectId: string) =>
    workspaceScopes.find((scope) => scope.projectId === projectId) ?? null;
  const projectLabelOf = (projectId: string): string => {
    const scope = projectScope(projectId);
    return (
      state.studioProjects?.find((project) => project.projectId === projectId)
        ?.displayName ||
      (scope ? basenameOf(scope.cwd) : "Project")
    );
  };
  /** A project's agents, under the rule the old rail filed them by. */
  const agentsInProject = (projectId: string): WorkflowInfo[] => {
    const scope = projectScope(projectId);
    return scope
      ? state.workflows.filter((workflow) =>
          agentBelongsToProjectRoot(workflow, scope.cwd, workspaceScopes),
        )
      : [];
  };
  /** The root a session belongs to: its project's open root, else the longest
   *  known root containing its cwd. */
  const sessionRoot = (session: HarnessSession): string =>
    projectScope(session.agentMapIdentity?.projectId ?? "")?.cwd ??
    projectRootForAgent(session.cwd, knownProjectRoots());
  const sessionLabel = (session: HarnessSession): string =>
    sessionDisplayName(session, sessionNames);
  const markOf = (session: HarnessSession) =>
    sessionMark(session, harness.busySessionIds.has(session.id), now);

  /**
   * ONE answer to what the centre shows (design.md I2). Every branch below
   * reads this value; none re-derives it from the booleans it replaced.
   */
  const centre = centrePane({
    view,
    session: activeSession,
    reviewing: reviewSummary != null,
    composing: composing && composerProject != null,
    hasProjects:
      workspaceScopes.length > 0 ||
      (harness.settings?.recentDirs?.length ?? 0) > 0,
  });
  const shownProject = shownProjectId(centre);
  const showComposer = centre.kind === "composer";
  const showDead = centre.kind === "dead";
  const showWorkbench = centre.kind === "workbench";
  const conversationSession = showDead || showWorkbench ? activeSession : null;
  const mapAgent =
    centre.kind === "agent-canvas"
      ? (state.workflows.find((workflow) =>
          samePath(workflow.path, centre.path),
        ) ?? null)
      : null;
  /**
   * The right pane EXISTS only beside a session bound to an agent (I3), and is
   * then about that agent. Absent is not collapsed: `rightCollapsed` is the
   * user's open/closed choice, and nothing here writes it, so it survives an
   * unbound session for the next bound one.
   */
  const rightPaneExists = hasRightPane(centre, boundWorkflow != null);
  const rightPaneWorkflow = rightPaneExists ? boundWorkflow : null;
  const rightPaneShown = rightPaneExists && !rightCollapsed;
  const shownTab: RightTab = rightTab;
  /** Which of the two canvas entry points can serve that agent's board. */
  const canvasSource = canvasSourceFor({
    subjectPath: rightPaneWorkflow?.path ?? null,
    bindingPath: boundWorkflowPath,
    sessionId: harness.activeSessionId,
  });
  const expandRightPane = (): void => {
    setRightCollapsed(false);
  };
  const collapseRightPane = (): void => {
    setRightCollapsed(true);
    if (isMobile) {
      window.requestAnimationFrame(() => rightPaneTriggerRef.current?.focus());
    }
  };
  const rightPaneDeploymentState = rightPaneWorkflow
    ? workflowDeploymentState(
        rightPaneWorkflow,
        harness.lastDeployErrorFor(rightPaneWorkflow.path),
      )
    : null;
  /**
   * Run evidence for the right pane's agent (SAP-2931): what the ACTIVE
   * session announced, plus what any OTHER live session announced for this
   * same agent and this one never heard, both through `mergeSubjectRuns` and
   * its window, so the picker never offers more runs than the client retains.
   */
  const subjectPath = rightPaneWorkflow?.path ?? null;
  const activeRunIds = harness.activeSessionId
    ? (harness.runIdsBySession.get(harness.activeSessionId) ?? [])
    : [];
  const activeSessionAnnounced: ObservedRun[] = activeRunIds
    .map((executionId) => harness.runsByExecution.get(executionId))
    .filter((observed): observed is ObservedRun => observed !== undefined);
  // Everything any other session announced, oldest first by observation time —
  // the same tail-is-newest convention the per-session lists use, so the
  // window keeps the same end whichever source a run came from.
  const announcedElsewhere: ObservedRun[] = [
    ...harness.runsByExecution.values(),
  ]
    .filter((observed) => !activeRunIds.includes(observed.run.executionId))
    .sort((a, b) => a.observedAt - b.observedAt);
  const activeSessionRuns: ObservedRun[] = mergeSubjectRuns(
    runsForSubject(activeSessionAnnounced, subjectPath),
    runsForSubject(announcedElsewhere, subjectPath),
  );
  // The shown run: the active session's own pick while it still belongs to this
  // agent, else the agent's newest.
  const activeObservedRun = shownRunForSubject(
    activeSessionRuns,
    selectedRunForSubject(
      activeSessionRuns,
      harness.activeSessionId
        ? (harness.runsBySession.get(harness.activeSessionId) ?? null)
        : null,
      subjectPath,
    ),
  );
  // The action button's honest "running" signal: tied to the SHOWN run's real
  // status, not the brief `directActionSettleSeq` pending ring (which clears at
  // hand-off). null unless the visible run is still running.
  const runningTarget: RunTarget | null =
    activeObservedRun?.run.status === "running"
      ? activeObservedRun.target
      : null;
  /** The session the header names: only when its workbench or dead pane is
   *  the centre. A project view's header names the project instead. */
  const sessionBarSession = conversationSession;
  // A live session to return to when the composer was opened over the workbench.
  const composerCanCancel =
    composing && activeSession != null && activeSession.status !== "exited";

  const closeMobileDrawer = (): void => {
    if (isMobile) setRailCollapsed(true);
  };

  /** Every door that points the centre somewhere clears the destinations that
   *  stand in for it, so a click behind an open Templates view is never lost. */
  const leaveDestinations = (): void => {
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
  };

  /**
   * A PROJECT HEADER (flow-navigation.md 4.3): its Agent Map takes the centre
   * at full width, with no chat and no right pane. The selected session is NOT
   * touched (design.md I5): it stays highlighted in the rail and one click
   * brings it back, so a project click never ends, hides or swaps work.
   */
  const handleSelectProject = (project: RailProject): void => {
    const generation = ++navGenerationRef.current;
    leaveDestinations();
    closeMobileDrawer();
    if (!project.projectId) {
      // The folder is in the rail but its durable identity has not reached
      // the scope catalog yet; its map opens once the refresh brings it.
      setPendingProject({ root: project.root, generation });
      void harness.refreshWorkspaceScopes().catch(() => {
        harness.showToast("Studio couldn't identify this project. Try again.");
      });
      return;
    }
    const projectId = project.projectId;
    if (viewProjectId !== projectId) setMapPanelPath(null);
    setView({ kind: "project", projectId });
    // AN EMPTY PROJECT'S NAME IS THE DOOR (D36, flow 4.6.2): a project with
    // nothing to draw lands on the new-agent screen scoped to it rather than
    // on a map with nothing in it. "Nothing to draw" means no agent AND no map
    // content: a durable project can carry map nodes the folder does not, so
    // the map is consulted, revalidated first because the loader's cache only
    // receives deltas while a map is mounted. The map shows meanwhile.
    const holdsAgents = agentsInProject(projectId).length > 0;
    if (holdsAgents) return;
    const openDoor = (): void =>
      composeInProject({
        root: project.root,
        label: project.label,
        projectId,
        template: null,
      });
    // No durable project behind the scope (an older server): no map can hold
    // anything the folder does not, so the door opens at once.
    if (!state.studioProjects?.some((candidate) => candidate.projectId === projectId)) {
      openDoor();
      return;
    }
    const mapIsEmpty = (snapshot: AgentMapWorkspaceResponse | null) =>
      !snapshot ||
      (snapshot.workspace.confirmedRevisionId === null && !snapshot.proposal);
    agentMapLoader.invalidate(projectId);
    void agentMapLoader
      .load(harness.api, projectId)
      .then((snapshot) => {
        if (mapIsEmpty(snapshot) && navGenerationRef.current === generation) {
          openDoor();
        }
      })
      .catch(() => {});
  };

  /** Remove from the rail, confirmed: the project's sessions end and its row
   *  goes; nothing on disk is touched. A view of it gives way first. */
  const handleRemoveProject = async (root: string): Promise<void> => {
    const removedProjectId =
      workspaceScopes.find((scope) => samePath(scope.cwd, root))?.projectId ??
      null;
    if (removedProjectId && viewProjectId === removedProjectId) {
      navGenerationRef.current += 1;
      setView({ kind: "session" });
    }
    // The screen is mounted only with a project that exists.
    if (composerProject && samePath(composerProject.root, root)) {
      setComposerProject(null);
    }
    await harness.removeProject(root);
  };

  /** Back to the project's map from an agent's canvas entered on it. */
  const backToMap = (projectId: string): void => {
    navGenerationRef.current += 1;
    setView({ kind: "project", projectId });
  };

  /** Double click on the map, or Open canvas: the agent's canvas in the same
   *  centre, with the way back in the header (flow 4.4). */
  const openAgentCanvas = (projectId: string, path: string): void => {
    navGenerationRef.current += 1;
    leaveDestinations();
    closeMobileDrawer();
    setView({ kind: "agent", projectId, path });
  };

  /**
   * The ONE answer to "where does a session for this agent boot" (SAP-2927):
   * the root of the project that owns it, never the agent's own folder, so the
   * coding agent comes up with the project's CLAUDE.md, .claude/ and skills.
   * The paths that create a session for a BRAND-NEW project folder (scaffold,
   * templates, the composer, a deep-link clone) deliberately do not come
   * through here: that folder is the new project's root by construction.
   */
  const sessionCwdForAgent = (agentPath: string): string => {
    const projectId = projectIdForAgent(agentPath, state);
    return (
      (projectId ? projectScope(projectId)?.cwd : undefined) ??
      projectRootForAgent(agentPath, knownProjectRoots())
    );
  };

  // The ONE choke point for session creation: the new session takes the
  // centre (unless its caller binds it first) and telemetry fires once. `cwd`
  // is already a project root by the time it gets here.
  const createSessionAt = async (
    cwd: string,
    agentHarness: HarnessKind,
    options: CreateSessionAtOptions = {},
  ): Promise<HarnessSession> => {
    // Activate the automatic home before a scaffold update can replace it;
    // its local draft and files must survive a later preparation failure.
    setComposing(options.keepComposerOpen === true);
    setReviewSummary(null);
    setOverviewOpen(false);
    setTemplatesOpen(false);
    if (options.select !== false) {
      navGenerationRef.current += 1;
      setView({ kind: "session" });
    }
    // Show the folder in the rail immediately — before the session POST, the pty
    // spawn, and the agent's scaffold/clone all resolve — so switching away
    // mid-creation never loses the in-progress project. Cleared on failure so a
    // rejected create leaves no ghost row; cleared automatically on success once
    // the real session/agent lands (see the store's pruning effect).
    harness.addPendingWorkspace(cwd);
    closeMobileDrawer();
    try {
      const session = await harness.createSession(
        {
          cwd,
          harness: agentHarness,
          ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
          ...(options.initialAttachments?.length ? { initialAttachments: options.initialAttachments } : {}),
          ...(options.initialSources?.length ? { initialSources: options.initialSources } : {}),
          ...(options.initialSetup ? { initialSetup: options.initialSetup } : {}),
          ...(options.initialUserInputPending ? { initialUserInputPending: true } : {}),
        },
        options.onCreated,
        { select: options.select !== false },
      );
      track("session.created");
      trackProduct("session.started", {
        harness_kind: agentHarness,
        origin: "user",
      });
      return session;
    } catch (err) {
      harness.removePendingWorkspace(cwd);
      throw err;
    }
  };

  const handleCreateSession = async (
    cwd: string,
    agentHarness: HarnessKind,
  ): Promise<void> => {
    await createSessionAt(cwd, agentHarness);
  };

  /**
   * NEW CHAT FROM THE RAIL (flow 4.5, Q11): a project header's `+` starts a
   * session at the project ROOT, unbound, and selects it. Unbound on purpose:
   * the `+` names a project, not an agent, so the right pane stays absent until
   * the session binds to one (Q5).
   */
  const handleNewChat = (project: RailProject): void => {
    void createSessionAt(project.root, selectedHarness).catch((err: unknown) => {
      harness.showToast(
        errorMessage(err, `Couldn't start a chat in ${project.label}.`),
      );
    });
  };

  /**
   * START CHAT on the map's agent panel (flow 4.4.2): a NEW session at the
   * agent's project root, bound to the agent, at the top of the project's rows
   * (newest activity) and selected. Always new: the panel lists the agent's
   * existing sessions right above the button, so Start chat never quietly
   * reuses one. Bound BEFORE it is shown (design.md I6): `POST /sessions`
   * takes no agent, and selecting first would flash an unbound workbench.
   */
  const handleStartChat = (workflow: WorkflowInfo, projectId: string): void => {
    if (startChatPendingRef.current) return;
    startChatPendingRef.current = true;
    setStartChatPending(true);
    const cwd = projectScope(projectId)?.cwd ?? sessionCwdForAgent(workflow.path);
    void (async () => {
      let createdId: string | null = null;
      try {
        const session = await createSessionAt(cwd, selectedHarness, {
          select: false,
          onCreated: (created) => {
            createdId = created.id;
            setPendingBindIds((previous) => new Set(previous).add(created.id));
          },
        });
        createdId = session.id;
        try {
          await harness.bindWorkflow(session.id, workflow.path);
        } catch {
          // Creation already succeeded. Keep that process alive and visible as
          // an unbound session rather than rolling it back.
          harness.showToast(
            `Chat started, but couldn't attach it to ${workflow.name}.`,
          );
        }
        openSession(session.id);
      } catch (err) {
        harness.showToast(errorMessage(err, "Couldn't start the chat."));
      } finally {
        if (createdId) {
          const id = createdId;
          setPendingBindIds((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        }
        startChatPendingRef.current = false;
        setStartChatPending(false);
      }
    })();
  };

  /**
   * CHANGE LOCATION on the agent's panel (flow 4.4.3), after the confirm that
   * names both paths. It replaced the rail's drag-to-move, which moved an
   * agent on a gesture that could land by accident. The panel stays open on
   * the agent at its new path; sessions bound to it follow it (the server
   * remaps them, and `moveAgent` re-reads them, design.md I7).
   */
  const handleMoveAgent = async (from: string, to: string): Promise<void> => {
    try {
      await harness.moveAgent(from, to);
      setMapPanelPath((current) =>
        current && samePath(current, from) ? to : current,
      );
      setView((current) =>
        current.kind === "agent" && samePath(current.path, from)
          ? { ...current, path: to }
          : current,
      );
      harness.showToast(`Moved ${basenameOf(to)} to ${to}.`, "info");
    } catch (err) {
      harness.showToast(errorMessage(err, `Couldn't move ${basenameOf(from)}.`));
    }
  };
  /**
   * Why `to` cannot be the agent's new location, under the field. The rules
   * are the move route's own (`src/server/agent-move.ts`): a move keeps the
   * agent's folder name and lands in a folder of an open project. The server
   * guards again with what only it can see (the disk, and exactly which
   * folders it accepts), and its refusal arrives as a toast.
   */
  const locationRefusal = (from: string, to: string): string | null => {
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(to)) return "Use an absolute path.";
    const name = basenameOf(from);
    if (samePath(to, from)) return null;
    if (isWithinDir(from, to)) return `Can't move ${name} inside itself.`;
    if (basenameOf(to) !== name)
      return `Keep the folder name ${name}: Change location moves the agent, it does not rename it.`;
    const parent = parentOf(to);
    if (
      parent == null ||
      !workspaceScopes.some((scope) => rootContains(scope.cwd, parent))
    )
      return "Pick a folder inside one of your open projects.";
    return refuseMove(
      state.workflows.map((workflow) => workflow.path),
      from,
      to,
    );
  };

  const shownScope = shownProject ? projectScope(shownProject) : null;
  const mapMode =
    centre.kind === "project-map"
      ? projectMapMode({
          state: agentMapEntry.state.workspace,
          unavailable: agentMapEntry.state.unavailable,
          durable:
            state.studioProjects?.some(
              (project) => project.projectId === centre.projectId,
            ) ?? false,
          initialization: agentMapEntry.initialization,
        })
      : null;
  const projectViewHeader =
    shownProject && shownScope
      ? {
          label: projectLabelOf(shownProject),
          agentName: centre.kind === "agent-canvas" ? (mapAgent?.name ?? basenameOf(centre.path)) : null,
          onBackToMap: () => backToMap(shownProject),
          onNewAgent: () =>
            handleCreateAgentInProject(shownScope.cwd, projectLabelOf(shownProject)),
          onExpandMap:
            mapMode?.kind === "map" &&
            agentMapEntry.state.workspace.status === "ready" &&
            (agentMapEntry.state.workspace.value.proposal?.nodes.length ?? 0) > 0
              ? () => setMapExpanded(true)
              : null,
        }
      : null;

  /** The agent panel on the map, one recipe for the drawn map and the agent
   *  cards, so the two can never offer different verbs. */
  const renderAgentPanel = (projectId: string): JSX.Element | null => {
    const agent = mapPanelPath
      ? state.workflows.find((workflow) => samePath(workflow.path, mapPanelPath))
      : undefined;
    if (!agent) return null;
    return (
      <MapAgentPanel
        agent={agent}
        sessions={sessionsForAgent(
          state.sessions,
          projectId,
          agent.path,
          hiddenSessionIds,
          now,
        )}
        sessionLabel={sessionLabel}
        markOf={markOf}
        now={now}
        onOpenSession={openSession}
        onStartChat={() => handleStartChat(agent, projectId)}
        startChatPending={startChatPending}
        onEnterCanvas={() => openAgentCanvas(projectId, agent.path)}
        onChangeLocation={(to) => void handleMoveAgent(agent.path, to)}
        validateLocation={(to) => locationRefusal(agent.path, to)}
        onClose={() => setMapPanelPath(null)}
      />
    );
  };

  /**
   * OPEN A FOLDER AS A PROJECT and land on its map (the rail's Add project,
   * the folder step's second half). The server mints the durable Studio
   * project and its agents scan in; the folder joins the rail, agents or not.
   * No session is created and no seeding turn runs (flow-creation.md §4.1
   * step 3, §4.5, Q5).
   *
   * Returns the project as the rail labels it, so New project can continue to
   * the new-agent screen scoped to exactly what was opened, or null when a
   * newer navigation won while the open was pending.
   */
  const openProjectIntoRail = async (
    requestedRoot: string,
  ): Promise<ComposerProject | null> => {
    const generation = ++navGenerationRef.current;
    const stale = (): boolean => generation !== navGenerationRef.current;
    const openedRoot = await harness.openProject(requestedRoot);
    if (stale()) return null;
    const opened: ComposerProject = {
      root: openedRoot,
      label: basenameOf(openedRoot) || openedRoot,
      projectId: null,
      template: null,
    };
    try {
      const refreshed = await harness.api.getState();
      if (stale()) return null;
      const scope = refreshed.workspaceScopes?.find((candidate) =>
        samePath(candidate.cwd, openedRoot),
      );
      const project = refreshed.studioProjects?.find(
        (candidate) => candidate.projectId === scope?.projectId,
      );
      if (!scope?.projectId || !project) return opened;
      opened.projectId = project.projectId;
      opened.label = project.displayName || opened.label;
      // The opened project's map is the answer to opening it, as a header
      // click would be. Still no session and no new-agent screen.
      setMapPanelPath(null);
      setView({ kind: "project", projectId: project.projectId });
    } catch {
      // Identity is best-effort here: the folder is in the rail either way.
    }
    return opened;
  };

  /**
   * LAND ON THE NEW-AGENT SCREEN, scoped to a project (flow-creation.md §4.3).
   *
   * One screen, every entrance: New project after its folder step, the map
   * header's New agent, an empty project's name (D36), and template Use. The
   * project is stated on the screen, never chosen there. No right pane: there
   * is nothing to project until submit. Its Back returns to the session it was
   * opened over, never to a map the screen replaced.
   */
  const composeInProject = (project: ComposerProject): void => {
    navGenerationRef.current += 1;
    setView({ kind: "session" });
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    setComposerProject(project);
    setComposing(true);
    closeMobileDrawer();
  };

  /**
   * THE FOLDER STEP'S ANSWER. The folder opens as a project either way; only
   * New project continues to the screen. Rejects with the sentence the web
   * dialog shows; the desktop path toasts it.
   */
  const handleProjectFolderChosen = async (
    root: string,
    intent: ProjectFolderIntent,
    template: StudioTemplate | null,
  ): Promise<void> => {
    const opened = await openProjectIntoRail(root);
    // A newer navigation won while the folder opened: it decided where the
    // user is, and a late folder choice does not replace that.
    if (!opened) return;
    if (intent === "new-project") {
      composeInProject({
        ...opened,
        template,
        ...(template ? { templateSurface: "template_gallery" as const } : {}),
      });
    }
  };

  /**
   * THE FOLDER STEP (flow-creation.md §4.1 step 2, D29). The desktop bridge's
   * picker directly, with no Studio dialog in front of it and no pre-chosen
   * parent (Q8); the one-field dialog only where there is no bridge. Cancel
   * returns the user to where they were: nothing opens, nothing is remembered.
   */
  const runFolderStep = (
    intent: ProjectFolderIntent,
    template: StudioTemplate | null = null,
  ): void => {
    // The control that asked is the one focus returns to when the web dialog
    // closes; captured here because more than one surface runs this step.
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void chooseProjectFolder({
      chooseDirectory: getDesktopBridge()?.chooseDirectory ?? null,
      startingAt: null,
      openDialog: () => setFolderPrompt({ intent, template, trigger }),
      onPicked: (root) => {
        void handleProjectFolderChosen(root, intent, template).catch(
          (err: unknown) => {
            harness.showToast(errorMessage(err, "Couldn't open that folder."));
          },
        );
      },
      onError: (message) => harness.showToast(message),
    });
  };
  const handleNewProject = (): void => runFolderStep("new-project");
  const handleAddProject = (): void => runFolderStep("add-project");

  /**
   * NEW AGENT IN A PROJECT YOU ALREADY HAVE (flow-creation.md §4.2, D33, D34).
   * The row that was pressed is the answer to "where"; the screen opens
   * scoped to it and asks only for the idea.
   */
  const handleCreateAgentInProject = (root: string, label: string): void => {
    const projectId =
      workspaceScopes.find((scope) => samePath(scope.cwd, root))?.projectId ??
      null;
    composeInProject({ root, label, projectId, template: null });
  };

  /**
   * "Use template" ROUTES THROUGH THE NEW-AGENT SCREEN (flow-creation.md §5,
   * CF-D11): the template is the idea, editable before send, and the agent is
   * created the way every agent is. In a project already on screen the
   * template lands there; with none, the folder step runs first and carries
   * the template to the screen. A starter is scaffolded as that starter at
   * submit; a gallery template is named in the session setup as the starting
   * point to bring in at build time (the clone is a network operation the
   * coding agent owns, with its own auth failure mode).
   */
  const handleUseTemplate = (template: StudioTemplate): void => {
    // A deep link can open before registry loading finishes. Resolve the
    // harness choice before the screen opens on an unavailable default.
    const selectable = (harnessEntries ?? FALLBACK_HARNESSES).filter(
      isHarnessSelectable,
    );
    if (!selectable.some((entry) => entry.id === selectedHarness)) {
      const fallback = selectable[0]?.id as HarnessKind | undefined;
      if (fallback) setSelectedHarness(fallback);
    }
    // The screen's project counts only while the screen is open: Back leaves
    // `composerProject` set for the disclosure and the clip, and a later Use
    // must land in the project selected since, not the one left behind.
    if (composing && composerProject) {
      composeInProject({
        ...composerProject,
        template,
        templateSurface: "template_gallery",
      });
      return;
    }
    const scope = viewProjectId ? projectScope(viewProjectId) : null;
    if (scope?.projectId) {
      composeInProject({
        root: scope.cwd,
        label: projectLabelOf(scope.projectId),
        projectId: scope.projectId,
        template,
        templateSurface: "template_gallery",
      });
      return;
    }
    runFolderStep("new-project", template);
  };
  /**
   * SUBMIT, in order (flow-creation.md §4.4, D30, D31).
   *
   * 1. Creation completes before the chat starts: `POST /api/agents/scaffold`
   *    in the screen's project, the name derived from the idea. The server is
   *    the judge; a refusal (409 duplicate, 400 invalid) is thrown back to the
   *    screen, which shows it under the field. Nothing has started.
   * 2. One ordinary session opens in the project folder, bound to the agent.
   *    The ordinary type, the ordinary system prompt.
   * 3. Its first prompt is the idea, the files, the linked sources, and the
   *    planning instructions as session setup (§4.6). No English scaffold
   *    prompt is typed into any pty; the scaffold already happened.
   *
   * A session that fails to start after the agent exists is a session failure
   * and is reported as one: the agent is a row in the rail either way.
   */
  const handleComposerSubmitIdea = async (
    idea: string,
    attachments: readonly NewSessionAttachment[],
    sources: readonly string[],
  ): Promise<void> => {
    const project = composerProject;
    if (!project) {
      throw new Error("Pick a project first: New project opens the folder step.");
    }
    const template = project.template;
    const name = deriveAgentName(idea);
    // A RETRY AFTER THE SESSION FAILED reuses the agent the first attempt
    // created: the scaffold succeeded, so scaffolding again would be refused
    // as a duplicate of our own work. The screen stayed open with the files
    // and links intact, and this is what lets the second press finish the job.
    const retained = scaffoldedButUnstartedRef.current;
    const created =
      retained && samePath(retained.root, project.root) && retained.name === name
        ? retained
        : await harness.scaffoldAgent(
            project.root,
            name,
            template?.kind === "starter" ? template.id : "default",
          );
    scaffoldedButUnstartedRef.current = null;
    if (template && created !== retained) {
      // Product metric: "templates used", at the one choke point every
      // template surface now funnels through.
      trackProduct("agent.template_cloned", {
        template_slug: template.id,
        template_id: template.id,
        surface: project.templateSurface ?? "welcome",
      });
    }
    const setup = planningInstructions({
      agentName: created.name,
      projectLabel: project.label,
      template,
    });
    let session: HarnessSession;
    try {
      session = await createSessionAt(project.root, selectedHarness, {
        keepComposerOpen: true,
        initialPrompt: idea.trim(),
        initialAttachments: attachments.map((attachment) =>
          attachment.kind === "path"
            ? { kind: "path", path: attachment.path }
            : { kind: "inline", filename: attachment.name, dataUrl: attachment.dataUrl },
        ),
        initialSources: [...sources],
        initialSetup: setup,
        initialUserInputPending: true,
      });
    } catch (err) {
      // The agent exists (it is a row in the rail); the SESSION did not start.
      // Say exactly that under the field, keep the screen and its files, and
      // let the next press reuse the agent instead of scaffolding a duplicate.
      scaffoldedButUnstartedRef.current = {
        root: project.root,
        name: created.name,
        path: created.path,
      };
      throw new Error(
        `${created.name} was created, but its session didn't start. ${errorMessage(err, "")}`.trim(),
      );
    }
    setSetupBySession((previous) => new Map(previous).set(session.id, setup));
    try {
      await harness.bindWorkflow(session.id, created.path);
    } catch {
      // The session is live and already received the first prompt; only the
      // binding write failed. Keep it as an unbound folder session (as the
      // sibling-session path does) rather than reporting a start that did
      // happen, which would make the retry launch a second live session.
      harness.showToast(
        `Session started, but couldn't attach it to ${created.name}.`,
      );
    }
    harness.setActiveSessionId(session.id);
    // Only now does the screen give way: the agent exists and its session is
    // the active one, in the centre.
    setView({ kind: "session" });
    setComposing(false);
    setComposerProject(null);
  };

  /** The screen's own template row: the template becomes this screen's idea. */
  const handleComposerUseTemplate = (template: GalleryTemplate): void => {
    if (!composerProject) return;
    composeInProject({ ...composerProject, template, templateSurface: "welcome" });
  };

  /**
   * SELECT A SESSION: a rail row, a past session in the history card, a
   * palette hit, the map panel's session list, Cmd/Ctrl+N. One click from
   * anywhere (flow 4.2.3): its workbench takes the centre, the rail does not
   * change, and a project's map gives way to it.
   */
  const openSession = (id: string): void => {
    navGenerationRef.current += 1;
    leaveDestinations();
    setView({ kind: "session" });
    closeMobileDrawer();
    harness.setActiveSessionId(id);
  };
  openSessionRef.current = openSession;

  /**
   * `×` on a live rail row (after the confirm) and End session… in the session
   * menu: the process ends and the row drops to the exited mark (Q4). The
   * selection stays where it is; if it was this session, the centre shows its
   * dead pane rather than jumping to another session (D43).
   */
  const handleEndSession = (id: string): void => {
    void harness.endSession(id).catch(() => {
      // endSession surfaced its own toast; the row keeps its state.
    });
  };

  /**
   * `×` on an exited rail row, and the dead pane's Close (Q4): hidden from the
   * rail, kept in History. If it was the selected session, the centre moves to
   * its project's map, the one place still about where you were.
   */
  const handleHideSession = (id: string): void => {
    setHiddenSessionIds((previous) => {
      const next = new Set(previous);
      next.add(id);
      saveUiPrefs({ hiddenSessionIds: Array.from(next) });
      return next;
    });
    if (harness.activeSessionId !== id) return;
    const session = state.sessions.find((candidate) => candidate.id === id);
    const projectId = session?.agentMapIdentity?.projectId ?? null;
    harness.setActiveSessionId(null);
    if (projectId && projectScope(projectId)) {
      navGenerationRef.current += 1;
      setMapPanelPath(null);
      setView({ kind: "project", projectId });
    }
  };

  // One entry point for reviewing a past (transcript) session.
  const reviewPastSession = (summary: SessionSummary): void => {
    navGenerationRef.current += 1;
    setComposing(false);
    setReviewSummary(summary);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    closeMobileDrawer();
  };

  // Jump from the Studio to the real code, in the editor the user picked.
  const openInEditor = (path: string): void => {
    const editor = harness.settings?.editor;
    // Nothing reports back whether the scheme found an application, so say who
    // we handed it to — otherwise a machine without that editor installed just
    // shows a menu item that does nothing.
    harness.showToast(
      `Opening in ${editorLabel(editor)}… Pick a different editor in Settings.`,
      "info",
    );
    window.location.href = editorUrl(editor, path);
  };


  // Open a deep-linked agent if the user has it locally: its canvas, in the
  // centre of its project; returns whether it was found. Assigned here (not in
  // an effect) because it closes over `state`, which exists only past the
  // loading guard — the deep-link effects above reach it through the ref.
  focusExistingRef.current = (definitionId: string): boolean => {
    const match = state.workflows.find(
      (w) => w.definitionId != null && String(w.definitionId) === definitionId,
    );
    if (!match) return false;
    const projectId = projectIdForAgent(match.path, state);
    if (projectId) openAgentCanvas(projectId, match.path);
    return true;
  };
  // A cloned agent has landed: bind the session that cloned it, so its board
  // is in the right pane beside the chat that made it.
  bindClonedRef.current = (definitionId: string): boolean => {
    const match = state.workflows.find(
      (w) => w.definitionId != null && String(w.definitionId) === definitionId,
    );
    if (!match) return false;
    if (activeSession && activeSession.status !== "exited") {
      void harness.bindWorkflow(activeSession.id, match.path).catch(() => {});
    }
    return true;
  };

  // Resolve a deep-link target. A template (`sapiom://templates/<id>`) opens the
  // templates browser on that template; an agent (`sapiom://agent/<id>`) opens
  // it if present, else offers to clone it locally — the remote-only fallback.
  applyDeepLinkRef.current = (target: DeepLinkTarget): void => {
    if (target.kind === "template") {
      navGenerationRef.current += 1;
      setDeepLinkTemplateId(target.templateId);
      setTemplatesOpen(true);
      setOverviewOpen(false);
      return;
    }
    if (focusExistingRef.current?.(target.definitionId)) return;
    setCloneRequest(target);
  };

  // Clone a remote-only deep-linked agent locally (confirmed): open a session in a
  // fresh folder and hand the coding agent the clone-by-definitionId prompt — the
  // same agent-driven path "Use template" uses. The workspace rescan then surfaces
  // the cloned agent, and the pending-focus effect above displays it.
  const handleCloneDefinition = async (
    target: DeepLinkAgentTarget,
  ): Promise<void> => {
    setCloneRequest(null);
    // NO DEFAULT PARENT (Q8). A clone lands inside a project the user has:
    // the one on screen, else the most recently opened one. With none open,
    // the honest answer is to open one first.
    const parentRoot =
      (composing ? composerProject?.root : undefined) ??
      (viewProjectId ? projectScope(viewProjectId)?.cwd : undefined) ??
      harness.settings?.recentDirs[0] ??
      null;
    if (!parentRoot) {
      harness.showToast("Open a project first: New project picks the folder.");
      return;
    }
    // A repeated clone of the same definition gets its own folder: the clone
    // refuses a non-empty target, so the base name takes a numeric suffix
    // when the parent already holds it.
    const baseName = target.slug?.trim() || `agent-${target.definitionId}`;
    const taken = new Set(
      await harness
        .listDir(parentRoot)
        .then((listing) => listing.dirs.map((dir) => dir.name))
        .catch(() => [] as string[]),
    );
    let cloneName = baseName;
    for (let n = 2; taken.has(cloneName); n += 1) cloneName = `${baseName}-${n}`;
    const cwd = joinPath(parentRoot, cloneName);
    pendingCloneFocusRef.current = target.definitionId;
    try {
      const session = await createSessionAt(cwd, "claude-code", {
        initialUserInputPending: true,
      });
      sendPromptWhenReady(
        session.id,
        cloneDefinitionPrompt(target.definitionId, cwd),
        "Couldn't send the clone prompt. Ask the coding agent to run sapiom_dev_agents_clone.",
      );
    } catch (err) {
      pendingCloneFocusRef.current = null;
      harness.showToast(
        (err as Error).message ||
          "Couldn't start a session to clone the agent.",
      );
    }
  };

  /**
   * Binds an agent to a live session in its own project and shows that
   * session — used when navigating to a launched sub-agent from the board, and
   * before running a macro against an agent (the canvas is served from the
   * binding). It lands on the selected session when that session is in the
   * agent's project, else the project's newest live session, else STARTS one
   * at the project ROOT (SAP-2927: passing the agent's own directory brought a
   * session up without the project's CLAUDE.md, .claude/ or skills). Resolves
   * to the session the binding landed on.
   */
  const handleBindWorkflow = async (path: string): Promise<string | null> => {
    closeMobileDrawer();
    const projectId = projectIdForAgent(path, state);
    const live = railSessions(
      state.sessions,
      projectId,
      hiddenSessionIds,
      now,
    ).filter((session) => session.status !== "exited");
    const owner =
      live.find((session) => session.id === harness.activeSessionId) ??
      live[0];
    let targetId: string;
    if (owner) {
      targetId = owner.id;
    } else {
      try {
        targetId = (
          await createSessionAt(sessionCwdForAgent(path), "claude-code")
        ).id;
      } catch (err) {
        harness.showToast(
          errorMessage(err, "Couldn't start a session in this folder."),
        );
        return null;
      }
    }
    await harness.bindWorkflow(targetId, path);
    openSession(targetId);
    return targetId;
  };

  // Shared by the canvas Visualize CTA, the steps macros, and anything else
  // that fires a macro. Running a macro against a workflow (re-)binds too — the
  // canvas is served from the binding, so a render on an unbound workflow would
  // draw into the wrong root.
  const handleRunMacroForWorkflow = (
    workflow: WorkflowInfo | null,
    macro: MacroDef,
  ): void => {
    void (async () => {
      // Deploy / Prod-run / Run-local run via the DIRECT harness routes (no
      // Claude Code, no user LLM credits). Once a macro is a direct action we
      // NEVER fall through to the pty-inject runMacro — the buttons are already
      // gated (require a workflow / a deploy), so a missing prerequisite here is
      // a no-op, never a silent revert to the Claude Code path.
      const direct = directActionKind(macro.id);
      // Reveal + focus the Steps pane the instant an action will actually run,
      // BEFORE the (possibly slow) bind round-trip, so the run/deploy lands in a
      // view the user is already looking at. Gated so a click that will only
      // toast (prod-run with no ready build; run/deploy with no workflow) never
      // yanks the view. Matches the dispatch guards below exactly.
      const willActNow =
        ((direct === "deploy" || direct === "run-local") && workflow != null) ||
        (direct === "prod-run" &&
          workflow?.definitionId != null &&
          isWorkflowRunnable(workflow));
      if (willActNow) {
        setRightTab("steps");
        setRightCollapsed(false);
      }
      let sessionId = harness.activeSessionId;
      if (workflow)
        sessionId = (await handleBindWorkflow(workflow.path)) ?? sessionId;
      if (macro.action.kind === "open-url") {
        window.open(
          resolveMacroUrl(macro.action.url, workflow),
          "_blank",
          "noopener,noreferrer",
        );
        return;
      }
      if (!sessionId) return;
      if (direct !== null) {
        if (direct === "deploy") {
          if (!workflow) {
            harness.showToast("Select an agent first.");
          } else {
            void harness.deploy(workflow.path);
          }
        } else if (direct === "prod-run") {
          if (workflow?.definitionId != null && isWorkflowRunnable(workflow)) {
            // The definition has a ready cloud build; the runs route wants its
            // id as a string.
            void harness.startProdRun(sessionId, String(workflow.definitionId));
          } else {
            // The button is already disabled in SessionStepsBar when there is
            // no ready build. This branch protects keyboard/programmatic calls.
            const lastErr = workflow
              ? harness.lastDeployErrorFor(workflow.path)
              : null;
            const deploymentState = workflow
              ? workflowDeploymentState(workflow, lastErr)
              : "draft";
            harness.showToast(prodRunBlockedToast(deploymentState));
          }
        } else if (direct === "run-local") {
          if (!workflow) {
            harness.showToast("Select an agent first.");
          } else {
            void harness.runLocal(sessionId, workflow.path);
          }
        }
        return;
      }
      // Visualize (render-canvas) and every inject macro (Debug / Explain /
      // free-form) keep their existing path through runMacro.
      void harness.runMacro(macro.id, {
        harnessSessionId: sessionId,
        workflowPath: workflow?.path,
      });
    })();
  };

  const handleLaunchRun = (input: unknown): void => {
    const request = runRequest;
    if (!request) return;
    // The launch surface closes immediately and the execution becomes the
    // Steps pane's subject while binding / network work continues.
    setRunRequest(null);
    setRightTab("steps");
    setRightCollapsed(false);
    void (async () => {
      const sessionId =
        (await handleBindWorkflow(request.workflow.path)) ??
        harness.activeSessionId;
      if (!sessionId) return;
      if (request.target === "prod") {
        if (
          request.workflow.definitionId == null ||
          !isWorkflowRunnable(request.workflow)
        ) {
          harness.showToast("This agent needs a ready cloud deployment first.");
          return;
        }
        await harness.startProdRun(
          sessionId,
          String(request.workflow.definitionId),
          input,
        );
      } else {
        await harness.runLocal(sessionId, request.workflow.path, input);
      }
    })();
  };

  // "Describe with AI": run the describe macro HEADLESS (execution:"background")
  // so the agent edits the workflow source out of sight — never the interactive
  // terminal. The prompt is passed as the macro's `subject`; the source watcher
  // re-renders the canvas when the agent saves. The button's loading state is
  // driven by the resulting background task (see CanvasPane `describeRunning`).
  const handleDescribeWithAI = (workflow: WorkflowInfo): void => {
    void (async () => {
      const sessionId =
        (await handleBindWorkflow(workflow.path)) ?? harness.activeSessionId;
      if (!sessionId) return;
      void harness.runMacro("describe", {
        harnessSessionId: sessionId,
        workflowPath: workflow.path,
        subject: describeWorkflowPrompt(workflow),
      });
    })();
  };

  return (
    <div className="app-shell" data-rail-collapsed={railCollapsed || undefined}>
      {isMobile && !railCollapsed && (
        <div
          className="shell-scrim"
          data-testid="rail-drawer-scrim"
          aria-hidden="true"
          onClick={() => setRailCollapsed(true)}
        />
      )}
      {/* Desktop: the rail lives in a width-animating slot so collapse/expand
          slides (see .rail-slot). It stays mounted at width 0 when collapsed
          (inert, clipped). Mobile: the rail is a position:fixed drawer that
          escapes the slot, so it renders only when open, exactly as before. */}
      {(!isMobile || !railCollapsed) && (
        <div
          className={
            "rail-slot" +
            (railResizing ? " is-resizing" : "") +
            (!isMobile && railCollapsed ? " is-collapsed" : "")
          }
          inert={!isMobile && railCollapsed ? true : undefined}
          style={
            !isMobile ? { width: railCollapsed ? 0 : widths.rail } : undefined
          }
        >
          <WorkflowsRail
            assistant={harness.assistant}
            width={widths.rail}
            minWidth={RAIL_MIN}
            workflows={state.workflows}
            sessions={state.sessions}
            pendingWorkspaces={harness.pendingWorkspaces}
            activeSessionId={harness.activeSessionId}
            busySessionIds={harness.busySessionIds}
            hiddenSessionIds={hiddenSessionIds}
            pendingBindSessionIds={pendingBindIds}
            now={now}
            sessionLabel={sessionLabel}
            workspaceScopes={state.workspaceScopes}
            studioProjects={state.studioProjects}
            shownProjectId={templatesOpen ? null : shownProject}
            onSelectProject={handleSelectProject}
            onNewChat={handleNewChat}
            onSelectSession={(id) => {
              openSession(id);
              track("session.switched", { navigation_kind: "rail_session" }, id);
            }}
            onEndSession={handleEndSession}
            onHideSession={handleHideSession}
            onRemoveProject={(project, trigger) => {
              removeTriggerRef.current = trigger;
              setRemoving({ root: project.root, label: project.label });
            }}
            onOpenPalette={() => setPaletteOpen(true)}
            onCollapse={() => setRailCollapsed(true)}
            canGoBack={navHistory.canGoBack}
            canGoForward={navHistory.canGoForward}
            onGoBack={() => applyVisit(navHistory.goBack())}
            onGoForward={() => applyVisit(navHistory.goForward())}
            overviewSelected={overviewOpen}
            onSelectOverview={() => {
              navGenerationRef.current += 1;
              setOverviewOpen(true);
              setComposing(false);
              setReviewSummary(null);
              setTemplatesOpen(false);
              closeMobileDrawer();
            }}
            onNewProject={handleNewProject}
            onAddProject={handleAddProject}
            onReviewSummary={reviewPastSession}
            history={harness.history}
            historyLoading={harness.historyLoading}
            onOpenHistory={(cwds) => void harness.loadHistory(cwds)}
            recentDirs={harness.settings?.recentDirs ?? []}
            closedProjects={harness.closedProjects}
            unsearchedCheckouts={harness.unsearchedCheckouts}
            onBrowseTemplates={() => {
              navGenerationRef.current += 1;
              setTemplatesOpen(true);
              setOverviewOpen(false);
            }}
            templatesActive={templatesOpen}
            onToast={harness.showToast}
            telemetryOptIn={
              harness.settings?.telemetryOptIn ?? state.telemetryOptIn
            }
            consentSource={state.consentSource}
            consentEnvReason={state.consentEnvReason}
            authenticated={state.authenticated}
            organizationName={state.organizationName}
            onToggleTelemetry={async (next) => {
              await harness.updateSettings({ telemetryOptIn: next });
            }}
            productAnalyticsOptIn={state.productAnalyticsOptIn}
            onToggleProductAnalytics={async (next) => {
              await harness.updateSettings({ productAnalyticsOptIn: next });
            }}
            rollingSummary={harness.settings?.rollingSummary === true}
            onToggleRollingSummary={async (next) => {
              await harness.updateSettings({ rollingSummary: next });
            }}
            editor={resolveEditor(harness.settings?.editor)}
            onSelectEditor={async (next) => {
              await harness.updateSettings({ editor: next });
            }}
            onStartAuth={harness.startAuth}
            onDisconnect={harness.disconnect}
            settingsOpen={settingsOpen}
            onSetSettingsOpen={setSettingsOpen}
          />
        </div>
      )}

      {!railCollapsed && !isMobile && !canvasExpanded && (
        <div
          className="pane-resize-handle pane-resize-handle-rail"
          style={{ left: widths.rail }}
          onPointerDown={startRailDrag}
          onDoubleClick={resetRail}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace rail"
          data-testid="resize-handle-rail"
        />
      )}

      <div className="workspace-main">
        {/* Mid-session network drop: the app already loaded, so it stays fully
            usable against its last-known state — this non-blocking strip just
            tells the truth about why live actions pause. Clears itself when
            connectivity returns (useConnectivity re-renders online=true).
            Mock mode is always "online" so the demo build never shows it. */}
        {!online && <ConnectivityBanner />}
        {state.consentSource === "default-silent" &&
          !harness.settings?.telemetryNoticeDismissed && (
            <TelemetryNotice
              onDismiss={() => {
                void harness.updateSettings({ telemetryNoticeDismissed: true });
              }}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}

        <div
          className={
            "app" +
            // Templates AND the Overview are both full-width destinations that
            // stand in for the workbench — `.is-browsing` hides the panes for
            // either.
            (templatesOpen ? " is-browsing" : "") +
            // The workbench animates the canvas column open/closed (see
            // .app.canvas-animated). Off while browsing, on mobile, and where
            // there is no right pane, where the single-column switch should be
            // instant.
            (!templatesOpen && !isMobile && rightPaneExists
              ? " canvas-animated"
              : "") +
            // Present only DURING an open/close slide: it pins the pane content
            // to its expanded width so it CLIPS instead of squishing. Dropped
            // when settled, so a collapsed pane's content truly goes to zero.
            (paneSliding ? " canvas-sliding" : "") +
            // A resize-handle drag or double-click reset suppresses the open/close
            // ease, so the pane snaps to the cursor / equal split instead of
            // lagging the always-on transition by 0.22s.
            (canvasResizing ? " canvas-dragging" : "")
          }
          style={{
            gridTemplateColumns:
              // Browsing, the project's map, the composer and an unbound
              // session take the whole width: only a session bound to an agent
              // has a right pane (design.md I3).
              templatesOpen || isMobile || !rightPaneExists
                ? "minmax(0, 1fr)"
                : // Two tracks always, so the canvas column can animate to 0 on
                  // collapse — the pane (and its left-edge shadow) slides shut,
                  // and back open, instead of blinking via display:none.
                  `minmax(${CANVAS_MIN}px, 1fr) ${
                    rightCollapsed
                      ? widths.canvas == null
                        ? "0fr"
                        : "0px"
                      : widths.canvas == null
                        ? "1fr"
                        : // Clamp the pinned width to what the shell can hold
                          // (the terminal keeps its floor), so a width saved on a
                          // wide monitor doesn't overflow a narrower window.
                          `min(${widths.canvas}px, calc(100% - ${CANVAS_MIN}px))`
                  }`,
          }}
        >
          {/* Templates is a DESTINATION, not a session sub-view: it stands in
              for the workbench rather than sitting inside it, and brings its own
              header with the way back. Added as a sibling, with `.is-browsing`
              hiding the panes in CSS — the right pane must never unmount, since
              a running Visualize enrichment lives there. */}
          {templatesOpen && (
            <TemplatesPanel
              onExit={() => setTemplatesOpen(false)}
              onUse={handleUseTemplate}
              listTemplates={harness.listTemplates}
              getTemplate={harness.getTemplate}
              openTemplateId={deepLinkTemplateId}
            />
          )}

          <div className="center-pane">
            <SessionBar
              assistant={harness.assistant}
              reviewTitle={reviewSummary ? reviewSummary.title : null}
              composing={showComposer}
              composerProjectLabel={
                showComposer && composerProject ? composerProject.label : null
              }
              onBack={composerCanCancel ? () => setComposing(false) : null}
              activeSession={sessionBarSession}
              sessionName={
                sessionBarSession ? sessionLabel(sessionBarSession) : null
              }
              onRenameSession={renameSession}
              boundWorkflowName={boundWorkflow?.name ?? null}
              busy={
                sessionBarSession != null &&
                harness.busySessionIds.has(sessionBarSession.id)
              }
              onCloseSession={handleEndSession}
              onOpenInEditor={openInEditor}
              editorLabel={editorLabel(harness.settings?.editor)}
              onToast={harness.showToast}
              onExpandRail={
                railCollapsed ? () => setRailCollapsed(false) : null
              }
              onExpandRight={
                rightPaneExists && rightCollapsed ? expandRightPane : null
              }
              expandRightLabel="Expand canvas panel"
              expandRightRef={rightPaneTriggerRef}
              projectView={projectViewHeader}
              /* The agent action cluster. Its subject AND its gating are the
                 right pane's agent — the session's bound agent — so the verbs
                 and the board can never disagree about what they act on
                 (SAP-2931). Only beside a session: the project view has no
                 session to run them in. */
              actions={
                rightPaneWorkflow ? (
                  <SessionStepsBar
                    workflow={rightPaneWorkflow}
                    activeSessionId={
                      showWorkbench ? harness.activeSessionId : null
                    }
                    sessionReady={
                      showWorkbench &&
                      activeSession?.ready === true &&
                      activeSession.status !== "exited"
                    }
                    macros={state.macros}
                    onRunMacro={(macro) =>
                      handleRunMacroForWorkflow(rightPaneWorkflow, macro)
                    }
                    onRequestRun={(target, returnFocus) =>
                      setRunRequest({
                        workflow: rightPaneWorkflow,
                        target,
                        returnFocus,
                      })
                    }
                    preview={
                      showWorkbench && activeSession
                        ? (harness.previewBySession.get(activeSession.id) ??
                          null)
                        : null
                    }
                    lastDeployError={harness.lastDeployErrorFor(
                      rightPaneWorkflow.path,
                    )}
                    authenticated={state.authenticated}
                    directActionSettleSeq={harness.directActionSettleSeq}
                    runningTarget={runningTarget}
                  />
                ) : null
              }
            />

            {sessionBarSession &&
              (sessionBarSession.mcpAuthState === "restart-required" ||
                sessionBarSession.mcpAuthState === "restarting") && (
                <McpAuthRestartNotice
                  restarting={
                    sessionBarSession.mcpAuthState === "restarting"
                  }
                  onRestart={async () => {
                    await harness.restartMcpSession(sessionBarSession.id);
                  }}
                />
              )}


            <div className="terminal-slot">
              {centre.kind === "review" && reviewSummary ? (
                <PastSessionPane
                  summary={reviewSummary}
                  loadRecord={harness.sessionRecord}
                  onStart={() => {
                    const summary = reviewSummary;
                    setReviewSummary(null);
                    void harness.resumeFromHistory(summary);
                  }}
                  onClose={() => setReviewSummary(null)}
                />
              ) : centre.kind === "composer" && composerProject ? (
                /* THE NEW-AGENT SCREEN, scoped to a project (§4.3): no
                   terminal, no canvas yet. Describe the agent and submit; the
                   harness scaffolds it and a normal session opens on it, and
                   this screen gives way to the terminal. Keyed on the project
                   and the template so a second entrance starts clean. */
                <NewSessionComposer
                  key={`${composerProject.root}::${composerProject.template?.id ?? ""}`}
                  project={composerProject}
                  initialIdea={
                    composerProject.template
                      ? templateIdea(composerProject.template)
                      : undefined
                  }
                  harness={selectedHarness}
                  entries={harnessEntries ?? FALLBACK_HARNESSES}
                  onHarnessChange={setSelectedHarness}
                  firstRun={state.firstRun === true}
                  onSubmitIdea={handleComposerSubmitIdea}
                  onAttachmentError={harness.showToast}
                  onUseTemplate={handleComposerUseTemplate}
                  onBrowseTemplates={() => {
                    navGenerationRef.current += 1;
                    setTemplatesOpen(true);
                  }}
                  listTemplates={harness.listTemplates}
                  telemetryOptIn={
                    harness.settings?.telemetryOptIn ?? state.telemetryOptIn
                  }
                  onToggleTelemetry={async (next) => {
                    await harness.updateSettings({ telemetryOptIn: next });
                  }}
                />
              ) : centre.kind === "project-map" ? (
                /* THE PROJECT VIEW (flow-navigation.md 4.3): the project's
                   Agent Map at full centre width, no chat, no right pane.
                   Click an agent for its panel in place (4.4); double click,
                   or the panel's Open canvas, enters the agent's canvas in
                   this same centre. Keyed by project, so switching projects
                   is a fresh load rather than a mutation of the one on
                   screen. */
                <ProjectView showing="map">
                  {mapMode?.kind === "map" ? (
                    <AgentMapPane
                      key={`${centre.projectId}:${harness.authRevision}`}
                      viewportStore={agentMapViewportStore}
                      visible
                      api={harness.api}
                      workflows={state.workflows}
                      refreshWorkflows={harness.refreshWorkflows}
                      onPickAgent={(workflow) => setMapPanelPath(workflow.path)}
                      onEnterAgent={(workflow) =>
                        openAgentCanvas(centre.projectId, workflow.path)
                      }
                      agentPanel={renderAgentPanel(centre.projectId)}
                      state={agentMapEntry.state.workspace}
                      unavailable={agentMapEntry.state.unavailable}
                      onRetry={agentMapEntry.retryWorkspace}
                      initialization={agentMapEntry.initialization}
                      onRetryGeneration={agentMapEntry.retryGeneration}
                      expanded={mapExpanded}
                      onToggleExpanded={() => setMapExpanded((value) => !value)}
                    />
                  ) : (
                    <ProjectAgentGrid
                      agents={agentsInProject(centre.projectId)}
                      map={mapMode?.kind === "cards" ? mapMode.map : "not-drawn"}
                      onRetryGeneration={
                        agentMapEntry.initialization?.status === "failed" &&
                        agentMapEntry.initialization.retryable
                          ? agentMapEntry.retryGeneration
                          : null
                      }
                      selectedPath={mapPanelPath}
                      onPick={(agent) => setMapPanelPath(agent.path)}
                      onEnter={(agent) =>
                        openAgentCanvas(centre.projectId, agent.path)
                      }
                      panel={renderAgentPanel(centre.projectId)}
                    />
                  )}
                </ProjectView>
              ) : centre.kind === "agent-canvas" ? (
                <ProjectView showing="agent">
                  {mapAgent ? (
                    /* The agent's own canvas, entered from the map. Served by
                       the workflow-keyed route (IA-01): it is a look at the
                       agent, not at a session, so no session is bound or
                       started for it. */
                    <CanvasPane
                      key={`agent:${mapAgent.path}`}
                      sessionId={null}
                      lastMessage={harness.lastMessage}
                      subjectWorkflow={mapAgent}
                      source={canvasSourceFor({
                        subjectPath: mapAgent.path,
                        bindingPath: null,
                        sessionId: null,
                      })}
                      loadWorkflowGraph={shellApi.getWorkflowGraph.bind(shellApi)}
                      overviewActive={false}
                      sessionExited={false}
                      expanded={false}
                      onToggleExpanded={() => {}}
                      macros={state.macros}
                      tasks={harness.tasks}
                      surface="board"
                      onOpenSteps={() => {}}
                      run={null}
                      runTarget={null}
                      runs={[]}
                      onSelectRun={() => {}}
                      preview={null}
                      deployState={
                        harness.deployStateByPath.get(mapAgent.path) ?? null
                      }
                      onDismissDeploy={() =>
                        harness.dismissDeployState(mapAgent.path)
                      }
                      agentsBaseUrl={state.agentsBaseUrl}
                      onOpenCode={() => {}}
                      workflows={state.workflows}
                      onOpenWorkflow={(path) =>
                        openAgentCanvas(centre.projectId, path)
                      }
                      onRunMacro={(macro) =>
                        handleRunMacroForWorkflow(mapAgent, macro)
                      }
                      onInjectPrompt={() => {}}
                      onDescribeWorkflow={handleDescribeWithAI}
                    />
                  ) : (
                    <EmptyState
                      className="canvas-empty"
                      testId="project-agent-missing"
                      icon="Folder"
                      title="This agent is no longer here"
                      body="It moved or was removed. Go back to the map to see the project's agents."
                    />
                  )}
                </ProjectView>
              ) : centre.kind === "dead" && conversationSession ? (
                <AssistantPane
                  sessionId={conversationSession.id}
                  bootToken={harness.bootToken}
                  authRevision={harness.authRevision}
                  drafts={assistantDrafts}
                  authorityRevision={assistantAuthorityRevision}
                  onAuthorityRevision={setAssistantAuthorityRevision}
                  onSignIn={signInForAssistant}
                  onOpenSettings={() => setSettingsOpen(true)}
                  terminalRevision={
                    harness.terminalRevealBySession.get(
                      conversationSession.id,
                    ) ?? 0
                  }
                >
                  <DeadSessionPane
                    session={conversationSession}
                    resumeMode={deadResumeMode}
                    loadRecord={harness.sessionRecord}
                    onResume={() =>
                      void harness.resumeSession(conversationSession.id)
                    }
                    onContinue={() =>
                      void harness.rehydrateSession({
                        cwd: conversationSession.cwd,
                        harness: conversationSession.harness,
                        from: conversationSession.id,
                      })
                    }
                    /* Close on an ended session is the rail's × on its row:
                       hidden from the rail, kept in History (Q4), and the
                       centre moves to its project's map. */
                    onClose={() => handleHideSession(conversationSession.id)}
                  />
                </AssistantPane>
              ) : centre.kind === "workbench" && conversationSession ? (
                <div className="agent-view" data-testid="agent-view">
                  <div className="agent-view-panel" id="agent-panel-terminal">
                    {/* THE SETUP DISCLOSURE (§4.4 step 3): the planning
                        instructions rode the first prompt as session setup.
                        The pane shows the idea as the user's turn (the CLI
                        prints its first argument) and the instructions here,
                        quietly, so the user can read what the agent was told
                        without it reading as their words. */}
                    {setupBySession.has(conversationSession.id) && (
                      <details
                        className="session-setup"
                        data-testid="session-setup"
                      >
                        <summary className="session-setup-summary">
                          <Icon name="ListChecks" size={13} />
                          <span className="session-setup-title">
                            {SETUP_CARD.title}
                          </span>
                          <span className="session-setup-hint">
                            {SETUP_CARD.summary}
                          </span>
                        </summary>
                        <pre
                          className="session-setup-body"
                          data-testid="session-setup-body"
                        >
                          {setupBySession.get(conversationSession.id)}
                        </pre>
                      </details>
                    )}
                    <AssistantPane
                      sessionId={conversationSession.id}
                      bootToken={harness.bootToken}
                      authRevision={harness.authRevision}
                      drafts={assistantDrafts}
                      authorityRevision={assistantAuthorityRevision}
                      onAuthorityRevision={setAssistantAuthorityRevision}
                      onSignIn={signInForAssistant}
                      onOpenSettings={() => setSettingsOpen(true)}
                      terminalRevision={
                        harness.terminalRevealBySession.get(
                          conversationSession.id,
                        ) ?? 0
                      }
                    >
                      <Terminal
                        sessionId={conversationSession.id}
                        token={harness.bootToken}
                        cwd={conversationSession.cwd}
                      />
                    </AssistantPane>
                  </div>
                </div>
              ) : centre.kind === "no-session" ? (
                <NoSessionSelected />
              ) : (
                /* No project open at all: a fresh install or every project
                   removed. The one move is New project. */
                <NoProjectHome
                  hasProjects={false}
                  onNewProject={handleNewProject}
                  firstRun={state.firstRun === true}
                  telemetryOptIn={harness.settings?.telemetryOptIn === true}
                  onToggleTelemetry={async (next) => {
                    await harness.updateSettings({ telemetryOptIn: next });
                  }}
                />
              )}
            </div>
          </div>

          {rightPaneShown && !isMobile && !canvasExpanded && (
            <div
              className="pane-resize-handle pane-resize-handle-canvas"
              // Track the canvas column's ACTUAL edge, not the requested width.
              // The column track is clamped to `100% − CANVAS_MIN` (the
              // terminal's floor), so the handle uses the same expression to
              // stay welded to the board's edge at every width. (null = the
              // 1fr/1fr split, always at 50%.)
              style={{
                right:
                  widths.canvas == null
                    ? "50%"
                    : `min(${widths.canvas}px, calc(100% - ${CANVAS_MIN}px))`,
              }}
              onPointerDown={startCanvasDrag}
              onDoubleClick={resetCanvas}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize canvas pane"
              data-testid="resize-handle-canvas"
            />
          )}

          {isMobile && rightPaneShown && (
            <div
              className="shell-scrim"
              data-testid="right-sheet-scrim"
              aria-hidden="true"
              onClick={collapseRightPane}
            />
          )}

          {/* Right pane: the session's bound agent — Canvas | Steps | Secrets
              (flow-navigation.md 4.2.2, Q5). No Agent Map tab: the map is the
              project view's centre (design.md I4). Collapsed or absent via CSS,
              never unmounted, so a running Visualize enrichment survives both.
              `data-absent` marks a session with no agent, which has no pane at
              all rather than a closed one. */}
          <div
            ref={setRightPaneEl}
            className={
              "right-pane" + (rightPaneShown ? "" : " is-collapsed")
            }
            data-testid="right-pane"
            data-absent={!rightPaneExists || undefined}
            inert={!rightPaneShown ? true : undefined}
          >
            <div
              className="right-pane-tabs"
              role="tablist"
              aria-label="Right pane"
            >
              <button
                role="tab"
                aria-selected={shownTab === "canvas"}
                className={
                  "right-pane-tab" + (shownTab === "canvas" ? " is-active" : "")
                }
                onClick={() => setRightTab("canvas")}
                data-testid="right-tab-canvas"
              >
                <Icon name="Workflow" size={14} />
                Canvas
              </button>
              <button
                role="tab"
                aria-selected={shownTab === "steps"}
                className={
                  "right-pane-tab" + (shownTab === "steps" ? " is-active" : "")
                }
                onClick={() => setRightTab("steps")}
                data-testid="right-tab-steps"
              >
                <Icon name="List" size={14} />
                Steps
              </button>
              {/* The environment an agent resolves is a projection of that
                  agent, exactly like its structure (Canvas) and its steps — so
                  it earns a tab rather than a nested screen. */}
              <button
                role="tab"
                aria-selected={shownTab === "secrets"}
                className={
                  "right-pane-tab" +
                  (shownTab === "secrets" ? " is-active" : "")
                }
                onClick={() => setRightTab("secrets")}
                data-testid="right-tab-secrets"
              >
                <Icon name="Shield" size={14} />
                Secrets
              </button>
              <div className="right-pane-corner">
                {/* Cloud-status pill → dashboard. The board has no subheader,
                    so the link/build state lives here in the tab bar. */}
                {shownTab === "canvas" &&
                  rightPaneWorkflow?.definitionId != null &&
                  rightPaneDeploymentState === "unavailable" && (
                    /* Not a link: this account can't open that dashboard page. */
                    <span
                      className="status-tag right-pane-deployed"
                      data-testid="agent-unavailable-tag"
                      data-deployment-state="unavailable"
                      data-tooltip={deploymentStateTitle("unavailable")}
                    >
                      <Icon name="CloudOff" size={12} />
                      {deploymentStateLabel("unavailable")}
                    </span>
                  )}
                {shownTab === "canvas" &&
                  rightPaneWorkflow?.definitionId != null &&
                  rightPaneDeploymentState !== "unavailable" && (
                    <a
                      className="status-tag status-tag-action workflow-deployed-tag right-pane-deployed"
                      data-testid="workflow-dashboard-link"
                      data-deployment-state={
                        rightPaneDeploymentState ?? undefined
                      }
                      href={agentUrl(rightPaneWorkflow.definitionId)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${rightPaneDeploymentState} — open in the Sapiom dashboard`}
                      data-tooltip="Open this agent in the Sapiom dashboard"
                    >
                      <Icon name="Cloud" size={12} />
                      {deploymentStateLabel(
                        rightPaneDeploymentState ?? "linked",
                      )}
                    </a>
                  )}
                {/* Only with a pane to expand: the project view's header
                    carries the map's own full view under the same testid. */}
                {rightPaneExists && (
                  <button
                    className="theme-toggle"
                    data-testid="canvas-expand"
                    hidden={canvasExpanded}
                    aria-label={
                      shownTab === "steps" ? "Open Focus mode" : "Expand canvas"
                    }
                    title={
                      shownTab === "steps" ? "Open Focus mode" : "Expand canvas"
                    }
                    onClick={toggleCanvasExpanded}
                  >
                    <Icon name="Maximize2" size={15} />
                  </button>
                )}
                <button
                  className="theme-toggle right-pane-collapse"
                  data-testid="right-collapse"
                  aria-label="Collapse canvas panel"
                  title="Collapse canvas panel"
                  onClick={collapseRightPane}
                >
                  <Icon name="PanelRightClose" size={15} />
                </button>
              </div>
            </div>

            {/* Secrets is a SIBLING panel, not a mode on the board: it reads a
                different source entirely (the vault + this machine's pending
                store) and shares no state with the canvas. Mounted only while
                selected — unlike the board, it holds no probe state or reload
                key worth preserving, and keeping a credential list mounted
                behind another tab buys nothing. */}
            {shownTab === "secrets" && (
              <div
                className="right-pane-panel"
                data-testid="right-panel-secrets"
              >
                <SecretsPanel
                  api={harness.api}
                  workflow={rightPaneWorkflow}
                  onToast={harness.showToast}
                />
              </div>
            )}
            <div
              className={
                "right-pane-panel" +
                (shownTab === "secrets" ? " is-hidden" : "")
              }
              data-testid="right-panel-canvas"
            >
              <div className="right-pane-altitude" data-testid="right-panel-board">
                <CanvasPane
                  sessionId={harness.activeSessionId}
                  lastMessage={harness.lastMessage}
                  subjectWorkflow={rightPaneWorkflow}
                  source={canvasSource}
                  loadWorkflowGraph={shellApi.getWorkflowGraph.bind(shellApi)}
                  overviewActive={!rightPaneExists}
                  sessionExited={showDead}
                  onGraphChange={(workflowPath, graph) => {
                    const contract = inputContractFromCanvasGraph(graph);
                    if (contract)
                      visibleInputContractsRef.current.set(
                        workflowPath,
                        contract,
                      );
                  }}
                  expanded={canvasExpanded}
                  onToggleExpanded={toggleCanvasExpanded}
                  macros={state.macros}
                  tasks={harness.tasks}
                  surface={shownTab === "steps" ? "steps" : "board"}
                  onOpenSteps={() => setRightTab("steps")}
                  run={activeObservedRun?.run ?? null}
                  runTarget={activeObservedRun?.target ?? null}
                  runs={activeSessionRuns}
                  onSelectRun={(executionId) => {
                    if (harness.activeSessionId)
                      harness.selectRun(harness.activeSessionId, executionId);
                  }}
                  preview={
                    harness.activeSessionId
                      ? (harness.previewBySession.get(
                          harness.activeSessionId,
                        ) ?? null)
                      : null
                  }
                  deployState={
                    rightPaneWorkflow
                      ? (harness.deployStateByPath.get(
                          rightPaneWorkflow.path,
                        ) ?? null)
                      : null
                  }
                  onDismissDeploy={() => {
                    if (rightPaneWorkflow)
                      harness.dismissDeployState(rightPaneWorkflow.path);
                  }}
                  agentsBaseUrl={state.agentsBaseUrl}
                  onOpenCode={() => setRightTab("steps")}
                  workflows={state.workflows}
                  onOpenWorkflow={(path) => void handleBindWorkflow(path)}
                  /* The pane's own CTAs (Visualize, a failed task's Retry) act on
                   the agent the pane is DRAWING. */
                  onRunMacro={(macro) =>
                    handleRunMacroForWorkflow(rightPaneWorkflow, macro)
                  }
                  onInjectPrompt={(text) => {
                    if (harness.activeSessionId)
                      void harness
                        .injectInput(harness.activeSessionId, text)
                        .catch((err) =>
                          harness.showToast(
                            errorMessage(err, "Could not send the prompt to Terminal."),
                          ),
                        );
                  }}
                  onDescribeWorkflow={handleDescribeWithAI}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The Overview is a card ON TOP of the shell, so it mounts beside the
          palette rather than standing in for the workbench. */}
      {overviewOpen && (
        <OverviewModal
          firstRun={state.firstRun === true}
          appVersion={getDesktopBridge()?.appVersion || __STUDIO_VERSION__}
          onAddProject={handleAddProject}
          onBrowseTemplates={() => {
            navGenerationRef.current += 1;
            setOverviewOpen(false);
            setTemplatesOpen(true);
          }}
          onDismiss={() => setOverviewOpen(false)}
        />
      )}

      {/* The web half of the folder step (D29). Mounted beside the other
          cards-on-top: it outlives the rail control that asked for it, and it
          is the same dialog whichever surface ran the step. */}
      {folderPrompt && (
        <ProjectFolderDialog
          intent={folderPrompt.intent}
          initialPath=""
          listDir={harness.listDir}
          triggerRef={{ current: folderPrompt.trigger }}
          onClose={() => setFolderPrompt(null)}
          onChoose={(root) =>
            handleProjectFolderChosen(
              root,
              folderPrompt.intent,
              folderPrompt.template,
            )
          }
        />
      )}

      {/* The one-time explainer. It owns WHEN it shows (first run, the account
          menu's "How Studio is organised"); the shell owns WHERE the "already
          seen" fact lives, because that fact has to outlive a browser origin —
          the desktop app boots on a new ephemeral port every launch, so a flag
          in `localStorage` reopened the card every time (SAP-2991). */}
      <HelpOverlay
        // Absent settings reads as "not seen", which shows the card. That is
        // the safe failure the card has always chosen over a broken shell.
        seen={harness.settings?.helpSeen === true}
        onSeen={() => {
          // Best-effort, exactly as the old storage write was: a rejected
          // PATCH costs one extra showing on the next launch, never a
          // dismissal that refuses to dismiss.
          void harness.updateSettings({ helpSeen: true }).catch(() => {});
        }}
      />

      {paletteOpen && (
        <CommandPalette
          sessions={state.sessions}
          workflows={state.workflows}
          recentDirs={harness.settings?.recentDirs ?? []}
          history={harness.history}
          sessionNames={sessionNames}
          activeSessionId={harness.activeSessionId}
          listDir={harness.listDir}
          listTemplates={harness.listTemplates}
          onSelectSession={openSession}
          onReviewSummary={reviewPastSession}
          onOpenPath={(cwd) => void handleCreateSession(cwd, "claude-code")}
          onOpenTemplate={(templateId) => {
            navGenerationRef.current += 1;
            setDeepLinkTemplateId(templateId);
            setTemplatesOpen(true);
            setOverviewOpen(false);
          }}
          actions={
            [
              {
                id: "browse-templates",
                label: "Browse templates",
                meta: "Gallery and starters",
                icon: "LayoutTemplate",
                run: () => {
                  navGenerationRef.current += 1;
                  setTemplatesOpen(true);
                  setOverviewOpen(false);
                },
              },
              {
                id: "toggle-theme",
                label: "Toggle theme",
                meta: "Light and dark",
                icon: "Sun",
                run: toggleTheme,
              },
              {
                id: "toggle-rail",
                label: railCollapsed
                  ? "Show workspace panel"
                  : "Hide workspace panel",
                meta: "Left pane",
                icon: "Menu",
                run: () => setRailCollapsed((collapsed) => !collapsed),
              },
              {
                id: "toggle-right",
                label: rightCollapsed
                  ? "Show canvas panel"
                  : "Hide canvas panel",
                meta: "Right pane",
                icon: rightCollapsed ? "PanelRightOpen" : "PanelRightClose",
                run: () => setRightCollapsed((collapsed) => !collapsed),
              },
              ...(activeSession
                ? [
                    {
                      id: "new-session-here",
                      label: "New session in this folder",
                      // The project root, not the active session's raw cwd
                      // (SAP-2927) — and `meta` shows the resolved folder, so a
                      // session an older build left in an agent's directory
                      // cannot make this row name a folder it will not open.
                      meta: sessionRoot(activeSession),
                      icon: "Plus",
                      run: () =>
                        void handleCreateSession(
                          sessionRoot(activeSession),
                          "claude-code",
                        ),
                    },
                  ]
                : []),
            ] satisfies PaletteAction[]
          }
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {cloneRequest && (
        <CloneAgentConfirm
          agentLabel={
            cloneRequest.slug
              ? `“${cloneRequest.slug}”`
              : `Agent ${cloneRequest.definitionId}`
          }
          onCancel={() => setCloneRequest(null)}
          onConfirm={() => void handleCloneDefinition(cloneRequest)}
        />
      )}

      {runRequest && (
        <RunSheet
          workflow={runRequest.workflow}
          target={runRequest.target}
          loadContract={loadRunInputContract}
          returnFocus={runRequest.returnFocus}
          onClose={() => setRunRequest(null)}
          onRun={handleLaunchRun}
        />
      )}

      {removing && (
        <RemoveProjectConfirm
          label={removing.label}
          root={removing.root}
          /* Counted from the SAME plan that does the ending, so the number the
             dialog names and the sessions that die cannot drift apart. */
          runningCount={
            planProjectRemoval({
              root: removing.root,
              recentDirs: harness.settings?.recentDirs ?? [],
              sessions: state.sessions,
            }).endSessionIds.length
          }
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void handleRemoveProject(target.root);
          }}
          triggerRef={removeTriggerRef}
        />
      )}

      {harness.toast && (
        <Toast
          message={harness.toast.message}
          tone={harness.toast.tone}
          onDismiss={harness.dismissToast}
        />
      )}
      <TooltipLayer />
    </div>
  );
};
