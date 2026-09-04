/**
 * Harness SPA shell.
 *
 * Three zones, one mental model:
 *  1. LEFT RAIL — an explorer of what exists on disk: workspace folders and
 *     the agents (sapiom.json) inside them. Clicking an agent FOCUSES it. No
 *     sessions live here.
 *  2. MAIN PANEL — the workbench for the focused agent: browser-style live
 *     session tabs inside the shared header, then the conversation/terminal.
 *     Session switching and same-folder session creation live in that strip.
 *  3. RIGHT PANEL — projections of the rail SELECTION (Canvas | Steps). The
 *     canvas stays mounted behind CSS when another tab is active so a running
 *     Visualize enrichment (and the graph-posting document) is never disturbed
 *     by a tab flip.
 *
 * The invariant used to be one chain — selection == tab strip == active tab's
 * binding == right panel — and SAP-2931 deliberately cut it in two, because
 * looking and working are different acts: you read agent F's board while the
 * terminal is mid-sentence with agent B.
 *
 *   Right panel == the rail SELECTION. Board, Steps, Code, the lifecycle verbs
 *                  and the run evidence are projections of that ONE subject
 *                  (`lib/session-scope.ts`); if two of them can disagree, that
 *                  is a bug by contract.
 *   Tab strip   == the ACTIVE session's own agent. Keyed to the selection it
 *                  emptied itself under a still-running session.
 *   The session  moves only when the selection leaves its PROJECT, because a
 *                  session is project-scoped and cannot reach outside it.
 *
 * A project row FILLS the workbench rather than replacing it (SAP-2980): the
 * coding-agent CLI stays in the centre and the project's map draws on the right.
 * The graph used to be a full-main destination, inheriting the pattern from the
 * template gallery by analogy — but browsing a gallery is a detour, and looking
 * at your project's shape while talking to it is not. The centre pane vanishing
 * on a project click was a mode switch where a view change was asked for.
 *
 * The right pane has ONE subject at TWO altitudes (`lib/canvas-altitude.ts`):
 * a project's map, or an agent's board. The rail and the canvas are two views
 * of that one selection and always agree — selecting a project puts the canvas
 * at map altitude, selecting an agent puts it at board altitude, and drilling
 * into a map node moves the rail selection with it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";
import type {
  HarnessKind,
  HarnessSession,
  MacroDef,
  SessionSummary,
  WorkflowInfo,
  WorkflowInputContractResponse,
} from "@shared/types";
import type { WorkspaceKey } from "@shared/system-graph";
import type {
  PlannerSessionRequest,
  StudioProjectId,
  StudioWorkspaceSelection,
} from "@shared/agent-map";

import { CanvasPane } from "./components/CanvasPane";
import { AgentMapPane } from "./components/AgentMapPane";
import { CommandPalette } from "./components/CommandPalette";
import {
  ConnectivityBanner,
  ConnectivityScreen,
} from "./components/ConnectivityState";
import { DeadSessionPane, PastSessionPane } from "./components/DeadSessionPane";
import { EmptyState } from "./components/EmptyState";
import { Icon } from "./components/Icon";
import { SessionBar } from "./components/SessionBar";
import { SessionStepsBar } from "./components/SessionStepsBar";
import { RunSheet } from "./components/RunSheet";
import { TelemetryNotice } from "./components/TelemetryNotice";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { Terminal } from "./components/Terminal";
import { Toast } from "./components/Toast";
import { TooltipLayer } from "./components/TooltipLayer";
import { NewSessionComposer } from "./components/NewSessionComposer";
import { HelpOverlay } from "./components/HelpOverlay";
import { CreateAgentDialog } from "./components/CreateAgentDialog";
import { OverviewModal } from "./components/OverviewModal";
import { WorkflowsRail } from "./components/WorkflowsRail";
import { WorkspaceGraphView } from "./components/WorkspaceGraphView";
import { boundWorkflowPathOf, createApi, errorMessage } from "./lib/api";
import { classifyConnectivity, useConnectivity } from "./lib/connectivity";
import { historyDirs } from "./lib/history-meta";
import {
  FALLBACK_PROJECT_NAME,
  nextAvailableName,
  projectDirSuggestion,
  resolveProjectRoot,
  slugifyIdea,
} from "./lib/project-dir";
import { basenameOf, isWithinDir, parentOf, samePath } from "./lib/paths";
import {
  canvasSourceFor,
  canvasSubject,
  conversationSubject,
  liveSessionsForFocus,
  liveSessionsForProject,
  mergeSubjectRuns,
  projectRootForAgent,
  rootContains,
  runsForSubject,
  selectedRunForSubject,
  sessionForFocus,
  sessionReachesFocus,
  shownRunForSubject,
} from "./lib/session-scope";
import {
  canvasView,
  projectAbove,
  studioCanvasView,
  stepsDisabledReason,
  secretsDisabledReason,
  type ProjectRef,
} from "./lib/canvas-altitude";
import { mostSpecificStudioScope } from "./lib/agent-map";
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
  composerScaffoldPrompt,
  firstInstructionPrompt,
  useTemplatePrompt,
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
import { getTheme, toggleTheme } from "./lib/theme";
import { loadUiPrefs, saveUiPrefs } from "./lib/ui-prefs";
import {
  useNavigationHistory,
  type NavigationVisit,
} from "./lib/navigation-history";
import {
  buildIdeaWithAttachments,
  materializeAttachments,
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
import {
  isWorkflowRunnable,
  workflowDeploymentState,
} from "./lib/workflow-deployment";
import { SecretsPanel } from "./components/SecretsPanel";

type RightTab = "canvas" | "steps" | "secrets";

/**
 * The roots this install knows it has opened.
 *
 * Module-level because two callers need it and they must not diverge: the
 * shell below (where `state` exists) and the Cmd/Ctrl+1..9 handler, which runs
 * above the loading guard and would otherwise carry a second, hand-inlined
 * copy of the same list — the tab a number key selects has to be the tab the
 * strip rendered.
 *
 * `launchDir` is included because a first boot records the launch directory
 * before `recentDirs` has it, and that is exactly the session whose cwd
 * matters most. Session cwds are deliberately NOT roots: a session an older
 * build left rooted in an agent's own folder would then be the longest "root"
 * containing that agent, and SAP-2927's bug would resolve itself straight back
 * into place. `projectRoot` is not one either — it is where NEW projects are
 * created (a parent of many projects), so treating it as a root would boot
 * every agent under it in the same shared folder.
 */
const knownRootsOf = (
  recentDirs: readonly string[] | undefined,
  launchDir: string | null | undefined,
): string[] => [...(recentDirs ?? []), ...(launchDir ? [launchDir] : [])];

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

interface CreateSessionAtOptions {
  /** Keep the create-new queue mounted while inline files are materialized. */
  keepComposerOpen?: boolean;
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
  // The composer-first "new session" home. `composing` is explicit rail
  // Create-new intent; the workbench tab + starts a sibling directly instead.
  // The home also shows whenever nothing else claims the centre pane.
  const [composing, setComposing] = useState(false);
  // The tab + is a one-at-a-time create/bind transaction. State renders the
  // pending affordance; the ref closes React's same-frame double-click window.
  const [siblingSessionPending, setSiblingSessionPending] = useState(false);
  const siblingSessionPendingRef = useRef(false);
  // The focused agent (or bare-scaffold folder) path — the rail's single
  // selection and the main panel's tab-strip subject. The active tab's
  // session is harness.activeSessionId.
  const [focusedAgentPath, setFocusedAgentPath] = useState<string | null>(null);
  // The project the canvas is at MAP altitude for. Not a destination any more
  // (SAP-2980): the chat stays in the centre and the map draws beside it, so
  // this selects a SUBJECT rather than replacing the workbench.
  //
  // ONE value, not the key and a parallel meta record it used to be: half the
  // doors cleared only the key and left the meta behind, so every reader had to
  // re-check that the two still described the same project. A single ref cannot
  // half-clear.
  const [selectedProject, setSelectedProject] = useState<ProjectRef | null>(
    null,
  );
  const [studioSelection, setStudioSelection] =
    useState<StudioWorkspaceSelection | null>(null);
  const restoredStudioProjectsRef = useRef(new Set<string>());
  const studioRestoreGenerationRef = useRef(0);
  const plannerProjectId =
    studioSelection?.kind === "agent-map" ? studioSelection.projectId : null;
  const handlePlannerReady = useCallback(
    (
      response: { session: HarnessSession },
      mode: PlannerSessionRequest["mode"],
    ): void => {
      const selected = harness.state?.sessions.find(
        (session) => session.id === harness.activeSessionId,
      );
      // An explicit palette/history selection is more specific than the
      // project-level resume ordering. Keep that chosen live tab; fresh mode
      // remains an explicit request to select the newly-created planner.
      if (
        mode === "resume-or-create" &&
        selected?.status !== "exited" &&
        selected?.planning?.identity.role === "map-planner" &&
        selected.planning.identity.projectId ===
          response.session.planning?.identity.projectId
      ) {
        return;
      }
      harness.setActiveSessionId(response.session.id);
    },
    [
      harness.activeSessionId,
      harness.setActiveSessionId,
      harness.state?.sessions,
    ],
  );
  const activePlannerForProject = harness.state?.sessions.find(
    (session) =>
      session.id === harness.activeSessionId &&
      session.status !== "exited" &&
      session.planning?.identity.role === "map-planner" &&
      session.planning.identity.projectId === plannerProjectId,
  );
  const agentMapEntry = useAgentMapEntry({
    projectId: plannerProjectId,
    selectedPlanner: activePlannerForProject ?? null,
    api: harness.api,
    harness: () =>
      loadUiPrefs().preferredHarness === "codex" ? "codex" : "claude-code",
    theme: getTheme,
    openPlannerSession: harness.openPlannerSession,
    onPlannerReady: handlePlannerReady,
    subscribeProposalChanges: harness.subscribeAgentMapProposalChanges,
    subscribeReconnects: harness.subscribeEventReconnects,
  });

  // A project visit restores its server-owned preference before choosing an
  // altitude. Once map is chosen, `useAgentMapEntry` owns the independent map
  // and planner requests; preference restoration must not couple their fate.
  useEffect(() => {
    const state = harness.state;
    const active = state?.sessions.find(
      (session) => session.id === harness.activeSessionId,
    );
    if (!state?.studioProjects || !active) return;
    const scope = mostSpecificStudioScope(
      active.boundWorkflowPath ?? active.cwd,
      state.workspaceScopes ?? [],
      state.studioProjects,
    );
    const project = state.studioProjects.find(
      (candidate) => candidate.projectId === scope?.projectId,
    );
    if (
      !scope?.projectId ||
      !project ||
      restoredStudioProjectsRef.current.has(project.projectId)
    )
      return;
    restoredStudioProjectsRef.current.add(project.projectId);
    const generation = ++studioRestoreGenerationRef.current;
    void harness.api
      .getStudioCurrentWorkspace(project.projectId)
      .then((current) => {
        if (generation !== studioRestoreGenerationRef.current) return;
        const restoredSelection = current.selection;
        const workflow =
          restoredSelection.kind === "agent"
            ? state.workflows.find((candidate) =>
                candidate.studioBindings?.some(
                  (binding) =>
                    binding.projectId === restoredSelection.projectId &&
                    binding.agentId === restoredSelection.agentId,
                ),
              )
            : null;
        if (workflow && restoredSelection.kind === "agent") {
          setStudioSelection(restoredSelection);
          setSelectedProject(null);
          setFocusedAgentPath(workflow.path);
          return;
        }
        setStudioSelection({ kind: "agent-map", projectId: project.projectId });
        setSelectedProject(null);
        setFocusedAgentPath(scope.cwd);
        if (isMobile) setRightCollapsed(true);
      })
      .catch(() => {
        if (generation !== studioRestoreGenerationRef.current) return;
        // Preference storage is not either pane's authority. Fall back to the
        // project's default Agent Map once so later session-status frames do
        // not repeatedly reset selection or close the mobile map sheet.
        setStudioSelection({ kind: "agent-map", projectId: project.projectId });
        setSelectedProject(null);
        setFocusedAgentPath(scope.cwd);
        if (isMobile) setRightCollapsed(true);
      });
  }, [harness.activeSessionId, harness.api, harness.state, isMobile]);

  // A selected agent that disappears falls back to its map in memory. Only
  // the server knows whether the project scan is complete enough to persist a
  // deletion repair, so the client re-reads and never PUTs a guessed map.
  useEffect(() => {
    const state = harness.state;
    if (studioSelection?.kind !== "agent" || !state) return;
    if (
      state.workflows.some((workflow) =>
        workflow.studioBindings?.some(
          (binding) =>
            binding.projectId === studioSelection.projectId &&
            binding.agentId === studioSelection.agentId,
        ),
      )
    )
      return;
    const scope = state.workspaceScopes?.find(
      (candidate) => candidate.projectId === studioSelection.projectId,
    );
    const project = state.studioProjects?.find(
      (candidate) => candidate.projectId === studioSelection.projectId,
    );
    if (!scope || !project) return;
    const generation = ++studioRestoreGenerationRef.current;
    void harness.api
      .getStudioCurrentWorkspace(project.projectId)
      .then((current) => {
        if (
          generation !== studioRestoreGenerationRef.current ||
          current.selection.kind !== "agent-map" ||
          !current.repaired
        )
          return;
        setStudioSelection(current.selection);
        setSelectedProject(null);
        setFocusedAgentPath(scope.cwd);
        if (isMobile) setRightCollapsed(true);
      })
      .catch(() => {});
  }, [harness.api, harness.state, isMobile, studioSelection]);
  // The project whose FIRST session is being created. The centre pane says so
  // while the POST and the pty spawn resolve; without it a project you have
  // just selected flashes the create-new composer for the length of a session
  // start, which reads as "this project has nothing to talk to".
  const [startingProject, setStartingProject] = useState<{
    root: string;
    label: string;
  } | null>(null);
  const startingProjectRootsRef = useRef(new Set<string>());
  /**
   * The project a create-agent dialog is open for (SAP-2981), or null.
   *
   * It holds the SUBJECT, not a form: the row that was clicked answers "where",
   * and the dialog only asks what that row cannot. `sessionId` is set by the
   * bare-project door, where a live session in the folder is already the
   * session the new agent should bind to.
   */
  const [creatingAgent, setCreatingAgent] = useState<{
    root: string;
    label: string;
    sessionId?: string;
  } | null>(null);
  /**
   * Leave map altitude — unless the thing being opened lives INSIDE the
   * selected project.
   *
   * The tab `+`, a click on one of the project's own tabs, and a palette
   * "new session in this folder" all open something that BELONGS to the
   * project on screen. Closing its map under them would be the mode switch
   * this epic removes, one click later. A functional updater so the rule can
   * be applied from handlers that do not close over the current selection.
   */
  const leaveProjectUnlessInside = useCallback((cwd: string | null): void => {
    setSelectedProject((current) =>
      current && cwd && rootContains(current.root, cwd) ? current : null,
    );
    setStudioSelection((current) => {
      if (!current || !cwd) return null;
      const ownsTarget = (harness.state?.workspaceScopes ?? []).some(
        (scope) =>
          scope.projectId === current.projectId &&
          rootContains(scope.cwd, cwd),
      );
      return ownsTarget ? current : null;
    });
  }, [harness.state]);
  // "Open in Studio" deep links (sapiom://agent/<id>). The applier is a ref
  // because it needs `state`/`handleFocusAgent`, which exist only past the loading
  // guard; the effects below reach it through the ref. The cold-start target rides
  // in on the ?agent=/?template= load-URL param; warm links come via the desktop bridge.
  const applyDeepLinkRef = useRef<((target: DeepLinkTarget) => void) | null>(
    null,
  );
  const focusExistingRef = useRef<((definitionId: string) => boolean) | null>(
    null,
  );
  // Selecting a project (rail row, map glyph, the board's way back, a
  // Back/Forward replay) — assigned past the loading guard for the same reason
  // as the two refs above.
  const selectProjectRef = useRef<
    ((workspaceKey: WorkspaceKey, root: string, label: string) => void) | null
  >(null);
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
  // here so the tab strip and the header re-render together on a rename.
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
  // the collapse-panel toggle in the shared tab bar. The active CanvasPane or
  // AgentMapPane lifts its own frame without remounting the graph.
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
  // The (session + bound workflow) whose EMPTY board is settled: either we
  // auto-collapsed it, or the user has opened the pane over it themselves.
  // onCanvasState fires on every probe/reload/re-render; content always reveals
  // (even a pane the user had collapsed), but an empty board collapses only ONCE
  // per (session, binding) — so a "still empty" probe can't re-close a pane the
  // user opened, whether it arrives before or after the click, while a genuine
  // session/binding change still collapses.
  const emptyCollapsedKeyRef = useRef<string | null>(null);
  // The session whose pane the user opened BY HAND — an empty board never
  // re-closes it, however late that session's probe lands. The (session,
  // binding) key above can't carry this: the click routinely happens while the
  // session it belongs to is still being created (the agent's Start button
  // reveals the workbench before `activeSessionId` exists), and the probe then
  // arrives under a *different* key and slams the pane shut. So a claim made
  // with no active session is PENDING: it adopts whichever session reports
  // next. Any later session re-arms the collapse.
  const manualExpandSessionRef = useRef<string | null>(null);
  const manualExpandPendingRef = useRef(false);
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
  // Cmd/Ctrl+1..9 selects the nth TAB of the FOCUSED agent (same oldest-first
  // order the tab strip renders), not an arbitrary global session.
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
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        // The same subject the strip renders, resolved by the same function:
        // the ACTIVE session's project, not the rail selection. Keyed to the
        // selection, Cmd+1 would address tabs that are not on screen the moment
        // the selection and the session diverge (SAP-2931), and resolved by a
        // second copy of the rule it would address a different list than the one
        // the user is counting along.
        const sessions = harness.state?.sessions ?? [];
        const subject = conversationSubject(
          sessions.find((s) => s.id === harness.activeSessionId) ?? null,
          focusedAgentPath,
          // The SELECTED project, exactly as the strip passes it. Left null
          // here, the two resolvers agree only while the active session is live
          // and inside a known root — so a project selected over an exited
          // session, or over one in a scaffold folder `recentDirs` has not
          // recorded, gave the strip the project's tabs and this handler
          // somebody else's list. Cmd+1 then activated a session that was not
          // tab 1.
          selectedProject?.root ?? null,
          knownRootsOf(harness.settings?.recentDirs, harness.state?.launchDir),
        );
        const tabs =
          studioSelection?.kind === "agent-map"
            ? sessions.filter(
                (session) =>
                  session.status !== "exited" &&
                  session.planning?.identity.role === "map-planner" &&
                  session.planning.identity.projectId ===
                    studioSelection.projectId,
              )
            : subject.kind === "project"
              ? liveSessionsForProject(sessions, subject.root)
              : liveSessionsForFocus(sessions, subject.path);
        const target = tabs[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          setComposing(false);
          setReviewSummary(null);
          leaveProjectUnlessInside(target.cwd);
          // A tab jump is a navigation: leave any full-width destination that
          // is standing in for the workbench, or it would linger over the tab.
          setTemplatesOpen(false);
          setOverviewOpen(false);
          harness.setActiveSessionId(target.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // EVERY input the two resolvers share, `activeSessionId` included. The
    // listener closes over its inputs, so an activation that moves neither the
    // focus nor the selection — clicking a tab — left this one holding the
    // previous active session while the strip had already recomputed. With
    // overlapping roots that is a different list, not a stale copy of the same
    // one: an outer project's strip lists a nested project's sessions, so
    // clicking one re-keys the strip to the nested root while a number key
    // still addressed the outer one, until the next session event healed it.
  }, [
    harness.state?.sessions,
    harness.activeSessionId,
    harness.settings?.recentDirs,
    focusedAgentPath,
    selectedProject,
    studioSelection,
    isMobile,
    rightCollapsed,
    paletteOpen,
    settingsOpen,
    templatesOpen,
    overviewOpen,
  ]);

  // Where NEW agent projects are created — ONE value, shared by every surface
  // that creates one (the template door and the idea door). They used to
  // disagree: this dialog seeded its destination from the active session's cwd
  // while the scaffold path used whatever the user typed, so "where did my
  // project go?" had two answers. Precedence is
  // setting → host default → launch dir (see resolveProjectRoot).
  const projectRoot = resolveProjectRoot({
    settingsRoot: harness.settings?.projectRoot,
    defaultProjectRoot: harness.state?.defaultProjectRoot,
    launchDir: harness.state?.launchDir,
  });

  const saveProjectRoot = async (root: string): Promise<void> => {
    await harness.updateSettings({ projectRoot: root });
  };

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

  // First focus once state is ready: the active session's bound agent, or the
  // first agent INSIDE A PROJECT. Done once (a ref guard) so it never fights a
  // later user focus. Runs before the mobile-reset effect below — order is
  // stable.
  const didInitFocus = useRef(false);
  useEffect(() => {
    if (didInitFocus.current || !harness.state) return;
    didInitFocus.current = true;
    const active = harness.state.sessions.find(
      (s) => s.id === harness.activeSessionId,
    );
    /* AN AGENT THE USER CAN SEE (round 2).
       `workflows[0]` is registry order, and on a real install ~78 of 88 agents
       are outside every open project — so boot routinely landed on one of them:
       an agent the user never opened, in a section that is closed by default,
       with the whole app pointed at it and nothing on screen highlighted. An
       agent a project CONTAINS is one the rail is already showing.
       The fallback stays, because "no project contains anything" is a real
       state and focusing nothing would be worse than focusing something. */
    const openRoots = [
      ...(harness.settings?.recentDirs ?? []),
      ...harness.state.sessions.map((session) => session.cwd),
    ];
    const inAProject = harness.state.workflows.find((workflow) =>
      openRoots.some((root) => rootContains(root, workflow.path)),
    );
    setFocusedAgentPath(
      boundWorkflowPathOf(active) ??
        inAProject?.path ??
        harness.state.workflows[0]?.path ??
        null,
    );
  }, [harness.state, harness.activeSessionId, harness.settings]);

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

  // The map IS the answer to selecting a project, so the pane it draws in
  // cannot be closed underneath it. The board's own auto-collapse (an empty
  // agent board closes the pane) would otherwise leave a project selection
  // with nothing on screen but a chat — the mode switch inverted.
  useEffect(() => {
    // On mobile the coding-agent CLI is primary. Agent Map selection and
    // background loading never open the bottom sheet; its explicit button does.
    // Legacy System Graph selection keeps its established auto-open behavior.
    if (
      selectedProject ||
      (!isMobile && studioSelection?.kind === "agent-map")
    ) {
      setRightCollapsed(false);
    }
  }, [isMobile, selectedProject, studioSelection]);

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

  // The place the shell is showing, in the same precedence render uses. It is
  // derived rather than pushed at each door so every screen is navigable, and
  // recording it is idempotent: applying a visit re-derives the same place,
  // which dedupes against the tip instead of branching the stack.
  const recordVisit = navHistory.record;
  const activeSessionIdForNav = harness.activeSessionId;
  const focusHasLiveSession =
    focusedAgentPath != null &&
    liveSessionsForFocus(harness.state?.sessions ?? [], focusedAgentPath)
      .length > 0;
  // Set by applyVisit for the single re-derivation its state change triggers, so
  // the record effect skips that one run. Without it, replaying a Back/Forward
  // visit whose derived place has since changed KIND — e.g. a "session" whose
  // live CLI has since exited now re-derives as an "agent" visit — records a
  // mismatching visit, which pushNavigationVisit treats as a new branch and
  // truncates the forward stack. Guarding here keeps back/forward a pure replay.
  const applyingVisitRef = useRef(false);
  useEffect(() => {
    if (applyingVisitRef.current) {
      applyingVisitRef.current = false;
      return;
    }
    if (studioSelection?.kind === "agent-map") {
      recordVisit({ kind: "agent-map", projectId: studioSelection.projectId });
    } else if (selectedProject) {
      recordVisit({
        kind: "project",
        workspaceKey: selectedProject.workspaceKey,
        root: selectedProject.root,
        label: selectedProject.label,
      });
    } else if (templatesOpen) {
      recordVisit({ kind: "templates" });
    } else if (reviewSummary) {
      recordVisit({ kind: "review", summary: reviewSummary });
    } else if (composing) {
      recordVisit({ kind: "composer" });
    } else if (
      activeSessionIdForNav &&
      (focusedAgentPath == null || focusHasLiveSession)
    ) {
      recordVisit({
        kind: "session",
        sessionId: activeSessionIdForNav,
        agentPath: focusedAgentPath,
      });
    } else if (focusedAgentPath) {
      recordVisit({ kind: "agent", agentPath: focusedAgentPath });
    }
  }, [
    recordVisit,
    selectedProject,
    studioSelection,
    templatesOpen,
    reviewSummary,
    composing,
    activeSessionIdForNav,
    focusedAgentPath,
    focusHasLiveSession,
  ]);

  const setActiveSessionId = harness.setActiveSessionId;
  const applyVisit = useCallback(
    (visit: NavigationVisit | null): void => {
      if (!visit) return;
      studioRestoreGenerationRef.current += 1;
      // Replaying, not navigating: tell the record effect to skip the one run
      // this state change triggers, so it never re-derives-and-pushes (which
      // would truncate the forward stack). See applyingVisitRef above.
      applyingVisitRef.current = true;
      setOverviewOpen(false);
      setTemplatesOpen(visit.kind === "templates");
      setComposing(visit.kind === "composer");
      setReviewSummary(visit.kind === "review" ? visit.summary : null);
      if (
        visit.kind === "templates" ||
        visit.kind === "composer" ||
        visit.kind === "review"
      ) {
        setStudioSelection(null);
      }
      if (visit.kind === "project") {
        // Through the SAME door the rail click uses, not the raw setter: a
        // project selection now hands the conversation to that project (and
        // starts one where there is none), and a replayed visit that only
        // re-selected the key would land on the map with somebody else's chat
        // beside it. The ref exists because the handler closes over `state`,
        // which is only available past the loading guard.
        selectProjectRef.current?.(visit.workspaceKey, visit.root, visit.label);
      } else if (visit.kind === "agent-map") {
        const state = harness.state;
        const scope = state?.workspaceScopes?.find(
          (candidate) => candidate.projectId === visit.projectId,
        );
        const project = state?.studioProjects?.find(
          (candidate) => candidate.projectId === visit.projectId,
        );
        if (scope && project) {
          setStudioSelection({ kind: "agent-map", projectId: visit.projectId });
          setSelectedProject(null);
          setFocusedAgentPath(scope.cwd);
          if (isMobile) setRightCollapsed(true);
        }
      } else {
        setSelectedProject(null);
      }
      if (visit.kind === "session") {
        setFocusedAgentPath(visit.agentPath);
        setActiveSessionId(visit.sessionId);
      } else if (visit.kind === "agent") {
        setFocusedAgentPath(visit.agentPath);
      }
      if (visit.kind === "session" || visit.kind === "agent") {
        const state = harness.state;
        const workflow = state?.workflows.find(
          (candidate) => candidate.path === visit.agentPath,
        );
        const scope =
          workflow && state?.studioProjects
            ? mostSpecificStudioScope(
                workflow.path,
                state.workspaceScopes ?? [],
                state.studioProjects,
              )
            : null;
        const binding = workflow?.studioBindings?.find(
          (candidate) => candidate.projectId === scope?.projectId,
        );
        setStudioSelection(
          binding
            ? {
                kind: "agent",
                projectId: binding.projectId,
                agentId: binding.agentId,
              }
            : null,
        );
      }
    },
    [harness.state, isMobile, setActiveSessionId],
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
  // matching definitionId — focus it then, closing the "clone → display" loop.
  useEffect(() => {
    const wantId = pendingCloneFocusRef.current;
    if (wantId && focusExistingRef.current?.(wantId)) {
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
  const selectedStudioProject = studioSelection
    ? (state.studioProjects?.find(
        (project) => project.projectId === studioSelection.projectId,
      ) ?? null)
    : null;
  const selectedStudioWorkflow =
    studioSelection?.kind === "agent"
      ? (state.workflows.find((workflow) =>
          workflow.studioBindings?.some(
            (binding) =>
              binding.projectId === studioSelection.projectId &&
              binding.agentId === studioSelection.agentId,
          ),
        ) ?? null)
      : null;
  // Missing client inventory is an in-memory map fallback, never a durable
  // repair. The server owns the completeness decision in the effect above.
  const effectiveStudioSelection =
    studioSelection && selectedStudioProject
      ? studioSelection.kind === "agent" && !selectedStudioWorkflow
        ? ({
            kind: "agent-map",
            projectId: studioSelection.projectId,
          } satisfies StudioWorkspaceSelection)
        : studioSelection
      : null;
  const selectedStudioScopes = effectiveStudioSelection
    ? workspaceScopes.filter(
        (scope) => scope.projectId === effectiveStudioSelection.projectId,
      )
    : [];
  const selectedStudioScope =
    effectiveStudioSelection && selectedStudioProject
      ? mostSpecificStudioScope(
          selectedStudioWorkflow?.path ??
            focusedAgentPath ??
            activeSession?.cwd ??
            selectedStudioScopes[0]?.cwd ??
            "",
          selectedStudioScopes,
          [selectedStudioProject],
        )
      : null;
  const planFirstSelection = selectedStudioScope
    ? effectiveStudioSelection
    : null;
  const effectiveFocusedAgentPath =
    planFirstSelection?.kind === "agent" && selectedStudioWorkflow
      ? selectedStudioWorkflow.path
      : focusedAgentPath;
  const focusedWorkflow =
    planFirstSelection?.kind === "agent"
      ? selectedStudioWorkflow
      : (state.workflows.find((w) => w.path === effectiveFocusedAgentPath) ??
        null);
  /**
   * ONE selection, at ONE altitude — the contract the rail, the centre pane and
   * the canvas all read, so they cannot disagree about what is on screen (E3.8).
   */
  const legacyView = canvasView(selectedProject, effectiveFocusedAgentPath);
  const studioView = planFirstSelection
    ? studioCanvasView(planFirstSelection)
    : null;
  const view = studioView ?? legacyView;
  const atMapAltitude = view.altitude === "map";
  const planningWorkspace = studioView?.altitude === "map";
  const agentMapUnavailable =
    planningWorkspace && agentMapEntry.state.unavailable !== null;
  const plannerSessions = planningWorkspace
    ? state.sessions.filter(
        (session) =>
          session.status !== "exited" &&
          session.planning?.identity.role === "map-planner" &&
          session.planning.identity.projectId === studioView.projectId,
      )
    : [];
  const activePlannerSession =
    planningWorkspace &&
    activeSession?.status !== "exited" &&
    activeSession?.planning?.identity.role === "map-planner" &&
    activeSession.planning.identity.projectId === studioView.projectId
      ? activeSession
      : null;

  /**
   * Whose tabs the strip shows: the ACTIVE session's PROJECT (SAP-2980), never
   * the rail selection (SAP-2931).
   *
   * A chat belongs to a project, so the strip is the project's strip — which is
   * also what makes "selecting a sibling agent does not move the conversation"
   * true on screen and not merely in the session pointer: the agent selection
   * is not an input to the subject, so the tabs are literally the same set
   * before and after the click. Keyed to the selection instead, the strip
   * emptied itself while the session it belongs to kept running below it.
   */
  const conversation = conversationSubject(
    activeSession,
    effectiveFocusedAgentPath,
    planFirstSelection?.kind === "agent-map"
      ? (selectedStudioScope?.cwd ?? null)
      : (selectedProject?.root ?? null),
    knownProjectRoots(),
  );
  const focusTabs = planningWorkspace
    ? plannerSessions
    : conversation.kind === "project"
      ? liveSessionsForProject(state.sessions, conversation.root)
      : liveSessionsForFocus(state.sessions, conversation.path);
  const showReview = reviewSummary != null;
  const showDead =
    !planningWorkspace && !showReview && activeSession?.status === "exited";
  // An agent selected with no session that can WORK on it: honest absence, and
  // opening one lands on the "start a session" state.
  //
  // The question is reachability, not "does this agent have its own tabs"
  // (SAP-2931). A same-project selection deliberately keeps a session bound
  // elsewhere — under the old test the terminal vanished the moment you looked
  // at a sibling. But "any live session at all" is too weak in the other
  // direction: closing the last tab in a project falls back to whatever else is
  // running, which can be a session in a project that does not contain this
  // agent. `sessionReachesFocus` is the same containment question
  // `sessionForFocus` answers, so the derived state and the movement decision
  // cannot disagree. `composing` forces the composer over this.
  // At map altitude the selection is a PROJECT, so an agent's absence is not
  // what the centre is about. Measured on the real install: a project selected
  // while some other project's agent was still focused rendered "No running
  // session for <that agent>" beside the project's own map — the conversation
  // the map is supposed to sit beside, hidden by a row nobody had selected.
  const showAgentEmpty =
    !showReview &&
    !showDead &&
    !planningWorkspace &&
    !composing &&
    !atMapAltitude &&
    focusedWorkflow != null &&
    !sessionReachesFocus(
      activeSession,
      effectiveFocusedAgentPath,
      knownProjectRoots(),
    );
  // The workbench: a live active session.
  const showWorkbench =
    !showReview &&
    !showDead &&
    !planningWorkspace &&
    !composing &&
    !showAgentEmpty &&
    activeSession != null &&
    activeSession.status !== "exited";
  // A project selected with no session yet: its first one is on the way, and
  // the centre says so rather than flashing the create-new composer.
  const showProjectStarting =
    !planningWorkspace &&
    !showReview &&
    !showDead &&
    !composing &&
    !showWorkbench &&
    startingProject != null;
  // The composer-first "new session" home: explicit intent, or nothing else to
  // show (first run, or every session closed). Replaces the WelcomePanel overlay
  // AND the old "No active session" fallback.
  const showComposer =
    !showReview &&
    !showDead &&
    !planningWorkspace &&
    !showProjectStarting &&
    (composing || (!showAgentEmpty && !showWorkbench));
  /** The project a board can cut UP to — derived, so the way back is the same
   *  door whether the agent was reached from the rail or from the map. */
  const upToProject = atMapAltitude
    ? null
    : projectAbove(
        effectiveFocusedAgentPath,
        knownProjectRoots(),
        workspaceScopes,
      );
  const stepsDisabled = stepsDisabledReason(view.altitude);
  const secretsDisabled = secretsDisabledReason(view.altitude);
  // At map altitude the map IS the canvas panel, so a stored `steps` intent is
  // held (it restores on the way back down) but never rendered.
  const shownTab: RightTab =
    (stepsDisabled && rightTab === "steps") ||
    (secretsDisabled && rightTab === "secrets")
      ? "canvas"
      : rightTab;
  const rightPaneSuppressedByComposer =
    (showComposer && !atMapAltitude) || agentMapUnavailable;
  const sessionBarSession = planningWorkspace
    ? activePlannerSession
    : showWorkbench || showDead
      ? activeSession
      : null;
  // A live session to return to when the composer was opened over the workbench.
  const composerCanCancel =
    composing && activeSession != null && activeSession.status !== "exited";

  /**
   * THE subject (SAP-2931). Canvas, Steps, the Code tab, the lifecycle verbs
   * and the run evidence are all projections of this ONE value — the rail
   * selection, pure UI state, with no session relationship. Binding stopped
   * being how the board is chosen. If two of those surfaces can disagree about
   * what they are about, that is a bug by contract, so they read one name.
   *
   * An agent with no session is no longer a hole: IA-01's workflow-keyed route
   * serves its board (see `canvasSource` below), so `showAgentEmpty` speaks
   * only for the main panel now, not for the right pane.
   */
  const rightPaneWorkflow = canvasSubject({
    selection: focusedWorkflow,
    // Nothing to project: the create-new draft or a past-session review owns
    // the centre, and an absence must not have another agent's board behind it.
    suppressed: showComposer || showReview,
  });
  /** Which of the two canvas entry points can serve that subject's board. */
  const canvasSource = canvasSourceFor({
    subjectPath: rightPaneWorkflow?.path ?? null,
    bindingPath: boundWorkflowPath,
    sessionId: harness.activeSessionId,
  });
  // Identity of the board the auto-collapse reasons about (see
  // emptyCollapsedKeyRef). Carries the subject, so selecting another agent is a
  // new board to reason about rather than a redundant probe for the old one.
  const emptyBoardKey = `${harness.activeSessionId ?? ""}::${rightPaneWorkflow?.path ?? ""}`;
  const expandRightPane = (): void => {
    manualExpandSessionRef.current = harness.activeSessionId ?? null;
    manualExpandPendingRef.current = harness.activeSessionId == null;
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
   * Run evidence for the SUBJECT, not for the session (SAP-2931).
   *
   * Runs are announced to the session BOUND to a workflow, so once the
   * selection and the session diverge a run addressed to the binding never
   * lands on the visible pane — the surface whose whole job is saying what ran
   * goes quiet. So the evidence is attributed to the subject, and it comes from
   * two places: what the ACTIVE session announced, plus what any OTHER live
   * session announced for this same agent and this one never heard.
   *
   * The merge is what needs the bound. In the prototype a second source folded
   * its whole history in beside the trimmed observed ids and the run picker
   * offered 309 runs in a client that retains 200 and can reopen none of the
   * rest, so both sides pass through `mergeSubjectRuns` and its window.
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
  // subject (a stale pick heals itself when the selection changes rather than
  // pinning one agent's run onto another's board), else the subject's newest.
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

  const closeMobileDrawer = (): void => {
    if (isMobile) setRailCollapsed(true);
  };

  /**
   * The rail verb: SELECT a project.
   *
   * A project is somewhere you WORK, not somewhere you look (SAP-2980), so
   * this does two things that used to be one. The canvas goes to map altitude
   * — and the conversation becomes the project's, through the SAME decision
   * function an agent selection uses. Reusing it is the point: crossing from
   * one project to another has to hand the conversation over exactly once,
   * with one rule, and a second hand-written copy here is how the two answers
   * come to disagree.
   *
   * A project with no live session gets one at its root. Otherwise a project is
   * a row you can select but cannot talk to — an empty workbench beside a map,
   * which is the failure this criterion names.
   */
  const handleSelectWorkspace = (
    workspaceKey: WorkspaceKey,
    root: string,
    label: string,
  ): void => {
    studioRestoreGenerationRef.current += 1;
    const studioProjectId = workspaceScopes.find(
      (scope) => scope.workspaceKey === workspaceKey,
    )?.projectId;
    let selectedAgentMap = false;
    if (
      studioProjectId &&
      state.studioProjects?.some(
        (project) => project.projectId === studioProjectId,
      )
    ) {
      restoredStudioProjectsRef.current.add(studioProjectId);
      const selection: StudioWorkspaceSelection = {
        kind: "agent-map",
        projectId: studioProjectId,
      };
      setStudioSelection(selection);
      setSelectedProject(null);
      void harness.api.putStudioCurrentWorkspace(studioProjectId, selection);
      selectedAgentMap = true;
    } else {
      setStudioSelection(null);
      setSelectedProject({ workspaceKey, root, label });
    }
    // ONE selection: the rail selection IS the project now, so the agent that
    // happened to be focused before stops being what any surface is about.
    // Leaving it behind is what put another project's "no running session"
    // state in the centre, beside this project's map.
    setFocusedAgentPath(root);
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    closeMobileDrawer();
    // Stable Studio projects talk through their trusted map-planner. The
    // selection effect starts resume-or-create; an ordinary project-root PTY
    // here would race it and briefly make the wrong conversation authoritative.
    if (selectedAgentMap) {
      if (isMobile) setRightCollapsed(true);
      return;
    }
    const decision = sessionForFocus({
      focusPath: root,
      active: activeSession,
      sessions: state.sessions,
      roots: knownProjectRoots(),
    });
    if (decision.kind === "keep") return;
    if (decision.to) {
      if (decision.to.id !== harness.activeSessionId)
        harness.setActiveSessionId(decision.to.id);
      return;
    }
    void startProjectSession(root, label);
  };
  selectProjectRef.current = handleSelectWorkspace;

  /**
   * Open the first session of a project you just selected.
   *
   * Guarded BY ROOT, not by a boolean: two projects can be starting at once
   * (select one, select another before the first POST resolves) and a single
   * flag would drop the second create silently. Re-selecting the SAME project
   * mid-flight is the double-create this prevents.
   */
  const startProjectSession = async (
    root: string,
    label: string,
  ): Promise<void> => {
    if (startingProjectRootsRef.current.has(root)) return;
    startingProjectRootsRef.current.add(root);
    setStartingProject({ root, label });
    try {
      await createSessionAt(root, "claude-code");
    } catch (err) {
      harness.showToast(
        (err as Error).message || `Couldn't start a session in ${label}.`,
      );
    } finally {
      startingProjectRootsRef.current.delete(root);
      setStartingProject((current) =>
        current?.root === root ? null : current,
      );
    }
  };

  /**
   * The provider a create-initiated session boots with — the same stored
   * preference the rail used to read before it dispatched. It moved here with
   * the create itself; the rail no longer starts sessions.
   */
  const preferredHarness = (): HarnessKind =>
    loadUiPrefs().preferredHarness === "codex" ? "codex" : "claude-code";

  /**
   * The ONE answer to "where does a session for this agent boot" (SAP-2927).
   *
   * Every path that starts a session ON AN EXISTING AGENT — the tab-strip `+`,
   * the workbench empty-state Start, the command palette, and the bind path —
   * goes through here. The paths that create a session for a BRAND-NEW project
   * folder (scaffold, templates, the composer, a deep-link clone) deliberately
   * do not: that folder is the new project's root by construction, and
   * resolving it upward would drop the new agent into its parent project.
   */
  const sessionCwdForAgent = (agentPath: string): string =>
    projectRootForAgent(agentPath, knownProjectRoots());

  // The ONE choke point for session creation: sets the focus to the new
  // session's folder (so the main panel shows it) and fires telemetry once.
  // `cwd` is already a project root by the time it gets here — resolve it with
  // `sessionCwdForAgent` at the entry point, not in here, because the
  // new-project doors legitimately pass a folder that no root should swallow.
  const createSessionAt = async (
    cwd: string,
    agentHarness: HarnessKind,
    options: CreateSessionAtOptions = {},
  ): Promise<HarnessSession> => {
    if (!options.keepComposerOpen) setComposing(false);
    setReviewSummary(null);
    // A session started INSIDE the selected project is one of ITS tabs — the
    // tab `+`, the palette's "new session in this folder", the project's own
    // first session. Closing its map under them would be the mode switch this
    // epic removes, one click later.
    leaveProjectUnlessInside(cwd);
    setOverviewOpen(false);
    setFocusedAgentPath(cwd);
    // Show the folder in the rail immediately — before the session POST, the pty
    // spawn, and the agent's scaffold/clone all resolve — so switching away
    // mid-creation never loses the in-progress agent. Cleared on failure so a
    // rejected create leaves no ghost row; cleared automatically on success once
    // the real session/agent lands (see the store's pruning effect).
    harness.addPendingWorkspace(cwd);
    closeMobileDrawer();
    try {
      const session = await harness.createSession({
        cwd,
        harness: agentHarness,
      });
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
   * The composer's scaffold prompt — the ONE door left where the coding agent
   * creates the project (SAP-2981).
   *
   * Everywhere the project is already known, the harness creates the agent
   * itself (`handleCreateAgentInProject` below). The composer is the home
   * screen: no project, no name, just an idea, and the folder it invents does
   * not exist yet — so there is nothing here to state and no row to create in.
   * The prompt is honest about being a prompt, and its failure message names
   * the tool the user would have to ask for by hand.
   */
  const sendScaffoldPrompt = (
    session: HarnessSession,
    cwd: string,
    idea?: string,
  ): void => {
    sendPromptWhenReady(
      session.id,
      composerScaffoldPrompt(cwd, idea),
      "Couldn't send the scaffold prompt. Ask the coding agent to call sapiom_dev_agents_scaffold.",
    );
  };

  // The idea-to-agent path. Starts a session at the (new) folder, then
  // hands the agent the scaffold prompt.
  /**
   * Start a session at `cwd` and hand the agent the scaffold prompt.
   *
   * `idea` is what the "start from an idea" door collects. It rides along
   * verbatim — the agent needs the intent, not our paraphrase of it. Omitted
   * (door 1's plain/new outcomes, the bare-folder affordance), the prompt keeps
   * the same default-starter path without inventing an idea for the user.
   */
  const handleScaffoldSession = async (
    cwd: string,
    agentHarness: HarnessKind,
    idea?: string,
  ): Promise<void> => {
    const session = await createSessionAt(cwd, agentHarness);
    sendScaffoldPrompt(session, cwd, idea);
  };

  /**
   * THE IN-PROJECT CREATE (SAP-2981; design.md § E4).
   *
   * The `+` on a project row used to start a session and inject an English
   * sentence asking the coding agent to please call the scaffold MCP tool. The
   * harness does it now: the dialog collects a name and a starter, the endpoint
   * creates the directory and rescans it, and only THEN does a session open.
   *
   * The order is the feature. Creation completes before the chat starts, so a
   * failure is a sentence in the dialog rather than a confused model, and the
   * agent is a row in the rail before anything can ask "did it work?".
   *
   * The project is not asked for — it is the row that was clicked.
   */
  const handleCreateAgentInProject = (root: string, label: string): void => {
    setCreatingAgent({ root, label });
  };

  /**
   * THE ONE CREATE VERB'S SECOND STEP — and it never types English at anyone.
   *
   * The rail's create control used to call `onNewSession`, which set
   * `composing` and ended at `sendScaffoldPrompt`: a session at a folder
   * invented from a slug of the user's sentence, then an English request that
   * the coding agent please call `sapiom_dev_agents_scaffold`. That is the
   * mechanism SAP-2981 set out to remove, still wired to the most prominent
   * control in the product, and it failed the way a prompt fails — a create
   * that did not happen arrived as a confused model rather than an error.
   *
   * `aaf721bb` (#790) had already fixed the project-row doors, and the fix is
   * the same one: WHEN A PROJECT HAS A DURABLE STUDIO PROJECT, ITS AGENT MAP
   * OWNS CREATION. So this resolves the folder to a project and hands over to
   * the map, exactly as selecting the project does — `handleSelectWorkspace`'s
   * map branch, run against the state that comes back from opening the folder
   * rather than the render's own copy of it, which is one refresh stale here.
   *
   * The folder does not have to be a project yet. `openProject` is what makes
   * it one (and resolves an agent's own folder to the folder that HOLDS it),
   * and after PR "one definition of what a project is" the server issues a
   * durable Studio project for exactly that root, so the map is there when we
   * ask for it.
   *
   * A payload with no Studio project catalog is the one case the map cannot
   * serve. That is not a reason to keep the injection: it falls through to
   * `handleCreateAgentInProject`, the dialog whose endpoint creates the agent
   * on disk and rescans before any session starts. Still the harness creating
   * the agent; still no sentence sent to a model.
   */
  const handleNewAgentIn = async (
    root: string,
    label?: string,
  ): Promise<void> => {
    const openedRoot = await harness.openProject(root);
    const refreshed = await harness.api.getState();
    const scope = refreshed.workspaceScopes?.find((candidate) =>
      samePath(candidate.cwd, openedRoot),
    );
    const project = refreshed.studioProjects?.find(
      (candidate) => candidate.projectId === scope?.projectId,
    );
    const name = label ?? basenameOf(openedRoot);
    if (!scope || !project) {
      handleCreateAgentInProject(openedRoot, name);
      return;
    }
    studioRestoreGenerationRef.current += 1;
    restoredStudioProjectsRef.current.add(project.projectId);
    const selection: StudioWorkspaceSelection = {
      kind: "agent-map",
      projectId: project.projectId,
    };
    setStudioSelection(selection);
    setSelectedProject(null);
    setFocusedAgentPath(scope.cwd);
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    closeMobileDrawer();
    if (isMobile) setRightCollapsed(true);
    await harness.api
      .putStudioCurrentWorkspace(project.projectId, selection)
      .catch(() => {
        // The map is already selected. Remembering it is best effort and must
        // not turn a completed navigation into a failure.
      });
  };

  const createAgentInProject = async (input: {
    name: string;
    template: string;
    instruction: string;
  }): Promise<void> => {
    const request = creatingAgent;
    if (!request) return;
    // Throws on refusal, and the dialog shows the server's own sentence. It
    // resolves only once the agent is on disk AND in the registry.
    const created = await harness.scaffoldAgent(
      request.root,
      input.name,
      input.template,
    );
    setCreatingAgent(null);
    // The rail already has it (the server rescanned before answering); this is
    // the selection following the thing the user just made.
    setSelectedProject(null);
    setFocusedAgentPath(created.path);
    studioRestoreGenerationRef.current += 1;
    // Creation is an explicit agent transition, but it does not write an
    // Agent Map node. Resolve the server-issued project-scoped binding after
    // the registry rescan and persist only that workspace preference.
    try {
      const refreshed = await harness.api.getState();
      const projectId = refreshed.workspaceScopes?.find((scope) =>
        samePath(scope.cwd, request.root),
      )?.projectId;
      const workflow = refreshed.workflows.find((candidate) =>
        samePath(candidate.path, created.path),
      );
      const binding = workflow?.studioBindings?.find(
        (candidate) => candidate.projectId === projectId,
      );
      if (binding) {
        const selection: StudioWorkspaceSelection = {
          kind: "agent",
          projectId: binding.projectId,
          agentId: binding.agentId,
        };
        setStudioSelection(selection);
        await harness.api.putStudioCurrentWorkspace(
          binding.projectId,
          selection,
        );
      }
    } catch {
      // The agent and registry update already succeeded. Preference syncing is
      // best-effort and must not turn that completed create into a failure.
    }

    // EVERYTHING BELOW IS THE CHAT, and the agent already exists. A session
    // that fails to start is a session failure, reported as one — it must
    // never read as "the agent wasn't created", because it was.
    try {
      // A LIVE one, or none. The bare-project door names the session that was
      // sitting in that folder when the dialog opened, and a dialog can stay
      // open longer than a pty lives — binding the new agent to an exited
      // session would leave it with nothing to talk to.
      const existing = request.sessionId
        ? (state.sessions.find(
            (s) => s.id === request.sessionId && s.status !== "exited",
          ) ?? null)
        : null;
      const session =
        existing ??
        (await createSessionAt(request.root, preferredHarness()));
      await harness.bindWorkflow(session.id, created.path);
      harness.setActiveSessionId(session.id);
      setFocusedAgentPath(created.path);
      if (input.instruction) {
        sendPromptWhenReady(
          session.id,
          firstInstructionPrompt(created.path, input.instruction),
          "Couldn't send your first instruction — the agent is created; type it into the terminal.",
        );
      }
    } catch (err) {
      harness.showToast(
        `${created.name} was created, but its session didn't start. ${errorMessage(err, "")}`.trim(),
      );
    }
  };

  // The workbench tab + starts a fresh coding-agent process beside the active
  // session. Folder, provider, and optional agent binding carry over; prompt,
  // transcript, resume identity, and rehydration deliberately do not.
  //
  // The folder carries over RESOLVED (SAP-2927): a source session an older
  // build left rooted in the agent's own directory is the bug, not a workspace
  // worth inheriting, so the sibling boots at the project root instead. A
  // source already rooted at a known root resolves to itself.
  const handleStartSiblingSession = (source: HarnessSession): void => {
    if (siblingSessionPendingRef.current) return;

    siblingSessionPendingRef.current = true;
    setSiblingSessionPending(true);
    const focusBeforeCreate = focusedAgentPath;
    const workflowPath = boundWorkflowPathOf(source);
    const workflowName = workflowPath
      ? (state.workflows.find((workflow) =>
          samePath(workflow.path, workflowPath),
        )?.name ?? basenameOf(workflowPath))
      : null;

    // Resolved once, and reused for the unbound-focus fallbacks below: focus
    // has to name the folder the session ACTUALLY booted in, or an unbound
    // sibling drops out of its own tab strip (liveSessionsForFocus matches an
    // unbound session by cwd).
    const cwd = sessionCwdForAgent(source.cwd);

    void (async () => {
      try {
        const session = await createSessionAt(cwd, source.harness);
        if (!workflowPath) {
          setFocusedAgentPath(cwd);
          return;
        }

        try {
          await harness.bindWorkflow(session.id, workflowPath);
          setFocusedAgentPath(workflowPath);
        } catch {
          // Creation already succeeded. Keep that independent process alive
          // and visible as an unbound folder session rather than rolling it
          // back because the secondary binding write failed.
          setFocusedAgentPath(cwd);
          harness.showToast(
            `Session started, but couldn't attach it to ${workflowName ?? "the agent"}.`,
          );
        }
      } catch {
        // createSessionAt focuses the requested cwd optimistically. Restore
        // the source exactly when no new session was created.
        setFocusedAgentPath(focusBeforeCreate ?? workflowPath ?? source.cwd);
        harness.setActiveSessionId(source.id);
        harness.showToast("Couldn't start the session.");
      } finally {
        siblingSessionPendingRef.current = false;
        setSiblingSessionPending(false);
      }
    })();
  };

  // The focused-agent empty state's Start creates the first session. This is
  // distinct from the tab + because there is no source provider to inherit.
  //
  // It boots at the agent's PROJECT ROOT (SAP-2927), binds there, and focuses
  // the agent so the new session joins its tab strip. An existing session of
  // this agent still wins the cwd, but only when that session is itself rooted
  // at a known root: joining a colleague's tab keeps a second opened root (an
  // agent files under every root that contains it) instead of silently
  // re-rooting you elsewhere, while a session left in the agent's own folder
  // is the bug, and its cwd is discarded rather than inherited.
  const handleStartSessionForAgent = (workflow: WorkflowInfo): void => {
    void (async () => {
      const roots = knownProjectRoots();
      const owner = liveSessionsForFocus(state.sessions, workflow.path).find(
        (session) => roots.some((root) => samePath(root, session.cwd)),
      );
      const cwd = owner?.cwd ?? sessionCwdForAgent(workflow.path);
      try {
        const session = await createSessionAt(cwd, "claude-code");
        await harness.bindWorkflow(session.id, workflow.path);
        setFocusedAgentPath(workflow.path);
      } catch (err) {
        harness.showToast(
          (err as Error).message || "Couldn't start the session.",
        );
      }
    })();
  };

  /**
   * Bare-project affordance: a live session sits in a folder with no agent yet.
   *
   * It used to inject the scaffold prompt into that session — the third copy of
   * the same English sentence. It is the same create as any other project now,
   * aimed at the session's own folder, and the session it already has is the
   * one the new agent binds to rather than a second pty beside it.
   */
  const handleScaffoldInSession = (sessionId: string): void => {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setCreatingAgent({
      root: session.cwd,
      label: basenameOf(session.cwd) || session.cwd,
      sessionId,
    });
  };

  /**
   * "Use template" — one journey, two operations, and only one of them is a
   * prompt (SAP-2981, E4.6).
   *
   * A STARTER is the same local scaffold the project `+` does, so it goes
   * through the same endpoint: the folder is created before the session opens,
   * and a refusal is an error the dialog shows. Two creation paths for one
   * operation is exactly how they drift.
   *
   * A GALLERY template is a different operation — it forks a published agent
   * into a repo the user owns, over the network, with an auth failure mode —
   * and the harness has no route for that. It stays the coding agent's job, and
   * says so.
   */
  const handleUseTemplate = async (
    cwd: string,
    template: StudioTemplate,
    surface:
      | "welcome"
      | "template_gallery"
      | "template_detail" = "template_gallery",
  ): Promise<void> => {
    // Product metric — "templates used". Fires at the choke point every
    // template surface funnels through; `agent.created` fires later when the
    // clone produces a real sapiom.json, so built ≥ templates holds.
    const trackUse = (): void => {
      trackProduct("agent.template_cloned", {
        template_slug: template.id,
        template_id: template.id,
        surface,
      });
    };
    if (template.kind === "starter") {
      // `cwd` is the folder the destination picker settled on: its parent is
      // the project, its basename the agent's name. The endpoint refuses both
      // on its own findings, so a rejection here is the server's sentence and
      // the dialog shows it verbatim.
      const parent = parentOf(cwd);
      if (!parent)
        throw new Error(`Can't create an agent at ${cwd} — pick a folder inside a project.`);
      const created = await harness.scaffoldAgent(
        parent,
        basenameOf(cwd),
        template.id,
      );
      trackUse();
      setTemplatesOpen(false);
      setFocusedAgentPath(created.path);
      const session = await createSessionAt(parent, "claude-code");
      await harness.bindWorkflow(session.id, created.path);
      setFocusedAgentPath(created.path);
      return;
    }
    const session = await createSessionAt(cwd, "claude-code");
    trackUse();
    sendPromptWhenReady(
      session.id,
      useTemplatePrompt(template, cwd),
      "Couldn't send the clone prompt. Ask the coding agent to run sapiom_dev_agents_clone.",
    );
  };

  // The composer home's two on-ramps. Both open a session in a FRESH project
  // folder under the project root (deduped so an existing folder is never
  // clobbered) and open the workbench terminal-only — the canvas reveals itself
  // once the agent generates content (see CanvasPane's onCanvasState below).
  const uniqueProjectDir = (base: string): string => {
    const taken = new Set<string>();
    for (const session of state.sessions) {
      const name = basenameOf(session.cwd);
      if (name) taken.add(name);
    }
    for (const workflow of state.workflows) {
      const name = basenameOf(workflow.path);
      if (name) taken.add(name);
    }
    return projectDirSuggestion(
      nextAvailableName(base, taken),
      projectRoot || null,
    );
  };

  const handleComposerSubmitIdea = async (
    idea: string,
    agentHarness: HarnessKind,
    attachments: readonly NewSessionAttachment[],
  ): Promise<void> => {
    const cwd = uniqueProjectDir(
      idea.trim() ? slugifyIdea(idea) : FALLBACK_PROJECT_NAME,
    );
    if (!cwd) {
      throw new Error("Set a project folder first — use the + to open one.");
    }
    // SAY IT, don't infer it. `composing` used to be set by the rail control
    // that opened this, and holding it true is what keeps the composer MOUNTED
    // across the session that is about to be created and, on a failed upload,
    // closed again. The composer is now the home screen — shown because
    // nothing else is — so without this the workbench appears for the life of
    // that provisional session, the composer unmounts, and the attachment queue
    // a rollback is supposed to retain goes with it.
    setComposing(true);
    // Terminal-first: the new session's canvas slides in once it paints.
    setRightCollapsed(true);
    const session = await createSessionAt(cwd, agentHarness, {
      keepComposerOpen: true,
    });
    try {
      const resolved = await materializeAttachments(
        session.id,
        attachments,
        harness.attachFile,
      );
      sendScaffoldPrompt(
        session,
        cwd,
        buildIdeaWithAttachments(idea, resolved),
      );
      setComposing(false);
    } catch (error) {
      // The first prompt is registered only after every upload succeeds. Kill
      // the provisional session on failure so retrying reuses the same folder
      // and queue instead of leaving a blank tab behind.
      await harness.closeSession(session.id).catch((rollbackError: unknown) => {
        console.error("[harness] attachment rollback failed:", rollbackError);
      });
      harness.removePendingWorkspace(cwd);
      throw error;
    }
  };

  const handleComposerUseTemplate = (template: GalleryTemplate): void => {
    const cwd = uniqueProjectDir(template.id);
    if (!cwd) {
      harness.showToast("Set a project folder first — use the + to open one.");
      return;
    }
    setRightCollapsed(true);
    void handleUseTemplate(cwd, template, "welcome");
  };

  // Bulk discovery from the add dialog.
  const handleScanWorkflows = async (root: string): Promise<number> => {
    const { found, repositoryBoundaries } = await harness.scanWorkflows(root);
    // Finding agents is the win this dialog exists for; an empty sweep is a
    // neutral fact, not a failure.
    //
    // But "found nothing" and "did not look" are different facts, and the walk
    // stops at every separate checkout — so a folder of clones legitimately
    // finds nothing while the agents are right there. Reporting that as "no
    // agent projects found" is false, and it is false in the most misleading
    // direction: it tells the user their agents do not exist.
    const skipped = repositoryBoundaries.length;
    harness.showToast(
      found.length === 0
        ? skipped === 0
          ? "No agent projects found under this folder."
          : `No agents here — ${skipped === 1 ? "1 separate git checkout was" : `${skipped} separate git checkouts were`} not searched. Open one as its own project.`
        : found.length === 1
          ? "Found 1 agent project."
          : `Found ${found.length} agent projects.`,
      found.length === 0 ? "info" : "success",
    );
    return found.length;
  };

  // The canvas pane follows the ACTIVE session's board rather than being toggled
  // here: CanvasPane reports whether the session it's mounted for has a servable
  // board (onCanvasState below), and that drives the pane open/closed. So a
  // switch only has to move the active session — the pane reconciles itself once
  // the new session's probe resolves. (Mobile keeps its own sheet control.)

  // Switch to a session (history-menu pick, palette hit): focus follows it so
  // the main panel shows its context (its bound agent, or its own folder).
  const openSession = (id: string): void => {
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    const session = state.sessions.find((s) => s.id === id);
    if (session?.planning?.identity.role === "map-planner") {
      const selection: StudioWorkspaceSelection = {
        kind: "agent-map",
        projectId: session.planning.identity.projectId,
      };
      restoredStudioProjectsRef.current.add(selection.projectId);
      setStudioSelection(selection);
      setSelectedProject(null);
      setFocusedAgentPath(session.cwd);
      closeMobileDrawer();
      if (isMobile) setRightCollapsed(true);
      harness.setActiveSessionId(id);
      void harness.api.putStudioCurrentWorkspace(
        selection.projectId,
        selection,
      );
      return;
    }
    // Opening one of the selected project's own sessions is not a navigation
    // away from it — only a session somewhere else is.
    leaveProjectUnlessInside(session?.cwd ?? null);
    closeMobileDrawer();
    if (session)
      setFocusedAgentPath(boundWorkflowPathOf(session) ?? session.cwd);
    harness.setActiveSessionId(id);
  };

  // Select a tab in the strip — same as openSession, but the tab always
  // belongs to the current focus, so focus never moves.
  const selectTab = (id: string): void => {
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    // The tabs ARE the project's tabs at map altitude — picking one must not
    // close the map they are rendered beside.
    leaveProjectUnlessInside(
      state.sessions.find((s) => s.id === id)?.cwd ?? null,
    );
    harness.setActiveSessionId(id);
  };

  // One entry point for reviewing a past (transcript) session.
  const reviewPastSession = (summary: SessionSummary): void => {
    studioRestoreGenerationRef.current += 1;
    setStudioSelection(null);
    setComposing(false);
    setReviewSummary(summary);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    setSelectedProject(null);
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

  /**
   * The rail verb: SELECT an agent (or a bare folder).
   *
   * Selecting changes what every right-hand surface is about — board, steps,
   * run evidence, lifecycle verbs — and, deliberately, usually leaves the
   * active session exactly where it is. Same-project selection is how you read
   * F's board while still talking to B: one session has context on every agent
   * in its project, so there is nothing to swap for. It used to take the
   * selection's own most-recent tab unconditionally, which is why looking at a
   * sibling emptied the terminal you were mid-sentence in.
   *
   * Across projects the same rule is a bug — a session rooted elsewhere cannot
   * see the agent now on screen — so `sessionForFocus` hands over to that
   * project's own session, or to none. Its overlapping-roots answer is
   * deliberate and asymmetric; the reasoning lives with the function.
   */
  const selectStudioAgent = (
    workflow: WorkflowInfo,
    preferred?: { projectId: string; agentId: string },
  ): void => {
    const bindings = workflow.studioBindings ?? [];
    const owningScope = mostSpecificStudioScope(
      workflow.path,
      workspaceScopes,
      state.studioProjects ?? [],
    );
    const binding =
      (preferred
        ? bindings.find(
            (candidate) =>
              candidate.projectId === preferred.projectId &&
              candidate.agentId === preferred.agentId,
          )
        : undefined) ??
      bindings.find(
        (candidate) => candidate.projectId === owningScope?.projectId,
      ) ??
      bindings.find(
        (candidate) => candidate.projectId === studioSelection?.projectId,
      ) ??
      [...bindings].sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.agentId.localeCompare(right.agentId),
      )[0];
    if (!binding) {
      setStudioSelection(null);
      return;
    }
    const selection: StudioWorkspaceSelection = {
      kind: "agent",
      projectId: binding.projectId,
      agentId: binding.agentId,
    };
    restoredStudioProjectsRef.current.add(binding.projectId);
    const generation = ++studioRestoreGenerationRef.current;
    setStudioSelection(selection);
    void harness.api
      .putStudioCurrentWorkspace(binding.projectId, selection)
      .then((current) => {
        if (generation !== studioRestoreGenerationRef.current) return;
        // The server is the durability authority. A complete scan may prove a
        // stale click invalid; an incomplete one preserves a known binding.
        // Reflect either answer so the optimistic UI never disagrees with disk.
        setStudioSelection(current.selection);
      })
      .catch(() => {});
  };

  const handleFocusAgent = (
    path: string,
    preferredStudioBinding?: { projectId: string; agentId: string },
  ): void => {
    studioRestoreGenerationRef.current += 1;
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    setSelectedProject(null);
    setFocusedAgentPath(path);
    const workflow = state.workflows.find((candidate) =>
      samePath(candidate.path, path),
    );
    if (workflow) selectStudioAgent(workflow, preferredStudioBinding);
    else setStudioSelection(null);
    closeMobileDrawer();
    const decision = sessionForFocus({
      focusPath: path,
      active: activeSession,
      sessions: state.sessions,
      roots: knownProjectRoots(),
    });
    if (
      decision.kind === "switch" &&
      (decision.to?.id ?? null) !== harness.activeSessionId
    ) {
      harness.setActiveSessionId(decision.to?.id ?? null);
    }
    // The canvas follows the selection automatically (onCanvasState): the
    // session-keyed board when the session is bound to it, IA-01's
    // workflow-keyed route otherwise — including for an agent that has never
    // hosted a session at all.
  };

  // Focus a deep-linked / just-cloned agent if the user has it locally; returns
  // whether it was found. Assigned here (not in an effect) because it closes over
  // `state` + `handleFocusAgent`, which exist only past the loading guard — the
  // deep-link effects above reach it through the ref.
  focusExistingRef.current = (definitionId: string): boolean => {
    const match = state.workflows.find(
      (w) => w.definitionId != null && String(w.definitionId) === definitionId,
    );
    if (!match) return false;
    handleFocusAgent(match.path);
    return true;
  };

  // Resolve a deep-link target. A template (`sapiom://templates/<id>`) opens the
  // templates browser on that template; an agent (`sapiom://agent/<id>`) focuses
  // it if present, else offers to clone it locally — the remote-only fallback.
  applyDeepLinkRef.current = (target: DeepLinkTarget): void => {
    if (target.kind === "template") {
      studioRestoreGenerationRef.current += 1;
      setStudioSelection(null);
      setSelectedProject(null);
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
    const cwd = uniqueProjectDir(
      target.slug?.trim() || `agent-${target.definitionId}`,
    );
    if (!cwd) {
      harness.showToast("Set a project folder first — use the + to open one.");
      return;
    }
    pendingCloneFocusRef.current = target.definitionId;
    setRightCollapsed(true); // terminal-first, like the template flow
    try {
      const session = await createSessionAt(cwd, "claude-code");
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

  // Binds a workflow to a live session in its own workspace and focuses it —
  // used when navigating to a launched sub-workflow from the canvas/steps, and
  // before running a macro against a workflow (the canvas is served from the
  // binding). Same-workspace by contract: it lands on a live
  // session in the workflow's own workspace, or STARTS one at the workflow's
  // PROJECT ROOT. Resolves to the session the binding landed on.
  //
  // Starting one is where SAP-2927's bug lived: this passed `path` — the agent
  // directory — straight to createSessionAt, so a bound-on-demand session came
  // up without the project's CLAUDE.md, .claude/ or skills.
  const handleBindWorkflow = async (path: string): Promise<string | null> => {
    setSelectedProject(null);
    closeMobileDrawer();
    const live = state.sessions.filter((s) => s.status !== "exited");
    const ownsPath = (s: HarnessSession): boolean =>
      s.boundWorkflowPath === path || isWithinDir(s.cwd, path);
    // Prefer the ACTIVE tab when it already owns the workflow, so running a
    // macro against the current agent never yanks the workbench to a sibling
    // session in the same workspace (e.g. re-visualize on a two-tab agent).
    const active = live.find((s) => s.id === harness.activeSessionId);
    const owner =
      active && ownsPath(active)
        ? active
        : live
            .filter(ownsPath)
            .sort(
              (a, b) =>
                b.cwd.length - a.cwd.length ||
                b.createdAt.localeCompare(a.createdAt),
            )[0];
    let targetId: string;
    if (owner) {
      setComposing(false);
      setReviewSummary(null);
      setOverviewOpen(false);
      if (owner.id !== harness.activeSessionId)
        harness.setActiveSessionId(owner.id);
      targetId = owner.id;
    } else {
      try {
        targetId = (
          await createSessionAt(sessionCwdForAgent(path), "claude-code")
        ).id;
      } catch (err) {
        harness.showToast(
          (err as Error).message || "Couldn't start a session in this folder.",
        );
        return null;
      }
    }
    await harness.bindWorkflow(targetId, path);
    setFocusedAgentPath(path);
    const workflow = state.workflows.find((candidate) =>
      samePath(candidate.path, path),
    );
    if (workflow) selectStudioAgent(workflow);
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
            harness.showToast(
              deploymentState === "failed"
                ? "Last deploy failed — retry Deploy."
                : deploymentState === "building"
                  ? "The cloud build is still in progress."
                  : deploymentState === "linked"
                    ? "No ready deployment yet — deploy it first."
                    : "This agent isn't deployed yet — deploy it first.",
            );
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
            projectRoot={projectRoot || null}
            onSaveProjectRoot={saveProjectRoot}
            width={widths.rail}
            minWidth={RAIL_MIN}
            workflows={state.workflows}
            sessions={state.sessions}
            pendingWorkspaces={harness.pendingWorkspaces}
            activeSessionId={harness.activeSessionId}
            focusedAgentPath={
              atMapAltitude ? null : effectiveFocusedAgentPath
            }
            workspaceScopes={state.workspaceScopes}
            studioProjects={state.studioProjects}
            studioSelection={planFirstSelection}
            selectedWorkspaceKey={selectedProject?.workspaceKey ?? null}
            onSelectWorkspace={handleSelectWorkspace}
            onSelectAgentMap={(projectId, root, label) => {
              const scope = workspaceScopes.find(
                (candidate) => candidate.projectId === projectId,
              );
              if (scope) handleSelectWorkspace(scope.workspaceKey, root, label);
            }}
            onSelectStudioAgent={(workflow, projectId, agentId) =>
              handleFocusAgent(workflow.path, { projectId, agentId })
            }
            onFocusAgent={handleFocusAgent}
            onOpenPalette={() => setPaletteOpen(true)}
            onConnect={async (path) => {
              await harness.connectWorkflow(path);
            }}
            onCollapse={() => setRailCollapsed(true)}
            canGoBack={navHistory.canGoBack}
            canGoForward={navHistory.canGoForward}
            onGoBack={() => applyVisit(navHistory.goBack())}
            onGoForward={() => applyVisit(navHistory.goForward())}
            onSelectSession={openSession}
            overviewSelected={overviewOpen}
            onSelectOverview={() => {
              studioRestoreGenerationRef.current += 1;
              setStudioSelection(null);
              setSelectedProject(null);
              setOverviewOpen(true);
              setComposing(false);
              setReviewSummary(null);
              setTemplatesOpen(false);
              closeMobileDrawer();
            }}
            onNewAgentIn={handleNewAgentIn}
            onReviewSummary={reviewPastSession}
            history={harness.history}
            historyLoading={harness.historyLoading}
            onOpenHistory={(cwds) => void harness.loadHistory(cwds)}
            recentDirs={harness.settings?.recentDirs ?? []}
            closedProjects={harness.closedProjects}
            unsearchedCheckouts={harness.unsearchedCheckouts}
            onRemoveProject={async (root) => {
              if (
                selectedProject &&
                samePath(selectedProject.root, root)
              ) {
                setSelectedProject(null);
              }
              const removedProjectId = workspaceScopes.find((scope) =>
                samePath(scope.cwd, root),
              )?.projectId;
              if (studioSelection?.projectId === removedProjectId) {
                studioRestoreGenerationRef.current += 1;
                setStudioSelection(null);
              }
              await harness.removeProject(root);
            }}
            onOpenProject={async (requestedRoot) => {
              const openedRoot = await harness.openProject(requestedRoot);
              let restoringProject: {
                projectId: StudioProjectId;
                cwd: string;
              } | null = null;
              try {
                const refreshed = await harness.api.getState();
                const scope = refreshed.workspaceScopes?.find((candidate) =>
                  samePath(candidate.cwd, openedRoot),
                );
                const project = refreshed.studioProjects?.find(
                  (candidate) => candidate.projectId === scope?.projectId,
                );
                if (!scope?.projectId || !project) return;
                restoringProject = {
                  projectId: project.projectId,
                  cwd: scope.cwd,
                };
                restoredStudioProjectsRef.current.add(project.projectId);
                const generation = ++studioRestoreGenerationRef.current;
                const current = await harness.api.getStudioCurrentWorkspace(
                  project.projectId,
                );
                if (generation !== studioRestoreGenerationRef.current) return;
                const restoredSelection = current.selection;
                if (restoredSelection.kind === "agent") {
                  const workflow = refreshed.workflows.find((candidate) =>
                    candidate.studioBindings?.some(
                      (binding) =>
                        binding.projectId === restoredSelection.projectId &&
                        binding.agentId === restoredSelection.agentId,
                    ),
                  );
                  if (workflow) {
                    setStudioSelection(restoredSelection);
                    setSelectedProject(null);
                    setFocusedAgentPath(workflow.path);
                    return;
                  }
                }
                setStudioSelection({
                  kind: "agent-map",
                  projectId: project.projectId,
                });
                setSelectedProject(null);
                setFocusedAgentPath(scope.cwd);
                if (isMobile) setRightCollapsed(true);
              } catch {
                if (restoringProject) {
                  // Preference restoration is best-effort. The project itself
                  // opened successfully, so fall back to its stable map rather
                  // than leaving the previous workspace selected. Keep the
                  // restore guard so later session frames cannot repeat it.
                  studioRestoreGenerationRef.current += 1;
                  setStudioSelection({
                    kind: "agent-map",
                    projectId: restoringProject.projectId,
                  });
                  setSelectedProject(null);
                  setFocusedAgentPath(restoringProject.cwd);
                  if (isMobile) setRightCollapsed(true);
                }
              }
            }}
            launchDir={state.launchDir ?? null}
            listDir={harness.listDir}
            onCreateSession={handleCreateSession}
            listHarnesses={harness.listHarnesses}
            onCreateAgent={handleCreateAgentInProject}
            onScaffoldInSession={handleScaffoldInSession}
            onBrowseTemplates={() => {
              studioRestoreGenerationRef.current += 1;
              setStudioSelection(null);
              setSelectedProject(null);
              setTemplatesOpen(true);
              setOverviewOpen(false);
            }}
            templatesActive={templatesOpen}
            onScanWorkflows={handleScanWorkflows}
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
            // .app.canvas-animated). Off while browsing / composing / mobile,
            // where the single-column switch should be instant.
            (!templatesOpen && !isMobile && !rightPaneSuppressedByComposer
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
              // Browsing and the composer home take the whole width: a
              // two-column card grid inside half the shell is the letterbox this
              // view exists to escape, and the composer has no canvas yet.
              templatesOpen || isMobile || rightPaneSuppressedByComposer
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
                        : `${widths.canvas}px`
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
              projectRoot={projectRoot || null}
              recentDirs={harness.settings?.recentDirs ?? []}
              listDir={harness.listDir}
              onExit={() => setTemplatesOpen(false)}
              onUse={handleUseTemplate}
              listTemplates={harness.listTemplates}
              getTemplate={harness.getTemplate}
              openTemplateId={deepLinkTemplateId}
            />
          )}

          <div className="center-pane">
            <SessionBar
              planning={planningWorkspace}
              openedAgentName={
                showAgentEmpty ? (focusedWorkflow?.name ?? null) : null
              }
              reviewTitle={reviewSummary ? reviewSummary.title : null}
              composing={showComposer}
              onBack={composerCanCancel ? () => setComposing(false) : null}
              activeSession={sessionBarSession}
              sessionName={
                sessionBarSession
                  ? sessionDisplayName(
                      sessionBarSession,
                      state.sessions,
                      sessionNames,
                    )
                  : null
              }
              onRenameSession={renameSession}
              boundWorkflowName={
                planningWorkspace ? null : (boundWorkflow?.name ?? null)
              }
              sessions={
                planningWorkspace
                  ? plannerSessions
                  : showWorkbench
                    ? focusTabs
                    : []
              }
              busySessionIds={harness.busySessionIds}
              onSelectSession={selectTab}
              labelOf={(session) =>
                sessionDisplayName(session, state.sessions, sessionNames)
              }
              busy={
                sessionBarSession != null &&
                harness.busySessionIds.has(sessionBarSession.id)
              }
              onCloseSession={(id) => void harness.closeSession(id)}
              onOpenInEditor={openInEditor}
              editorLabel={editorLabel(harness.settings?.editor)}
              onToast={harness.showToast}
              onExpandRail={
                railCollapsed ? () => setRailCollapsed(false) : null
              }
              onExpandRight={
                !agentMapUnavailable && rightCollapsed ? expandRightPane : null
              }
              expandRightLabel={
                planningWorkspace ? "Agent Map" : "Expand canvas panel"
              }
              showExpandRightLabel={isMobile && planningWorkspace}
              expandRightRef={rightPaneTriggerRef}
              subjectName={
                planningWorkspace
                  ? (selectedStudioProject?.displayName ?? "Agent Map")
                  : (focusedWorkflow?.name ??
                    (activeSession ? basenameOf(activeSession.cwd) : null))
              }
              newSessionPending={
                planningWorkspace
                  ? agentMapEntry.state.planner.status === "loading"
                  : siblingSessionPending
              }
              onNewSession={
                planningWorkspace
                  ? agentMapEntry.openFreshPlanner
                  : activeSession
                    ? () => handleStartSiblingSession(activeSession)
                    : null
              }
              /* The agent action cluster shares the same row as the tabs.
                 Its subject AND its gating are `rightPaneWorkflow` — the same
                 one value the board draws (SAP-2931). Passing the binding here
                 is the trap this ticket exists for: the handlers were rewired
                 in the prototype and the buttons stayed enabled off the BOUND
                 agent's deployment state, so selecting the undeployed `rfq`
                 left Prod and Run live against `leasing`. */
              /* PRESENT AND GATED, never absent (round 2).
                 This used to be `showWorkbench && activeSession && …`, so an
                 agent with no session got no verbs AT ALL — not disabled ones
                 with a reason, none. That contradicts SAP-2931's own criterion,
                 which is that a verb states why it cannot run: a control that
                 disappears cannot state anything, and the user is left to guess
                 whether Deploy is missing, broken, or simply not for them.

                 The gating was already right and already had the sentence —
                 `macroDisabledReason` returns "Start a session first" for a null
                 session — so the fix is to stop hiding the bar and let it say
                 it. The bar renders whenever the pane is ABOUT an agent, which
                 is exactly `rightPaneWorkflow`.

                 `activeSessionId` is passed only when the active session
                 actually belongs to this subject (`showWorkbench`). A session
                 focused on a DIFFERENT agent must not enable an inject here:
                 that is the SAP-2931 trap itself — the verbs staying live
                 against the bound agent while the pane showed another. */
              actions={
                !planningWorkspace && rightPaneWorkflow ? (
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
                    /* By the SUBJECT's path: a stale failure belonging to the
                       agent the session happens to be bound to would otherwise
                       disable a verb on a perfectly healthy one. */
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

            <div className="terminal-slot">
              {agentMapUnavailable ? (
                <EmptyState
                  className="terminal-empty"
                  testId="agent-map-unavailable"
                  icon="TriangleAlert"
                  title="Agent Map unavailable"
                  body={
                    agentMapEntry.state.unavailable ??
                    "This project is no longer available."
                  }
                  cta={
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid="agent-map-retry-all"
                      onClick={agentMapEntry.retryAll}
                    >
                      Retry
                    </button>
                  }
                />
              ) : planningWorkspace ? (
                agentMapEntry.state.planner.status === "error" ? (
                  <EmptyState
                    className="terminal-empty"
                    testId="planner-load-error"
                    icon="TriangleAlert"
                    title="Planning session couldn't open"
                    body={agentMapEntry.state.planner.message}
                    cta={
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="planner-retry"
                        onClick={agentMapEntry.retryPlanner}
                      >
                        Retry session
                      </button>
                    }
                  />
                ) : agentMapEntry.state.planner.status === "loading" ? (
                  <EmptyState
                    className="terminal-empty"
                    testId="planner-loading"
                    icon="Radio"
                    title="Opening planning session…"
                  />
                ) : activePlannerSession?.planning ? (
                  /* Agent Map planning is still an ordinary coding-agent
                     session. Keep the exact same raw CLI surface used for
                     every agent: trust/auth prompts, slash commands, tool
                     output, and provider chrome must remain visible rather
                     than being replaced by a transcript/composer facsimile. */
                  <div className="agent-view" data-testid="agent-view">
                    <div
                      className="agent-view-panel"
                      id="agent-panel-terminal"
                    >
                      <Terminal
                        sessionId={activePlannerSession.id}
                        token={harness.bootToken}
                        cwd={activePlannerSession.cwd}
                      />
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    className="terminal-empty"
                    testId="planner-session-ended"
                    icon="Radio"
                    title="Planning session ended"
                    body="Start a new planning session to continue working on this Agent Map."
                    cta={
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={agentMapEntry.openFreshPlanner}
                      >
                        New planning session
                      </button>
                    }
                  />
                )
              ) : showReview && reviewSummary ? (
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
              ) : showDead && activeSession ? (
                <DeadSessionPane
                  session={activeSession}
                  resumeMode={deadResumeMode}
                  loadRecord={harness.sessionRecord}
                  onResume={() => void harness.resumeSession(activeSession.id)}
                  onContinue={() =>
                    void harness.rehydrateSession({
                      cwd: activeSession.cwd,
                      harness: activeSession.harness,
                      from: activeSession.id,
                    })
                  }
                  onClose={() => void harness.closeSession(activeSession.id)}
                />
              ) : showAgentEmpty && focusedWorkflow ? (
                /* Honest absence: no session that can WORK on this agent — its
                   board still draws on the right, from the workflow-keyed route
                   (SAP-2931). Start runs the create+bind path at the agent's
                   PROJECT ROOT, so the booting agent gets the project's
                   CLAUDE.md, .claude/ and skills (SAP-2927). */
                <EmptyState
                  className="terminal-empty"
                  testId="open-agent-empty"
                  icon="Radio"
                  title={`No running session for ${focusedWorkflow.name}`}
                  body="Start a session to map, run, and inspect this agent."
                  cta={
                    <button
                      className="btn-primary"
                      data-testid="open-agent-start-session"
                      onClick={() =>
                        handleStartSessionForAgent(focusedWorkflow)
                      }
                    >
                      <Icon name="Plus" size={14} /> Start session
                    </button>
                  }
                />
              ) : showProjectStarting && startingProject ? (
                /* E3.2: a project you can select but not talk to is the
                   failure. Its first session is on the way — say so, instead
                   of flashing the create-new composer for the length of a pty
                   spawn. */
                <EmptyState
                  className="terminal-empty"
                  testId="project-session-starting"
                  icon="Radio"
                  title={`Starting a session in ${startingProject.label}…`}
                  body="Sessions boot at the project root, so the coding agent comes up with this project's instructions and skills."
                />
              ) : showWorkbench && harness.activeSessionId ? (
                <div className="agent-view" data-testid="agent-view">
                  <div className="agent-view-panel" id="agent-panel-terminal">
                    <Terminal
                      sessionId={harness.activeSessionId}
                      token={harness.bootToken}
                      cwd={activeSession?.cwd ?? null}
                    />
                  </div>
                </div>
              ) : (
                /* The composer-first home: no terminal, no canvas yet. Describe
                   an outcome (or pick a template) and a session starts; this
                   screen gives way to the terminal (createSessionAt clears
                   `composing`), and the canvas reveals itself once populated. */
                <NewSessionComposer
                  firstRun={state.firstRun === true}
                  onSubmitIdea={handleComposerSubmitIdea}
                  onAttachmentError={harness.showToast}
                  onUseTemplate={handleComposerUseTemplate}
                  onBrowseTemplates={() => {
                    studioRestoreGenerationRef.current += 1;
                    setStudioSelection(null);
                    setSelectedProject(null);
                    setTemplatesOpen(true);
                  }}
                  listHarnesses={harness.listHarnesses}
                  listTemplates={harness.listTemplates}
                  telemetryOptIn={
                    harness.settings?.telemetryOptIn ?? state.telemetryOptIn
                  }
                  onToggleTelemetry={async (next) => {
                    await harness.updateSettings({ telemetryOptIn: next });
                  }}
                  recentDirs={harness.settings?.recentDirs ?? []}
                  projectRoot={projectRoot || null}
                  listDir={harness.listDir}
                  onConnect={async (cwd) => {
                    await harness.connectWorkflow(cwd);
                  }}
                  onScan={handleScanWorkflows}
                  onScaffold={handleScaffoldSession}
                  onSaveProjectRoot={saveProjectRoot}
                />
              )}
            </div>
          </div>

          {!rightCollapsed &&
            !isMobile &&
            !rightPaneSuppressedByComposer &&
            !canvasExpanded && (
            <div
              className="pane-resize-handle pane-resize-handle-canvas"
              // Track the canvas column's ACTUAL edge, not the requested width.
              // The column is `minmax(CANVAS_MIN, widths.canvas)`, so it clamps
              // below widths.canvas once the terminal is at its own floor
              // (100% − CANVAS_MIN). Positioning the handle at the raw
              // widths.canvas then stranded it in the terminal, a growing gap
              // to the left of the board it splits. The same clamp keeps them
              // welded at every width. (null = the 1fr/1fr split, always at 50%.)
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

          {isMobile && !rightCollapsed && (
            <div
              className="shell-scrim"
              data-testid="right-sheet-scrim"
              aria-hidden="true"
              onClick={collapseRightPane}
            />
          )}

          {/* Right pane: Canvas | Steps segmented switch + panels. Collapsed
              via CSS (never unmounted) so a running Visualize enrichment
              survives the collapse. The Canvas tab holds BOTH altitudes — a
              project's map and an agent's board — because they are one surface
              seen from two heights, and a peer tab would assert they are
              different kinds of thing. */}
          <div
            ref={setRightPaneEl}
            className={
              "right-pane" +
              (rightCollapsed || rightPaneSuppressedByComposer
                ? " is-collapsed"
                : "")
            }
          >
            <div
              className="right-pane-tabs"
              role="tablist"
              aria-label="Right pane"
            >
              {/* THE WAY BACK UP. The map was a one-way door: you could drill
                  into an agent and never return, which is most of why it felt
                  like a dead end. Derived from containment (not from the click
                  that got here), so the same door exists whether the agent was
                  reached from the rail or from a map node. */}
              {upToProject && (
                <button
                  type="button"
                  className="right-pane-up"
                  data-testid="canvas-altitude-up"
                  aria-label={`Back to the ${upToProject.label} map`}
                  data-tooltip={`Back to the ${upToProject.label} map`}
                  onClick={() =>
                    handleSelectWorkspace(
                      upToProject.workspaceKey,
                      upToProject.root,
                      upToProject.label,
                    )
                  }
                >
                  <Icon name="ChevronLeft" size={14} />
                  <span className="right-pane-up-label">
                    {upToProject.label}
                  </span>
                </button>
              )}
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
                {planningWorkspace ? "Agent Map" : "Canvas"}
              </button>
              {/* Steps are an AGENT's steps. At map altitude there is no
                  meaningful step list for a whole project, and a tab that
                  silently kept showing the last agent's steps under a project's
                  name would be worse than one that says why it cannot answer. */}
              <button
                role="tab"
                aria-selected={shownTab === "steps"}
                disabled={stepsDisabled != null}
                aria-disabled={stepsDisabled != null || undefined}
                aria-label={stepsDisabled ?? undefined}
                data-tooltip={stepsDisabled ?? undefined}
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
                  it earns a tab rather than a nested screen. Gated at map
                  altitude for the same reason Steps is, and more sharply: a tab
                  still listing the last agent's credentials under a project's
                  name would invite a wrong conclusion about a different agent. */}
              <button
                role="tab"
                aria-selected={shownTab === "secrets"}
                disabled={secretsDisabled != null}
                aria-disabled={secretsDisabled != null || undefined}
                aria-label={secretsDisabled ?? undefined}
                data-tooltip={secretsDisabled ?? undefined}
                className={
                  "right-pane-tab" + (shownTab === "secrets" ? " is-active" : "")
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
                  !atMapAltitude &&
                  rightPaneWorkflow?.definitionId != null && (
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
                      {rightPaneDeploymentState === "ready"
                        ? "deployed"
                        : rightPaneDeploymentState === "building"
                          ? "building"
                          : rightPaneDeploymentState === "failed"
                            ? "deploy failed"
                            : "linked"}
                    </a>
                  )}
                {/* Full view belongs to the graph surface currently shown:
                    Agent Map at project altitude, Canvas / Focus below it. */}
                {(!atMapAltitude || planningWorkspace) && (
                  <button
                    className="theme-toggle"
                    data-testid="canvas-expand"
                    hidden={canvasExpanded}
                    aria-label={
                      planningWorkspace
                        ? "Expand Agent Map"
                        : shownTab === "steps"
                          ? "Open Focus mode"
                          : "Expand canvas"
                    }
                    title={
                      planningWorkspace
                        ? "Expand Agent Map"
                        : shownTab === "steps"
                          ? "Open Focus mode"
                          : "Expand canvas"
                    }
                    onClick={toggleCanvasExpanded}
                  >
                    <Icon name="Maximize2" size={15} />
                  </button>
                )}
                <button
                  className="theme-toggle right-pane-collapse"
                  data-testid="right-collapse"
                  aria-label={
                    planningWorkspace
                      ? "Close Agent Map"
                      : "Collapse canvas panel"
                  }
                  title={
                    planningWorkspace
                      ? "Close Agent Map"
                      : "Collapse canvas panel"
                  }
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
              <div className="right-pane-panel" data-testid="right-panel-secrets">
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
              {/* MAP altitude. Mounted BESIDE the board, not instead of it —
                  `CanvasPane` keeps its mount (and with it its probe state,
                  reload key and background-task tracking) while the project is
                  on screen, so coming back down is a re-render and not a cold
                  start. Its document follows the subject, and at map altitude
                  the subject is a project, so there is no agent board drawn
                  behind the map. Keyed by project, so switching projects is a
                  fresh load rather than a mutation of the one on screen. */}
              {studioView?.altitude === "map" ? (
                <AgentMapPane
                  state={agentMapEntry.state.workspace}
                  onRetry={agentMapEntry.retryWorkspace}
                  expanded={canvasExpanded}
                  onToggleExpanded={toggleCanvasExpanded}
                />
              ) : legacyView.altitude === "map" ? (
                <WorkspaceGraphView
                  key={legacyView.project.workspaceKey}
                  workspaceKey={legacyView.project.workspaceKey}
                  workspaceName={legacyView.project.label}
                  api={harness.api}
                  workflows={state.workflows}
                  workspaceScopes={workspaceScopes}
                  latestAnnouncement={
                    harness.systemGraphAnnouncements.get(
                      legacyView.project.workspaceKey,
                    ) ?? null
                  }
                  onOpenAgent={handleFocusAgent}
                />
              ) : null}
              <div
                className={
                  "right-pane-altitude" + (atMapAltitude ? " is-hidden" : "")
                }
                data-testid="right-panel-board"
              >
              <CanvasPane
                sessionId={harness.activeSessionId}
                lastMessage={harness.lastMessage}
                subjectWorkflow={rightPaneWorkflow}
                source={canvasSource}
                loadWorkflowGraph={shellApi.getWorkflowGraph.bind(shellApi)}
                overviewActive={showComposer}
                sessionExited={showDead}
                onCanvasState={(hasContent) => {
                  // The board keeps its mount behind the map; its probe must
                  // not reveal or collapse the pane while the PROJECT is what
                  // the pane is showing — the map is the answer to selecting a
                  // project and cannot be closed under it.
                  if (atMapAltitude) return;
                  // The pane follows the active session's board: open it whenever
                  // the session has one, close it when it doesn't. This fires on
                  // the mount probe, on every canvas.reload, and on each session
                  // switch — so a board an agent just rendered (a finished build,
                  // a switch to a populated agent) opens the pane on its own, even
                  // one you'd collapsed, and an empty session keeps it closed.
                  // Mobile drives its sheet with its own control, not this.
                  if (isMobile) return;
                  // An exited session keeps the pane open even with no board, so
                  // its "resume to see it" invite stays visible.
                  const activeExited =
                    state.sessions.find((s) => s.id === harness.activeSessionId)
                      ?.status === "exited";
                  if (hasContent || activeExited) {
                    // Content present (or an exited session's invite) → always
                    // reveal, re-opening even a pane the user had collapsed.
                    emptyCollapsedKeyRef.current = null;
                    setRightCollapsed(false);
                    return;
                  }
                  // Empty board → collapse once per (session, bound workflow). A
                  // redundant probe for the same one must not re-close a pane the
                  // user just expanded; a new session or binding still collapses.
                  if (manualExpandPendingRef.current) {
                    manualExpandPendingRef.current = false;
                    manualExpandSessionRef.current =
                      harness.activeSessionId ?? null;
                    return;
                  }
                  const claimed = manualExpandSessionRef.current;
                  if (claimed != null && claimed === harness.activeSessionId)
                    return;
                  if (emptyCollapsedKeyRef.current === emptyBoardKey) return;
                  emptyCollapsedKeyRef.current = emptyBoardKey;
                  setRightCollapsed(true);
                }}
                onGraphChange={(workflowPath, graph) => {
                  const contract = inputContractFromCanvasGraph(graph);
                  if (contract)
                    visibleInputContractsRef.current.set(
                      workflowPath,
                      contract,
                    );
                }}
                expanded={canvasExpanded && !atMapAltitude}
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
                    ? (harness.previewBySession.get(harness.activeSessionId) ??
                      null)
                    : null
                }
                deployState={
                  rightPaneWorkflow
                    ? (harness.deployStateByPath.get(rightPaneWorkflow.path) ??
                      null)
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
                   what the pane is DRAWING, not on what the session is bound
                   to — otherwise the empty state for F renders F's board. */
                onRunMacro={(macro) =>
                  handleRunMacroForWorkflow(rightPaneWorkflow, macro)
                }
                onInjectPrompt={(text) => {
                  if (harness.activeSessionId)
                    void harness.injectInput(harness.activeSessionId, text);
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
          recentDirs={harness.settings?.recentDirs ?? []}
          projectRoot={projectRoot || null}
          listDir={harness.listDir}
          onConnect={async (cwd) => {
            await harness.connectWorkflow(cwd);
            setOverviewOpen(false);
          }}
          onScan={handleScanWorkflows}
          onBrowseTemplates={() => {
            studioRestoreGenerationRef.current += 1;
            setStudioSelection(null);
            setSelectedProject(null);
            setOverviewOpen(false);
            setTemplatesOpen(true);
          }}
          onDismiss={() => setOverviewOpen(false)}
        />
      )}

      {/* The create-agent dialog (SAP-2981). Mounted here, beside the other
          cards-on-top, because the create has to outlive the rail popover that
          opened it — the menu unmounts on click, and a dialog rendered inside
          it would go with it. */}
      {creatingAgent && (
        <CreateAgentDialog
          projectLabel={creatingAgent.label}
          projectRoot={creatingAgent.root}
          onCancel={() => setCreatingAgent(null)}
          onCreate={createAgentInProject}
          onBrowseTemplates={() => {
            studioRestoreGenerationRef.current += 1;
            setStudioSelection(null);
            setCreatingAgent(null);
            setSelectedProject(null);
            setTemplatesOpen(true);
            setOverviewOpen(false);
          }}
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
            studioRestoreGenerationRef.current += 1;
            setStudioSelection(null);
            setSelectedProject(null);
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
                  studioRestoreGenerationRef.current += 1;
                  setStudioSelection(null);
                  setSelectedProject(null);
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
                      meta: sessionCwdForAgent(activeSession.cwd),
                      icon: "Plus",
                      run: () =>
                        void handleCreateSession(
                          sessionCwdForAgent(activeSession.cwd),
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
