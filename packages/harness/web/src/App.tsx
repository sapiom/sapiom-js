/**
 * Harness SPA shell.
 *
 * Three zones, one mental model:
 *  1. LEFT RAIL — an explorer of what exists on disk: workspace folders and
 *     the agents (sapiom.json) inside them. Clicking an agent FOCUSES it. No
 *     sessions live here.
 *  2. MAIN PANEL — the workbench for the focused agent: a session tab strip
 *     (one tab per live session belonging to the agent) above the session
 *     bar, terminal, and action bar. Session switching lives in the tab
 *     strip; the session bar is the active session's identity header.
 *  3. RIGHT PANEL — projections of the ACTIVE session's bound agent (Canvas |
 *     Steps | Code), session-keyed. The canvas stays mounted behind CSS when
 *     another tab is active so a running Visualize enrichment (and the
 *     graph-posting document) is never disturbed by a tab flip.
 *
 * The mapping invariant: rail focused agent == tab strip's agent == active
 * tab's bound agent == right panel's subject.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessKind, HarnessSession, MacroDef, SessionSummary, WorkflowInfo } from "@shared/types";

import { CanvasPane } from "./components/CanvasPane";
import { CodePanel } from "./components/CodePanel";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectivityBanner, ConnectivityScreen } from "./components/ConnectivityState";
import { DeadSessionPane, PastSessionPane } from "./components/DeadSessionPane";
import { EmptyState } from "./components/EmptyState";
import { Icon } from "./components/Icon";
import { SessionBar } from "./components/SessionBar";
import { SessionStepsBar } from "./components/SessionStepsBar";
import { TelemetryNotice } from "./components/TelemetryNotice";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { Terminal } from "./components/Terminal";
import { Toast } from "./components/Toast";
import { TooltipLayer } from "./components/TooltipLayer";
import { NewSessionComposer } from "./components/NewSessionComposer";
import { OverviewModal } from "./components/OverviewModal";
import { WorkflowsRail } from "./components/WorkflowsRail";
import { boundWorkflowPathOf } from "./lib/api";
import { classifyConnectivity, useConnectivity } from "./lib/connectivity";
import { historyDirs } from "./lib/history-meta";
import {
  FALLBACK_PROJECT_NAME,
  nextAvailableName,
  projectDirSuggestion,
  resolveProjectRoot,
  slugifyIdea,
} from "./lib/project-dir";
import { observedRunMatchesWorkflow } from "./lib/run-workflow-filter";
import { agentUrl } from "./lib/urls";
import { getDesktopBridge, type DeepLinkAgentTarget, type DeepLinkTarget } from "./lib/desktop";
import { deepLinkFromSearch } from "./lib/deep-link";
import { editorLabel, editorUrl, resolveEditor } from "./lib/editors";
import { CloneAgentConfirm } from "./components/CloneAgentConfirm";
import {
  cloneDefinitionPrompt,
  starterScaffoldInstruction,
  useTemplatePrompt,
  type GalleryTemplate,
  type StudioTemplate,
} from "./lib/templates";
import { track } from "./lib/track";
import { initAnalytics } from "./lib/analytics/posthog";
import { registerViewContext, track as trackProduct } from "./lib/analytics/events";
import type { HarnessView } from "./lib/analytics/journeys";
import { resolveMacroUrl } from "./lib/macro-gating";
import { directActionKind } from "./lib/macro-actions";
import { describeWorkflowPrompt } from "./lib/describe-prompt";
import { sessionDisplayName } from "./lib/session-name";
import { loadUiPrefs, saveUiPrefs } from "./lib/ui-prefs";
import { useNavigationHistory, type NavigationVisit } from "./lib/navigation-history";
import { CANVAS_MIN, RAIL_MIN, isMobileShell, useMobileShell, usePaneWidths } from "./lib/use-pane-widths";
import { useHarnessState, type ObservedRun, type RunTarget } from "./lib/use-harness-state";
import {
  isWorkflowRunnable,
  workflowDeploymentState,
} from "./lib/workflow-deployment";

type RightTab = "canvas" | "steps" | "code";

/**
 * How long a held initial prompt waits for the coding agent to become ready
 * (i.e. the user to finish signing in) before we give up and surface the
 * failure. The normal end of a hold is the session going ready (prompt sent)
 * or exiting — this is only a leak-guard for a login the user walks away from.
 */
const HELD_PROMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * Grace before nudging the user toward the terminal login. A signed-in agent
 * reports ready within a beat, so its held prompt sends before this fires and
 * no hint shows; only a session still stuck (on the Claude login/onboarding
 * screen) survives the grace and surfaces the hint.
 */
const HELD_PROMPT_HINT_DELAY_MS = 4_000;

/**
 * Live sessions belonging to the focused subject, in tab order (oldest first,
 * the order Cmd/Ctrl+1..9 selects). A session belongs to an agent when it is
 * bound to it, OR its cwd is the agent's folder and it is unbound; for a bare
 * folder (no agent) only the unbound-cwd clause can match. Pure, so it reads
 * the same way in the keyboard handler and in render.
 */
function liveSessionsForFocus(sessions: HarnessSession[], focusPath: string | null): HarnessSession[] {
  if (!focusPath) return [];
  return sessions
    .filter(
      (s) =>
        s.status !== "exited" &&
        (s.boundWorkflowPath === focusPath || (s.boundWorkflowPath == null && s.cwd === focusPath)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export const App = (): JSX.Element => {
  const harness = useHarnessState();
  // Live browser connectivity (navigator.onLine + online/offline events).
  // Combined with the boot-error kind below to pick the honest shell state.
  const online = useConnectivity();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The composer-first "new session" home. `composing` is explicit New-session
  // intent (Create new / the +); the home also shows whenever nothing else
  // claims the centre pane (first run, or every session closed).
  const [composing, setComposing] = useState(false);
  // The focused agent (or bare-scaffold folder) path — the rail's single
  // selection and the main panel's tab-strip subject. The active tab's
  // session is harness.activeSessionId.
  const [focusedAgentPath, setFocusedAgentPath] = useState<string | null>(null);
  // "Open in Studio" deep links (sapiom://agent/<id>). The applier is a ref
  // because it needs `state`/`handleFocusAgent`, which exist only past the loading
  // guard; the effects below reach it through the ref. The cold-start target rides
  // in on the ?agent=/?template= load-URL param; warm links come via the desktop bridge.
  const applyDeepLinkRef = useRef<((target: DeepLinkTarget) => void) | null>(null);
  const focusExistingRef = useRef<((definitionId: string) => boolean) | null>(null);
  const coldDeepLinkRef = useRef<DeepLinkTarget | null>(deepLinkFromSearch());
  const coldDeepLinkHandledRef = useRef(false);
  // A clone kicked off from a remote-only deep link: focus the agent once the
  // workspace rescan surfaces it locally.
  const pendingCloneFocusRef = useRef<string | null>(null);
  // The remote-only agent a deep link is offering to clone (drives the confirm).
  const [cloneRequest, setCloneRequest] = useState<DeepLinkAgentTarget | null>(null);
  // A template a deep link asked to open (`sapiom://templates/<id>`): the id is
  // handed to the templates browser, which resolves it against the live catalog
  // and opens its detail. Null when no template deep link is pending.
  const [deepLinkTemplateId, setDeepLinkTemplateId] = useState<string | null>(null);
  // Lifted so the telemetry chip in the session bar can open the settings
  // popover from outside SessionBar's own gear button.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Right tab is part of the held arrangement: restored on reload.
  // Guard against a stored "skills" value (tab removed) — fall back to canvas.
  const [rightTab, setRightTab] = useState<RightTab>(() => {
    const stored = loadUiPrefs().rightTab;
    return stored === "canvas" || stored === "steps" || stored === "code" ? stored : "canvas";
  });
  // Lazy-mount contract for the Code tab (Canvas | Steps | Code —
  // Code is the bound agent's integration projection).
  const [codePanelEverShown, setCodePanelEverShown] = useState(rightTab === "code");
  // A PAST session under review: picked from the history menu, shown
  // in the terminal slot as a review pane — resuming/starting is the pane's
  // explicit action, never a side effect of the click that got here.
  const [reviewSummary, setReviewSummary] = useState<SessionSummary | null>(null);
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

  // Register a prompt to be sent once its session is ready (i.e. Claude is
  // signed in). Sends immediately if already ready. While waiting, a delayed
  // hint (only if the session is still not ready after a grace) points the
  // user at the terminal login — so first-run intent is held, not lost.
  const sendPromptWhenReady = useCallback(
    (sessionId: string, prompt: string, failMessage: string): void => {
      clearPending(sessionId);
      const timer = window.setTimeout(() => {
        if (clearPending(sessionId)) harness.showToast(failMessage);
      }, HELD_PROMPT_TIMEOUT_MS);
      const hintTimer = window.setTimeout(() => {
        if (pendingPromptsRef.current.has(sessionId)) {
          harness.showToast(
            "Sign in to Claude in the terminal — your prompt sends automatically once you're signed in.",
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
  // Canvas full-screen expand — lifted here so its control sits next to the
  // collapse-panel toggle in the right-pane tab bar (the frame itself lives in
  // CanvasPane, which reads these props).
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const isMobile = useMobileShell();

  // Back/forward across every screen the shell can show. The stack is fed by
  // the place the shell IS (derived below), not by instrumenting each door, so
  // a new way into a view is navigable the day it lands.
  const navHistory = useNavigationHistory();

  const { widths, canvasResizing, railResizing, startRailDrag, startCanvasDrag, resetRail, resetCanvas } =
    usePaneWidths();
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
  const paneObserverRef = useRef<ResizeObserver | null>(null);
  const captureExpandedWidth = useCallback((el: HTMLDivElement | null): void => {
    if (el && !rightCollapsedRef.current) el.style.setProperty("--rp-w", `${el.offsetWidth}px`);
  }, []);
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
      if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "p")) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const tabs = liveSessionsForFocus(harness.state?.sessions ?? [], focusedAgentPath);
        const target = tabs[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          setComposing(false);
          setReviewSummary(null);
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
  }, [harness.state?.sessions, focusedAgentPath]);

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
  // first agent. Done once (a ref guard) so it never fights a later user
  // focus. Runs before the mobile-reset effect below — order is stable.
  const didInitFocus = useRef(false);
  useEffect(() => {
    if (didInitFocus.current || !harness.state) return;
    didInitFocus.current = true;
    const active = harness.state.sessions.find((s) => s.id === harness.activeSessionId);
    setFocusedAgentPath(boundWorkflowPathOf(active) ?? harness.state.workflows[0]?.path ?? null);
  }, [harness.state, harness.activeSessionId]);

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
    const active = st.sessions.find((session) => session.id === harness.activeSessionId);
    const view: HarnessView = {
      firstRun: st.firstRun === true,
      settingsOpen,
      templatesOpen,
      hasLiveSession: st.sessions.some((session) => session.status !== "exited"),
      // Reviewing a finished session (active session has exited) is the observe
      // arc — without this the dead-session view falls through to `unknown`.
      inspectingDeadSession: active?.status === "exited",
      rightTab,
    };
    registerViewContext(view);
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

  // The place the shell is showing, in the same precedence render uses. It is
  // derived rather than pushed at each door so every screen is navigable, and
  // recording it is idempotent: applying a visit re-derives the same place,
  // which dedupes against the tip instead of branching the stack.
  const recordVisit = navHistory.record;
  const activeSessionIdForNav = harness.activeSessionId;
  const focusHasLiveSession =
    focusedAgentPath != null &&
    liveSessionsForFocus(harness.state?.sessions ?? [], focusedAgentPath).length > 0;
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
    if (templatesOpen) {
      recordVisit({ kind: "templates" });
    } else if (reviewSummary) {
      recordVisit({ kind: "review", summary: reviewSummary });
    } else if (composing) {
      recordVisit({ kind: "composer" });
    } else if (activeSessionIdForNav && (focusedAgentPath == null || focusHasLiveSession)) {
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
      // Replaying, not navigating: tell the record effect to skip the one run
      // this state change triggers, so it never re-derives-and-pushes (which
      // would truncate the forward stack). See applyingVisitRef above.
      applyingVisitRef.current = true;
      setOverviewOpen(false);
      setTemplatesOpen(visit.kind === "templates");
      setComposing(visit.kind === "composer");
      setReviewSummary(visit.kind === "review" ? visit.summary : null);
      if (visit.kind === "session") {
        setFocusedAgentPath(visit.agentPath);
        setActiveSessionId(visit.sessionId);
      } else if (visit.kind === "agent") {
        setFocusedAgentPath(visit.agentPath);
      }
    },
    [setActiveSessionId],
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
      (session) => session.id === harness.activeSessionId && session.status === "exited",
    ) ?? null;
  const deadResumeMode = activeExitedSession?.agentSessionId
    ? harness.history.find((summary) => summary.agentSessionId === activeExitedSession.agentSessionId)?.resumeMode
    : "rehydrate";
  const deadCwdNeedingHistory =
    activeExitedSession?.agentSessionId != null && deadResumeMode === undefined ? activeExitedSession.cwd : null;
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
  const activeSession = state.sessions.find((session) => session.id === harness.activeSessionId) ?? null;
  const boundWorkflowPath = boundWorkflowPathOf(activeSession);
  const boundWorkflow = state.workflows.find((w) => w.path === boundWorkflowPath) ?? null;
  const focusedWorkflow = state.workflows.find((w) => w.path === focusedAgentPath) ?? null;

  // The focused subject's tabs, and which surface the main panel shows.
  const focusTabs = liveSessionsForFocus(state.sessions, focusedAgentPath);
  const showReview = reviewSummary != null;
  const showDead = !showReview && activeSession?.status === "exited";
  // An agent focused with no live session: honest absence, the reason opening
  // one lands on the "start a session" state rather than a board (the canvas
  // is served per session). `composing` (explicit New-session intent) forces
  // the composer over this and the workbench.
  const showAgentEmpty =
    !showReview && !showDead && !composing && focusedWorkflow != null && focusTabs.length === 0;
  // The workbench: an active live session in the focused subject's tabs.
  const showWorkbench =
    !showReview &&
    !showDead &&
    !composing &&
    !showAgentEmpty &&
    activeSession != null &&
    activeSession.status !== "exited";
  // The composer-first "new session" home: explicit intent, or nothing else to
  // show (first run, or every session closed). Replaces the WelcomePanel overlay
  // AND the old "No active session" fallback.
  const showComposer =
    !showReview && !showDead && (composing || (!showAgentEmpty && !showWorkbench));
  // A live session to return to when the composer was opened over the workbench.
  const composerCanCancel =
    composing && activeSession != null && activeSession.status !== "exited";

  // The right pane projects the ACTIVE session's bound agent — but nothing
  // (null) while a focused agent has no session, so it never shows a
  // different agent's board behind the "no session" state.
  const rightPaneWorkflow = showAgentEmpty ? null : boundWorkflow;
  const noSessionAgentName = showAgentEmpty
    ? (focusedWorkflow?.name ?? null)
    : null;
  // Identity of the board the auto-collapse reasons about (see
  // emptyCollapsedKeyRef).
  const emptyBoardKey = `${harness.activeSessionId ?? ""}::${rightPaneWorkflow?.path ?? ""}`;
  const expandRightPane = (): void => {
    manualExpandSessionRef.current = harness.activeSessionId ?? null;
    manualExpandPendingRef.current = harness.activeSessionId == null;
    setRightCollapsed(false);
  };
  const rightPaneDeploymentState = rightPaneWorkflow
    ? workflowDeploymentState(
        rightPaneWorkflow,
        harness.lastDeployErrorFor(rightPaneWorkflow.path),
      )
    : null;

  // Run inspection for the active session.
  const selectedObservedRun = harness.activeSessionId
    ? (harness.runsBySession.get(harness.activeSessionId) ?? null)
    : null;
  const activeObservedRun = observedRunMatchesWorkflow(
    selectedObservedRun,
    boundWorkflowPath,
  )
    ? selectedObservedRun
    : null;
  const activeSessionRuns: ObservedRun[] = harness.activeSessionId
    ? (harness.runIdsBySession.get(harness.activeSessionId) ?? [])
        .map((executionId) => harness.runsByExecution.get(executionId))
        .filter((observed): observed is ObservedRun => observed !== undefined)
        .filter((observed) =>
          observedRunMatchesWorkflow(observed, boundWorkflowPath),
        )
    : [];
  // The action button's honest "running" signal: tied to the SHOWN run's real
  // status, not the brief `directActionSettleSeq` pending ring (which clears at
  // hand-off). null unless the visible run is still running.
  const runningTarget: RunTarget | null =
    activeObservedRun?.run.status === "running" ? activeObservedRun.target : null;

  const closeMobileDrawer = (): void => {
    if (isMobile) setRailCollapsed(true);
  };

  // The ONE choke point for session creation: sets the focus to the new
  // session's folder (so the main panel shows it) and fires telemetry once.
  const createSessionAt = async (cwd: string, agentHarness: HarnessKind): Promise<HarnessSession> => {
    setComposing(false);
    setReviewSummary(null);
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
      const session = await harness.createSession({ cwd, harness: agentHarness });
      track("session.created");
      trackProduct("session.started", { harness_kind: agentHarness, origin: "user" });
      return session;
    } catch (err) {
      harness.removePendingWorkspace(cwd);
      throw err;
    }
  };

  const handleCreateSession = async (cwd: string, agentHarness: HarnessKind): Promise<void> => {
    await createSessionAt(cwd, agentHarness);
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
    const base =
      `Scaffold a new Sapiom agent project in this directory: ${starterScaffoldInstruction(cwd, "default")}, ` +
      "then run npm install, read AGENTS.md, and use the sapiom-agent-authoring skill to";
    const trimmedIdea = idea?.trim();
    sendPromptWhenReady(
      session.id,
      trimmedIdea
        ? `${base} build this:\n\n${trimmedIdea}`
        : `${base} define the first agent.`,
      "Couldn't send the scaffold prompt. Ask the coding agent to call sapiom_dev_agents_scaffold.",
    );
  };

  // The tab strip's + and the empty state's Start: begin ANOTHER session on the
  // focused agent. It lands in the agent's workspace (an existing tab's cwd if
  // one exists, else the agent's own folder), binds there, and focus stays on
  // the agent so the new session joins its tab strip.
  const handleStartSessionForAgent = (workflow: WorkflowInfo): void => {
    void (async () => {
      const owner = liveSessionsForFocus(state.sessions, workflow.path)[0];
      const cwd = owner?.cwd ?? workflow.path;
      try {
        const session = await createSessionAt(cwd, "claude-code");
        await harness.bindWorkflow(session.id, workflow.path);
        setFocusedAgentPath(workflow.path);
      } catch (err) {
        harness.showToast((err as Error).message || "Couldn't start the session.");
      }
    })();
  };

  // Bare-scaffold folder affordance: a live session sits in a folder
  // with no agent yet. Ask that session to scaffold its first agent in place.
  const handleScaffoldInSession = (sessionId: string): void => {
    const cwd = state.sessions.find((session) => session.id === sessionId)?.cwd ?? ".";
    sendPromptWhenReady(
      sessionId,
      `Scaffold a new Sapiom agent project in this directory: ${starterScaffoldInstruction(cwd, "default")}, then run npm install, read AGENTS.md, and use the sapiom-agent-authoring skill to define the first agent.`,
      "Couldn't send the scaffold prompt. Ask the coding agent to call sapiom_dev_agents_scaffold.",
    );
  };

  // Templates journey v0: "Use template" starts a session in the destination
  // folder and hands the agent the real operation.
  const handleUseTemplate = async (
    cwd: string,
    template: StudioTemplate,
    surface: "welcome" | "template_gallery" | "template_detail" = "template_gallery",
  ): Promise<void> => {
    const session = await createSessionAt(cwd, "claude-code");
    // Product metric — "templates used". Fires at the choke point every
    // template surface funnels through; `agent.created` fires later when the
    // clone produces a real sapiom.json, so built ≥ templates holds.
    trackProduct("agent.template_cloned", {
      template_slug: template.id,
      template_id: template.id,
      surface,
    });
    sendPromptWhenReady(
      session.id,
      useTemplatePrompt(template, cwd),
      template.kind === "gallery"
        ? "Couldn't send the clone prompt. Ask the coding agent to run sapiom_dev_agents_clone."
        : "Couldn't send the starter prompt. Ask the coding agent to call sapiom_dev_agents_scaffold.",
    );
  };

  // The composer home's two on-ramps. Both open a session in a FRESH project
  // folder under the project root (deduped so an existing folder is never
  // clobbered) and open the workbench terminal-only — the canvas reveals itself
  // once the agent generates content (see CanvasPane's onCanvasState below).
  const uniqueProjectDir = (base: string): string => {
    const taken = new Set<string>();
    for (const session of state.sessions) {
      const name = session.cwd.split("/").filter(Boolean).pop();
      if (name) taken.add(name);
    }
    for (const workflow of state.workflows) {
      const name = workflow.path.split("/").filter(Boolean).pop();
      if (name) taken.add(name);
    }
    return projectDirSuggestion(nextAvailableName(base, taken), projectRoot || null);
  };

  const handleComposerSubmitIdea = (idea: string, agentHarness: HarnessKind): void => {
    const cwd = uniqueProjectDir(idea.trim() ? slugifyIdea(idea) : FALLBACK_PROJECT_NAME);
    if (!cwd) {
      harness.showToast("Set a project folder first — use the + to open one.");
      return;
    }
    // Terminal-first: the new session's canvas slides in once it paints.
    setRightCollapsed(true);
    void handleScaffoldSession(cwd, agentHarness, idea.trim() || undefined);
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
    const found = await harness.scanWorkflows(root);
    // Finding agents is the win this dialog exists for; an empty sweep is a
    // neutral fact, not a failure.
    harness.showToast(
      found.length === 0
        ? "No agent projects found under this folder."
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
    closeMobileDrawer();
    const session = state.sessions.find((s) => s.id === id);
    if (session) setFocusedAgentPath(boundWorkflowPathOf(session) ?? session.cwd);
    harness.setActiveSessionId(id);
  };

  // Select a tab in the strip — same as openSession, but the tab always
  // belongs to the current focus, so focus never moves.
  const selectTab = (id: string): void => {
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    harness.setActiveSessionId(id);
  };


  // One entry point for reviewing a past (transcript) session.
  const reviewPastSession = (summary: SessionSummary): void => {
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

  // The rail verb: FOCUS an agent (or a bare folder). Focusing swaps the main
  // panel's tab strip to that subject's sessions and sets the active tab to
  // its most-recent session (or none -> the "start a session" empty state).
  // Opening agent A never disturbs another agent's binding.
  const handleFocusAgent = (path: string): void => {
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
    setFocusedAgentPath(path);
    closeMobileDrawer();
    const tabs = liveSessionsForFocus(state.sessions, path);
    // Keep the active session if it already belongs; otherwise take the
    // most-recent (last in the oldest-first tab order), or none.
    const nextActiveId = tabs.some((s) => s.id === harness.activeSessionId)
      ? harness.activeSessionId
      : (tabs[tabs.length - 1]?.id ?? null);
    if (nextActiveId !== harness.activeSessionId) harness.setActiveSessionId(nextActiveId);
    // The canvas follows the focus target automatically (onCanvasState): a
    // populated session shows its board, an empty one or an agent with no
    // session at all reports no content and the pane stays closed.
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
  const handleCloneDefinition = async (target: DeepLinkAgentTarget): Promise<void> => {
    setCloneRequest(null);
    const cwd = uniqueProjectDir(target.slug?.trim() || `agent-${target.definitionId}`);
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
      harness.showToast((err as Error).message || "Couldn't start a session to clone the agent.");
    }
  };

  // Binds a workflow to a live session in its own workspace and focuses it —
  // used when navigating to a launched sub-workflow from the canvas/steps, and
  // before running a macro against a workflow (the canvas is served from the
  // binding). Same-workspace by contract: it lands on a live
  // session in the workflow's own workspace, or STARTS one in the workflow's
  // folder. Resolves to the session the binding landed on.
  const handleBindWorkflow = async (path: string): Promise<string | null> => {
    closeMobileDrawer();
    const live = state.sessions.filter((s) => s.status !== "exited");
    const ownsPath = (s: HarnessSession): boolean =>
      s.boundWorkflowPath === path || path === s.cwd || path.startsWith(`${s.cwd}/`);
    // Prefer the ACTIVE tab when it already owns the workflow, so running a
    // macro against the current agent never yanks the workbench to a sibling
    // session in the same workspace (e.g. re-visualize on a two-tab agent).
    const active = live.find((s) => s.id === harness.activeSessionId);
    const owner =
      active && ownsPath(active)
        ? active
        : live
            .filter(ownsPath)
            .sort((a, b) => b.cwd.length - a.cwd.length || b.createdAt.localeCompare(a.createdAt))[0];
    let targetId: string;
    if (owner) {
      setComposing(false);
      setReviewSummary(null);
      setOverviewOpen(false);
      if (owner.id !== harness.activeSessionId) harness.setActiveSessionId(owner.id);
      targetId = owner.id;
    } else {
      try {
        targetId = (await createSessionAt(path, "claude-code")).id;
      } catch (err) {
        harness.showToast((err as Error).message || "Couldn't start a session in this folder.");
        return null;
      }
    }
    await harness.bindWorkflow(targetId, path);
    setFocusedAgentPath(path);
    return targetId;
  };

  // Shared by the canvas Visualize CTA, the steps macros, and anything else
  // that fires a macro. Running a macro against a workflow (re-)binds too — the
  // canvas is served from the binding, so a render on an unbound workflow would
  // draw into the wrong root.
  const handleRunMacroForWorkflow = (workflow: WorkflowInfo | null, macro: MacroDef): void => {
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
      if (workflow) sessionId = (await handleBindWorkflow(workflow.path)) ?? sessionId;
      if (macro.action.kind === "open-url") {
        window.open(resolveMacroUrl(macro.action.url, workflow), "_blank", "noopener,noreferrer");
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

  // "Describe with AI": run the describe macro HEADLESS (execution:"background")
  // so the agent edits the workflow source out of sight — never the interactive
  // terminal. The prompt is passed as the macro's `subject`; the source watcher
  // re-renders the canvas when the agent saves. The button's loading state is
  // driven by the resulting background task (see CanvasPane `describeRunning`).
  const handleDescribeWithAI = (workflow: WorkflowInfo): void => {
    void (async () => {
      const sessionId = (await handleBindWorkflow(workflow.path)) ?? harness.activeSessionId;
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
          style={!isMobile ? { width: railCollapsed ? 0 : widths.rail } : undefined}
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
          focusedAgentPath={focusedAgentPath}
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
            setOverviewOpen(true);
            setComposing(false);
            setReviewSummary(null);
            setTemplatesOpen(false);
            closeMobileDrawer();
          }}
          onNewSession={() => {
            setComposing(true);
            setTemplatesOpen(false);
            setOverviewOpen(false);
          }}
          onReviewSummary={reviewPastSession}
          history={harness.history}
          historyLoading={harness.historyLoading}
          onOpenHistory={(cwds) => void harness.loadHistory(cwds)}
          recentDirs={harness.settings?.recentDirs ?? []}
          launchDir={state.launchDir ?? null}
          listDir={harness.listDir}
          onCreateSession={handleCreateSession}
          listHarnesses={harness.listHarnesses}
          onScaffoldSession={handleScaffoldSession}
          onScaffoldInSession={handleScaffoldInSession}
          onBrowseTemplates={() => {
            setTemplatesOpen(true);
            setOverviewOpen(false);
          }}
          templatesActive={templatesOpen}
          onScanWorkflows={handleScanWorkflows}
          onToast={harness.showToast}
          telemetryOptIn={harness.settings?.telemetryOptIn ?? state.telemetryOptIn}
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

      {!railCollapsed && !isMobile && (
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
        {state.consentSource === "default-silent" && !harness.settings?.telemetryNoticeDismissed && (
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
            (!templatesOpen && !isMobile && !showComposer ? " canvas-animated" : "") +
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
              templatesOpen || isMobile || showComposer
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
              openedAgentName={noSessionAgentName}
              reviewTitle={reviewSummary ? reviewSummary.title : null}
              composing={showComposer}
              onBack={composerCanCancel ? () => setComposing(false) : null}
              activeSession={showWorkbench ? activeSession : showDead ? activeSession : null}
              sessionName={
                activeSession ? sessionDisplayName(activeSession, state.sessions, sessionNames) : null
              }
              onRenameSession={renameSession}
              boundWorkflowName={boundWorkflow?.name ?? null}
              sessions={showWorkbench ? focusTabs : []}
              onSelectSession={selectTab}
              labelOf={(session) => {
                // Sessions of the focused agent share its workspace folder, so
                // labelling them by that folder is redundant (the rail already
                // names the workspace). A session still on its folder default is
                // labelled by its AGENT instead, numbering extras; a real
                // rename/title passes through untouched.
                const display = sessionDisplayName(session, state.sessions, sessionNames);
                const folder = session.cwd.split("/").filter(Boolean).pop() ?? "";
                // Folder-default forms ONLY: the bare basename, or "<basename> N"
                // the dedup appends to repeats. A real rename or transcript title
                // that merely begins with the basename (e.g. "leasing draft")
                // must pass through — matching `startsWith("leasing ")` would have
                // silently replaced it with the agent name.
                const suffix = display.startsWith(`${folder} `) ? display.slice(folder.length + 1) : "";
                const isFolderDefault = display === folder || /^\d+$/.test(suffix);
                if (!isFolderDefault || !focusedWorkflow) return display;
                const idx = focusTabs.findIndex((s) => s.id === session.id);
                return idx > 0 ? `${focusedWorkflow.name} ${idx + 1}` : focusedWorkflow.name;
              }}
              busy={activeSession != null && harness.busySessionIds.has(activeSession.id)}
              onCloseSession={(id) => void harness.closeSession(id)}
              onOpenInEditor={openInEditor}
              editorLabel={editorLabel(harness.settings?.editor)}
              onToast={harness.showToast}
              onExpandRail={railCollapsed ? () => setRailCollapsed(false) : null}
              onExpandRight={rightCollapsed ? expandRightPane : null}
              onNewSession={() => setComposing(true)}
              /* The agent action cluster shares the one session bar — no
                 separate tab lane or action row. Switching sessions moves to
                 the rail / ⌘K / history. */
              actions={
                showWorkbench && activeSession && boundWorkflow ? (
                  <SessionStepsBar
                    workflow={boundWorkflow}
                    activeSessionId={harness.activeSessionId}
                    sessionReady={activeSession.ready === true && activeSession.status !== "exited"}
                    macros={state.macros}
                    onRunMacro={(macro) => handleRunMacroForWorkflow(boundWorkflow, macro)}
                    preview={harness.previewBySession.get(activeSession.id) ?? null}
                    lastDeployError={harness.lastDeployErrorFor(boundWorkflow.path)}
                    authenticated={state.authenticated}
                    directActionSettleSeq={harness.directActionSettleSeq}
                    runningTarget={runningTarget}
                  />
                ) : null
              }
            />

            <div className="terminal-slot">
              {showReview && reviewSummary ? (
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
                /* Honest absence: no session to render this agent's board from.
                   Start runs the create+bind path in the agent's own folder. */
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
                      onClick={() => handleStartSessionForAgent(focusedWorkflow)}
                    >
                      <Icon name="Plus" size={14} /> Start session
                    </button>
                  }
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
                  onUseTemplate={handleComposerUseTemplate}
                  onBrowseTemplates={() => setTemplatesOpen(true)}
                  listHarnesses={harness.listHarnesses}
                  listTemplates={harness.listTemplates}
                  telemetryOptIn={harness.settings?.telemetryOptIn ?? state.telemetryOptIn}
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

          {!rightCollapsed && !isMobile && !showComposer && (
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
              onClick={() => setRightCollapsed(true)}
            />
          )}

          {/* Right pane: Canvas | Steps | Code segmented switch + panels.
              Collapsed via CSS (never unmounted) so a running Visualize
              enrichment survives the collapse. */}
          <div
            ref={setRightPaneEl}
            className={"right-pane" + (rightCollapsed || showComposer ? " is-collapsed" : "")}
          >
            <div className="right-pane-tabs" role="tablist" aria-label="Right pane">
              <button
                role="tab"
                aria-selected={rightTab === "canvas"}
                className={"right-pane-tab" + (rightTab === "canvas" ? " is-active" : "")}
                onClick={() => setRightTab("canvas")}
                data-testid="right-tab-canvas"
              >
                <Icon name="Workflow" size={14} />
                Canvas
              </button>
              <button
                role="tab"
                aria-selected={rightTab === "steps"}
                className={"right-pane-tab" + (rightTab === "steps" ? " is-active" : "")}
                onClick={() => setRightTab("steps")}
                data-testid="right-tab-steps"
              >
                <Icon name="List" size={14} />
                Steps
              </button>
              <button
                role="tab"
                aria-selected={rightTab === "code"}
                className={"right-pane-tab" + (rightTab === "code" ? " is-active" : "")}
                onClick={() => {
                  setRightTab("code");
                  setCodePanelEverShown(true);
                }}
                data-testid="right-tab-code"
              >
                <Icon name="Code" size={14} />
                Code
              </button>
              <div className="right-pane-corner">
                {/* Cloud-status pill → dashboard. The board has no subheader,
                    so the link/build state lives here in the tab bar. */}
                {rightTab === "canvas" &&
                  rightPaneWorkflow?.definitionId != null && (
                    <a
                      className="status-tag status-tag-action workflow-deployed-tag right-pane-deployed"
                      data-testid="workflow-dashboard-link"
                      data-deployment-state={rightPaneDeploymentState ?? undefined}
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
                {/* Canvas expand sits right beside the collapse-panel toggle. */}
                {rightTab === "canvas" && (
                  <button
                    className="theme-toggle"
                    data-testid="canvas-expand"
                    aria-label={canvasExpanded ? "Exit expanded canvas" : "Expand canvas"}
                    title={canvasExpanded ? "Exit expanded canvas" : "Expand canvas"}
                    onClick={() => setCanvasExpanded((v) => !v)}
                  >
                    <Icon name={canvasExpanded ? "Minimize2" : "Maximize2"} size={15} />
                  </button>
                )}
                <button
                  className="theme-toggle right-pane-collapse"
                  data-testid="right-collapse"
                  aria-label="Collapse canvas panel"
                  title="Collapse canvas panel"
                  onClick={() => setRightCollapsed(true)}
                >
                  <Icon name="PanelRightClose" size={15} />
                </button>
              </div>
            </div>

            <div
              className={"right-pane-panel" + (rightTab === "canvas" || rightTab === "steps" ? "" : " is-hidden")}
              data-testid="right-panel-canvas"
            >
              <CanvasPane
                sessionId={harness.activeSessionId}
                lastMessage={harness.lastMessage}
                boundWorkflow={rightPaneWorkflow}
                noSessionAgent={noSessionAgentName}
                overviewActive={showComposer}
                sessionExited={showDead}
                onCanvasState={(hasContent) => {
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
                    state.sessions.find((s) => s.id === harness.activeSessionId)?.status ===
                    "exited";
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
                    manualExpandSessionRef.current = harness.activeSessionId ?? null;
                    return;
                  }
                  const claimed = manualExpandSessionRef.current;
                  if (claimed != null && claimed === harness.activeSessionId) return;
                  if (emptyCollapsedKeyRef.current === emptyBoardKey) return;
                  emptyCollapsedKeyRef.current = emptyBoardKey;
                  setRightCollapsed(true);
                }}
                expanded={canvasExpanded}
                onToggleExpanded={() => setCanvasExpanded((v) => !v)}
                macros={state.macros}
                tasks={harness.tasks}
                surface={rightTab === "steps" ? "steps" : "board"}
                onOpenSteps={() => setRightTab("steps")}
                run={activeObservedRun?.run ?? null}
                runTarget={activeObservedRun?.target ?? null}
                runs={activeSessionRuns}
                onSelectRun={(executionId) => {
                  if (harness.activeSessionId) harness.selectRun(harness.activeSessionId, executionId);
                }}
                preview={
                  harness.activeSessionId
                    ? (harness.previewBySession.get(harness.activeSessionId) ?? null)
                    : null
                }
                deployState={
                  rightPaneWorkflow
                    ? (harness.deployStateByPath.get(rightPaneWorkflow.path) ?? null)
                    : null
                }
                onDismissDeploy={() => {
                  if (rightPaneWorkflow) harness.dismissDeployState(rightPaneWorkflow.path);
                }}
                onOpenCode={() => {
                  setRightTab("code");
                  setCodePanelEverShown(true);
                }}
                workflows={state.workflows}
                onOpenWorkflow={(path) => void handleBindWorkflow(path)}
                onRunMacro={(macro) => handleRunMacroForWorkflow(boundWorkflow, macro)}
                onInjectPrompt={(text) => {
                  if (harness.activeSessionId) void harness.injectInput(harness.activeSessionId, text);
                }}
                onDescribeWorkflow={handleDescribeWithAI}
              />
            </div>

            {(rightTab === "code" || codePanelEverShown) && (
              <div
                className={"right-pane-panel" + (rightTab === "code" ? "" : " is-hidden")}
                data-testid="right-panel-code"
              >
                <CodePanel
                  boundWorkflow={rightPaneWorkflow}
                  noSessionAgent={noSessionAgentName}
                  agentsBaseUrl={state.agentsBaseUrl}
                  lastDeployError={
                    rightPaneWorkflow
                      ? harness.lastDeployErrorFor(rightPaneWorkflow.path)
                      : null
                  }
                />
              </div>
            )}

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
            setOverviewOpen(false);
            setTemplatesOpen(true);
          }}
          onDismiss={() => setOverviewOpen(false)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          sessions={state.sessions}
          workflows={state.workflows}
          recentDirs={harness.settings?.recentDirs ?? []}
          history={harness.history}
          listDir={harness.listDir}
          onSelectSession={openSession}
          onReviewSummary={reviewPastSession}
          onOpenPath={(cwd) => void handleCreateSession(cwd, "claude-code")}
          onBrowseTemplates={() => {
            setTemplatesOpen(true);
            setOverviewOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {cloneRequest && (
        <CloneAgentConfirm
          agentLabel={cloneRequest.slug ? `“${cloneRequest.slug}”` : `Agent ${cloneRequest.definitionId}`}
          onCancel={() => setCloneRequest(null)}
          onConfirm={() => void handleCloneDefinition(cloneRequest)}
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
