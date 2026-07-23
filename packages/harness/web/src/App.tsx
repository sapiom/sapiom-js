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
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessKind, HarnessSession, MacroDef, SessionSummary, WorkflowInfo } from "@shared/types";

import { CanvasPane } from "./components/CanvasPane";
import { CodePanel } from "./components/CodePanel";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectivityBanner, ConnectivityScreen } from "./components/ConnectivityState";
import { DeadSessionPane, PastSessionPane } from "./components/DeadSessionPane";
import { EmptyState } from "./components/EmptyState";
import { Icon } from "./components/Icon";
import { ImageComposer } from "./components/ImageComposer";
import { SessionBar } from "./components/SessionBar";
import { SessionStepsBar } from "./components/SessionStepsBar";
import { SessionTabs } from "./components/SessionTabs";
import { TelemetryNotice } from "./components/TelemetryNotice";
import { TemplatesDialog } from "./components/TemplatesDialog";
import { Terminal } from "./components/Terminal";
import { Toast } from "./components/Toast";
import { TooltipLayer } from "./components/TooltipLayer";
import { WelcomePanel } from "./components/WelcomePanel";
import { WorkflowsRail } from "./components/WorkflowsRail";
import { ApiError, boundWorkflowPathOf } from "./lib/api";
import { classifyConnectivity, useConnectivity } from "./lib/connectivity";
import { useTemplatePrompt, type StudioTemplate } from "./lib/templates";
import { track } from "./lib/track";
import { resolveMacroUrl } from "./lib/macro-gating";
import { directActionKind } from "./lib/macro-actions";
import { sessionDisplayName } from "./lib/session-name";
import { loadUiPrefs, saveUiPrefs } from "./lib/ui-prefs";
import { CANVAS_MIN, RAIL_MIN, isMobileShell, useMobileShell, usePaneWidths } from "./lib/use-pane-widths";
import { useHarnessState, type ObservedRun } from "./lib/use-harness-state";

type RightTab = "canvas" | "steps" | "code";

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
  // Overview (in the rail's account menu): shows the intro panel in the main
  // slot. Opening any session leaves it (openSession below is the one path).
  const [overviewSelected, setOverviewSelected] = useState(false);
  // The focused agent (or bare-scaffold folder) path — the rail's single
  // selection and the main panel's tab-strip subject. The active tab's
  // session is harness.activeSessionId.
  const [focusedAgentPath, setFocusedAgentPath] = useState<string | null>(null);
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
  // Panel collapse: the rail unmounts (no state to preserve); the right pane
  // hides via CSS so a running Visualize enrichment survives the collapse.
  const [railCollapsed, setRailCollapsed] = useState(
    () => isMobileShell() || (loadUiPrefs().railCollapsed ?? false),
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    () => isMobileShell() || (loadUiPrefs().rightCollapsed ?? false),
  );
  const isMobile = useMobileShell();

  const { widths, startRailDrag, startCanvasDrag, resetRail, resetCanvas } = usePaneWidths();

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
          setOverviewSelected(false);
          setReviewSummary(null);
          harness.setActiveSessionId(target.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness.state?.sessions, focusedAgentPath]);

  // Opening the palette fans out the history load (the palette half).
  useEffect(() => {
    if (!paletteOpen || !harness.state) return;
    const dirs: string[] = [];
    const push = (dir?: string | null): void => {
      if (dir && !dirs.includes(dir)) dirs.push(dir);
    };
    harness.state.sessions.forEach((session) => push(session.cwd));
    (harness.settings?.recentDirs ?? []).forEach((dir) => push(dir));
    if (dirs.length > 0) void harness.loadHistory(dirs.slice(0, 12));
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

  if (harness.loading) {
    return <div className="app-status">Loading Sapiom Studio…</div>;
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
  const hasLiveSession = state.sessions.some((session) => session.status !== "exited");
  const showWelcome = overviewSelected || (state.firstRun === true && !hasLiveSession);
  const showReview = !showWelcome && reviewSummary != null;
  const showDead = !showWelcome && !showReview && activeSession?.status === "exited";
  // An agent focused with no live session: honest absence, the reason opening
  // one lands on the "start a session" state rather than a board (the canvas
  // is served per session).
  const showAgentEmpty =
    !showWelcome && !showReview && !showDead && focusedWorkflow != null && focusTabs.length === 0;
  // The workbench: an active live session in the focused subject's tabs.
  const showWorkbench =
    !showWelcome &&
    !showReview &&
    !showDead &&
    !showAgentEmpty &&
    activeSession != null &&
    activeSession.status !== "exited";
  // The tab strip renders in the workbench (one tab per belonging session).
  const showTabs = showWorkbench && focusTabs.length > 0;

  // The right pane projects the ACTIVE session's bound agent — but nothing
  // (null) while a focused agent has no session, so it never shows a
  // different agent's board behind the "no session" state.
  const rightPaneWorkflow = showAgentEmpty ? null : boundWorkflow;
  const noSessionAgentName = showAgentEmpty ? (focusedWorkflow?.name ?? null) : null;

  // Run inspection for the active session.
  const activeObservedRun = harness.activeSessionId
    ? (harness.runsBySession.get(harness.activeSessionId) ?? null)
    : null;
  const activeSessionRuns: ObservedRun[] = harness.activeSessionId
    ? (harness.runIdsBySession.get(harness.activeSessionId) ?? [])
        .map((executionId) => harness.runsByExecution.get(executionId))
        .filter((observed): observed is ObservedRun => observed !== undefined)
    : [];

  const closeMobileDrawer = (): void => {
    if (isMobile) setRailCollapsed(true);
  };

  // The ONE choke point for session creation: sets the focus to the new
  // session's folder (so the main panel shows it) and fires telemetry once.
  const createSessionAt = async (cwd: string, agentHarness: HarnessKind): Promise<HarnessSession> => {
    setOverviewSelected(false);
    setReviewSummary(null);
    setFocusedAgentPath(cwd);
    closeMobileDrawer();
    const session = await harness.createSession({ cwd, harness: agentHarness });
    track("session.created");
    return session;
  };

  const handleCreateSession = async (cwd: string, agentHarness: HarnessKind): Promise<void> => {
    await createSessionAt(cwd, agentHarness);
  };

  // Session-then-prompt flows (scaffold, templates): the pty needs a beat to
  // become interactive, so a 409 (session not ready) retries a few times.
  const injectPromptWithRetry = (sessionId: string, prompt: string, failMessage: string): void => {
    const inject = async (attempt: number): Promise<void> => {
      try {
        await harness.injectInput(sessionId, prompt);
      } catch (err) {
        if (attempt < 6 && err instanceof ApiError && err.status === 409) {
          window.setTimeout(() => void inject(attempt + 1), 1500);
          return;
        }
        harness.showToast(failMessage);
      }
    };
    void inject(0);
  };

  // The idea-to-agent path. Starts a session at the (new) folder, then
  // hands the agent the scaffold prompt.
  const handleScaffoldSession = async (cwd: string, agentHarness: HarnessKind): Promise<void> => {
    const session = await createSessionAt(cwd, agentHarness);
    injectPromptWithRetry(
      session.id,
      "Scaffold a new Sapiom agent project in this directory: run `sapiom agents init .`, then use the sapiom-agent-authoring skill to define the first workflow.",
      "Couldn't send the scaffold prompt. Ask the agent to run sapiom agents init.",
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
    injectPromptWithRetry(
      sessionId,
      "Scaffold a new Sapiom agent project in this directory: run `sapiom agents init .`, then use the sapiom-agent-authoring skill to define the first workflow.",
      "Couldn't send the scaffold prompt. Ask the agent to run sapiom agents init.",
    );
  };

  // Templates journey v0: "Use template" starts a session in the destination
  // folder and hands the agent the real operation.
  const handleUseTemplate = async (cwd: string, template: StudioTemplate): Promise<void> => {
    const session = await createSessionAt(cwd, "claude-code");
    injectPromptWithRetry(
      session.id,
      useTemplatePrompt(template, cwd),
      template.kind === "gallery"
        ? "Couldn't send the clone prompt. Ask the agent to run sapiom_dev_agents_clone."
        : "Couldn't send the starter prompt. Ask the agent to run sapiom agents init.",
    );
  };

  // Bulk discovery from the add dialog.
  const handleScanWorkflows = async (root: string): Promise<number> => {
    const found = await harness.scanWorkflows(root);
    harness.showToast(
      found.length === 0
        ? "No agent projects found under this folder."
        : found.length === 1
          ? "Found 1 agent project."
          : `Found ${found.length} agent projects.`,
    );
    return found.length;
  };

  // Switch to a session (history-menu pick, palette hit): focus follows it so
  // the main panel shows its context (its bound agent, or its own folder).
  const openSession = (id: string): void => {
    setOverviewSelected(false);
    setReviewSummary(null);
    closeMobileDrawer();
    const session = state.sessions.find((s) => s.id === id);
    if (session) setFocusedAgentPath(boundWorkflowPathOf(session) ?? session.cwd);
    harness.setActiveSessionId(id);
  };

  // Select a tab in the strip — same as openSession, but the tab always
  // belongs to the current focus, so focus never moves.
  const selectTab = (id: string): void => {
    setOverviewSelected(false);
    setReviewSummary(null);
    harness.setActiveSessionId(id);
  };

  // Close a tab (× -> end-session confirm handled in SessionTabs). If it was
  // the active tab, fall back to another tab of the focused agent, or the
  // empty state when none remain.
  const handleCloseTab = (id: string): void => {
    void (async () => {
      const fallback = focusTabs.find((s) => s.id !== id) ?? null;
      const wasActive = harness.activeSessionId === id;
      try {
        await harness.closeSession(id);
      } catch {
        return; // closeSession surfaced its own toast; keep the tab.
      }
      if (wasActive) harness.setActiveSessionId(fallback ? fallback.id : null);
    })();
  };

  // One entry point for reviewing a past (transcript) session.
  const reviewPastSession = (summary: SessionSummary): void => {
    setOverviewSelected(false);
    setReviewSummary(summary);
    closeMobileDrawer();
  };

  // Jump from the Studio to the real code.
  const openInEditor = (path: string): void => {
    // `editorUrlTemplate` is a forward-looking setting the canonical contract
    // doesn't carry yet; read it defensively so the default holds on servers
    // (and mocks) that omit it.
    const template =
      (harness.settings as { editorUrlTemplate?: string } | null)?.editorUrlTemplate ??
      "vscode://file{path}";
    window.location.href = template.replace("{path}", encodeURI(path));
  };

  // The rail verb: FOCUS an agent (or a bare folder). Focusing swaps the main
  // panel's tab strip to that subject's sessions and sets the active tab to
  // its most-recent session (or none -> the "start a session" empty state).
  // Opening agent A never disturbs another agent's binding.
  const handleFocusAgent = (path: string): void => {
    setOverviewSelected(false);
    setReviewSummary(null);
    setFocusedAgentPath(path);
    closeMobileDrawer();
    const tabs = liveSessionsForFocus(state.sessions, path);
    // Keep the active session if it already belongs; otherwise take the
    // most-recent (last in the oldest-first tab order), or none.
    if (tabs.some((s) => s.id === harness.activeSessionId)) return;
    const mostRecent = tabs[tabs.length - 1] ?? null;
    harness.setActiveSessionId(mostRecent ? mostRecent.id : null);
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
      setOverviewSelected(false);
      setReviewSummary(null);
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
      let sessionId = harness.activeSessionId;
      if (workflow) sessionId = (await handleBindWorkflow(workflow.path)) ?? sessionId;
      if (macro.action.kind === "open-url") {
        window.open(resolveMacroUrl(macro.action.url, workflow), "_blank", "noopener,noreferrer");
        return;
      }
      if (!sessionId) return;
      // Deploy / Prod-run / Run-local run via the DIRECT harness routes (no
      // Claude Code, no user LLM credits). Once a macro is a direct action we
      // NEVER fall through to the pty-inject runMacro — the buttons are already
      // gated (require a workflow / a deploy), so a missing prerequisite here is
      // a no-op, never a silent revert to the Claude Code path.
      const direct = directActionKind(macro.id);
      if (direct !== null) {
        if (direct === "deploy") {
          if (!workflow) {
            harness.showToast("Select a workflow first.");
          } else {
            void harness.deploy(workflow.path);
          }
        } else if (direct === "prod-run") {
          if (workflow?.definitionId != null) {
            // definitionId is present (the button is deploy-gated); the runs route
            // wants it as a string.
            void harness.startProdRun(sessionId, String(workflow.definitionId));
          } else {
            // The button is already disabled in SessionStepsBar when there's no
            // definitionId — this branch only fires if something bypasses the UI
            // gate (e.g. a direct keyboard call). Toast the reason explicitly so
            // it is never silent.
            const lastErr = workflow ? harness.lastDeployErrorFor(workflow.path) : null;
            harness.showToast(
              lastErr
                ? "Last deploy failed — retry Deploy."
                : "This agent isn't deployed yet — deploy it first.",
            );
          }
        } else if (direct === "run-local") {
          if (!workflow) {
            harness.showToast("Select a workflow first.");
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

  return (
    <div className="app-shell">
      {isMobile && !railCollapsed && (
        <div
          className="shell-scrim"
          data-testid="rail-drawer-scrim"
          aria-hidden="true"
          onClick={() => setRailCollapsed(true)}
        />
      )}
      {!railCollapsed && (
        <WorkflowsRail
          width={widths.rail}
          minWidth={RAIL_MIN}
          workflows={state.workflows}
          sessions={state.sessions}
          activeSessionId={harness.activeSessionId}
          focusedAgentPath={focusedAgentPath}
          onFocusAgent={handleFocusAgent}
          onOpenPalette={() => setPaletteOpen(true)}
          onConnect={async (path) => {
            await harness.connectWorkflow(path);
          }}
          onCollapse={() => setRailCollapsed(true)}
          onSelectSession={openSession}
          overviewSelected={overviewSelected}
          onSelectOverview={() => {
            setOverviewSelected(true);
            setReviewSummary(null);
            closeMobileDrawer();
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
          onUseTemplate={handleUseTemplate}
          onScanWorkflows={handleScanWorkflows}
          onOpenInEditor={openInEditor}
          onToast={harness.showToast}
          telemetryOptIn={harness.settings?.telemetryOptIn ?? state.telemetryOptIn}
          consentSource={state.consentSource}
          consentEnvReason={state.consentEnvReason}
          authenticated={state.authenticated}
          organizationName={state.organizationName}
          onToggleTelemetry={async (next) => {
            await harness.updateSettings({ telemetryOptIn: next });
          }}
          onStartAuth={harness.startAuth}
          onDisconnect={harness.disconnect}
          settingsOpen={settingsOpen}
          onSetSettingsOpen={setSettingsOpen}
        />
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
          className="app"
          style={{
            gridTemplateColumns: isMobile
              ? "minmax(0, 1fr)"
              : rightCollapsed
                ? `minmax(${CANVAS_MIN}px, 1fr)`
                : widths.canvas == null
                  ? `minmax(${CANVAS_MIN}px, 1fr) minmax(${CANVAS_MIN}px, 1fr)`
                  : `minmax(${CANVAS_MIN}px, 1fr) minmax(${CANVAS_MIN}px, ${widths.canvas}px)`,
          }}
        >
          <div className="center-pane">
            <SessionBar
              overviewMode={showWelcome}
              openedAgentName={noSessionAgentName}
              reviewTitle={!showWelcome && reviewSummary ? reviewSummary.title : null}
              activeSession={showWorkbench ? activeSession : showDead ? activeSession : null}
              sessionName={
                activeSession ? sessionDisplayName(activeSession, state.sessions, sessionNames) : null
              }
              onRenameSession={renameSession}
              boundWorkflowName={boundWorkflow?.name ?? null}
              busy={activeSession != null && harness.busySessionIds.has(activeSession.id)}
              onCloseSession={(id) => void harness.closeSession(id)}
              onOpenInEditor={openInEditor}
              onToast={harness.showToast}
              onExpandRail={railCollapsed ? () => setRailCollapsed(false) : null}
              onExpandRight={rightCollapsed ? () => setRightCollapsed(false) : null}
            />

            {/* Session tab strip: one tab per live session belonging to the
                focused agent. Session switching lives here, not in the rail. */}
            {showTabs && (
              <SessionTabs
                sessions={focusTabs}
                activeSessionId={harness.activeSessionId}
                busySessionIds={harness.busySessionIds}
                labelOf={(session) => sessionDisplayName(session, state.sessions, sessionNames)}
                agentName={focusedWorkflow?.name ?? activeSession?.title ?? "this agent"}
                onSelect={selectTab}
                onClose={handleCloseTab}
                onNew={() => {
                  if (focusedWorkflow) handleStartSessionForAgent(focusedWorkflow);
                  else if (focusedAgentPath) void handleCreateSession(focusedAgentPath, "claude-code");
                }}
              />
            )}

            {/* Agent action bar: shown for the active session's bound workflow
                in the workbench. Hidden while reviewing/dead/empty. */}
            {showWorkbench && activeSession && boundWorkflow && (
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
              />
            )}
            <div className="terminal-slot">
              {showWelcome ? (
                <WelcomePanel
                  recentDirs={harness.settings?.recentDirs ?? []}
                  launchDir={state.launchDir ?? null}
                  listDir={harness.listDir}
                  onCreateSession={handleCreateSession}
                  listHarnesses={harness.listHarnesses}
                  onUseTemplate={handleUseTemplate}
                  onRunSample={async () => {
                    const session = await harness.createSampleSession();
                    setOverviewSelected(false);
                    setReviewSummary(null);
                    setFocusedAgentPath(session.cwd);
                  }}
                />
              ) : showReview && reviewSummary ? (
                <PastSessionPane
                  summary={reviewSummary}
                  resumable={
                    (reviewSummary.harnessSessionId != null &&
                      state.sessions.some((s) => s.id === reviewSummary.harnessSessionId)) ||
                    state.sessions.some(
                      (s) => s.agentSessionId != null && s.agentSessionId === reviewSummary.agentSessionId,
                    )
                  }
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
                  onResume={() => void harness.resumeSession(activeSession.id)}
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
                <ImageComposer
                  sessionId={harness.activeSessionId}
                  harness={activeSession?.harness ?? "claude-code"}
                  api={harness.api}
                  showToast={harness.showToast}
                >
                  <div className="agent-view" data-testid="agent-view">
                    <div className="agent-view-panel" id="agent-panel-terminal">
                      <Terminal sessionId={harness.activeSessionId} token={harness.bootToken} />
                    </div>
                  </div>
                </ImageComposer>
              ) : (
                <EmptyState
                  className="terminal-empty"
                  icon="Radio"
                  title="No active session"
                  body="Focus an agent in the workspace panel, then start a session. Your coding agent runs right here, in a real terminal. ⌘K jumps anywhere."
                />
              )}
            </div>
          </div>

          {!rightCollapsed && !isMobile && (
            <div
              className="pane-resize-handle pane-resize-handle-canvas"
              style={{ right: widths.canvas ?? "50%" }}
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
          <div className={"right-pane" + (rightCollapsed ? " is-collapsed" : "")}>
            <div className="right-pane-tabs" role="tablist" aria-label="Right pane">
              <button
                role="tab"
                aria-selected={rightTab === "canvas"}
                className={"right-pane-tab" + (rightTab === "canvas" ? " is-active" : "")}
                onClick={() => setRightTab("canvas")}
                data-testid="right-tab-canvas"
              >
                Canvas
              </button>
              <button
                role="tab"
                aria-selected={rightTab === "steps"}
                className={"right-pane-tab" + (rightTab === "steps" ? " is-active" : "")}
                onClick={() => setRightTab("steps")}
                data-testid="right-tab-steps"
              >
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
                Code
              </button>
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

            <div
              className={"right-pane-panel" + (rightTab === "canvas" || rightTab === "steps" ? "" : " is-hidden")}
              data-testid="right-panel-canvas"
            >
              <CanvasPane
                sessionId={harness.activeSessionId}
                lastMessage={harness.lastMessage}
                boundWorkflow={rightPaneWorkflow}
                noSessionAgent={noSessionAgentName}
                activeSessionId={harness.activeSessionId}
                overviewActive={showWelcome}
                sessionExited={showDead}
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
                workflows={state.workflows}
                onOpenWorkflow={(path) => void handleBindWorkflow(path)}
                onRunMacro={(macro) => handleRunMacroForWorkflow(boundWorkflow, macro)}
                onInjectPrompt={(text) => {
                  if (harness.activeSessionId) void harness.injectInput(harness.activeSessionId, text);
                }}
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
                />
              </div>
            )}

          </div>
        </div>
      </div>

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
          onBrowseTemplates={() => setTemplatesOpen(true)}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {templatesOpen && (
        <TemplatesDialog
          launchDir={activeSession?.cwd ?? state.launchDir ?? null}
          onClose={() => setTemplatesOpen(false)}
          onUse={handleUseTemplate}
        />
      )}

      {harness.toast && <Toast message={harness.toast} onDismiss={harness.dismissToast} />}
      <TooltipLayer />
    </div>
  );
};
