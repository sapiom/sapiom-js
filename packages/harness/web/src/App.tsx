/**
 * Harness SPA shell (plans/studio-navigation/flow-navigation.md, design.md).
 *
 * Two objects on screen, one mental model:
 *  1. THE RAIL — projects, each with its sessions under it (Project ›
 *     Sessions). One click reaches any session in any project. No agents,
 *     directories or Group axis: agents live on the project's map.
 *  2. THE CENTRE — ONE thing at a time: the selected session's workbench, or
 *     the selected project's Agent Map at full width. Never the two side by
 *     side; the map sharing the width with the chat is what the requester
 *     called out as the important part of the ask. Nothing sits beside a
 *     session: agent detail belongs to the project view
 *     (flow-map-chat-overlay.md 4.4.1).
 *
 * Two values decide all of it, and they are independent on purpose:
 *
 *   The selected SESSION (`harness.activeSessionId`, persisted). Changed only
 *               by a session click, Start chat, a project's `+`, Cmd/Ctrl+N.
 *   The VIEW   (`view`, `lib/centre-pane.ts`): session, a project's map, or
 *               an agent's modal over that map. A project click changes the
 *               view and leaves the selected session alone, so it stays
 *               highlighted in the rail and one click brings it back.
 *
 * What the centre shows is ONE pure function of those (`centrePane`), and
 * which sessions a project lists is ONE function (`lib/rail-sessions.ts`) read
 * by the rail and the shortcut. The map chat is not a session and is never
 * on the rail (I5): its client state is `useMapChat`, held here so it
 * outlives the project view.
 *
 * This file is the shell: it holds the View and renders the rail
 * (`ShellRail`), the centre switch and the cards on top (`ShellDialogs`). The
 * centre's two halves are `ProjectView` and `SessionView`. The doors are hooks
 * in `lib/`: `use-session-actions`, `use-project-actions`, `use-agent-verbs`,
 * `use-deep-links` and `use-shell-navigation` (Back/Forward, shortcuts); the
 * destinations and dialogs are `use-dialogs`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessSession } from "@shared/types";

import { createGraphViewportStore } from "./lib/graph-viewport";
import {
  ConnectivityBanner,
  ConnectivityScreen,
} from "./components/ConnectivityState";
import { McpAuthRestartNotice } from "./components/McpAuthRestartNotice";
import { PastSessionPane } from "./components/DeadSessionPane";
import { SessionBar } from "./components/SessionBar";
import { TelemetryNotice } from "./components/TelemetryNotice";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { Toast } from "./components/Toast";
import { TooltipLayer } from "./components/TooltipLayer";
import { NewSessionComposer } from "./components/NewSessionComposer";
import { templateIdea } from "./lib/creation-entry";
import { NoProjectHome } from "./components/NoProjectHome";
import { ShellRail } from "./components/ShellRail";
import { NoSessionSelected } from "./components/CentrePane";
import { ProjectView, projectViewChrome } from "./components/ProjectView";
import { SessionView, useAssistantDrafts } from "./components/SessionView";
import { ShellDialogs } from "./components/ShellDialogs";
import { boundWorkflowPathOf } from "./lib/api";
import { classifyConnectivity, useConnectivity } from "./lib/connectivity";
import {
  centrePane,
  shownProjectId,
  type CentreView,
} from "./lib/centre-pane";
import { editorLabel, editorUrl } from "./lib/editors";
import { initAnalytics, syncHarnessKind } from "./lib/analytics/posthog";
import { registerViewContext } from "./lib/analytics/events";
import type { HarnessView } from "./lib/analytics/journeys";
import { sessionDisplayName } from "./lib/session-name";
import { loadUiPrefs, saveUiPrefs } from "./lib/ui-prefs";
import { FALLBACK_HARNESSES } from "./lib/harness-registry";
import {
  isMobileShell,
  useMobileShell,
  usePaneWidths,
} from "./lib/use-pane-widths";
import { useHarnessState } from "./lib/use-harness-state";
import { useAgentMapEntry } from "./lib/use-agent-map-entry";
import { shellProjects } from "./lib/shell-projects";
import { useDialogs } from "./lib/use-dialogs";
import { useSessionActions, type ShellNav } from "./lib/use-session-actions";
import { useProjectActions } from "./lib/use-project-actions";
import { useAgentVerbs } from "./lib/use-agent-verbs";
import { useDeepLinks } from "./lib/use-deep-links";
import { useMapChat } from "./lib/use-map-chat";
import { useShellNavigation } from "./lib/use-shell-navigation";

export const App = (): JSX.Element => {
  const harness = useHarnessState();
  // A project map remounts when browsing another project or agent. Keep its
  // viewport for this signed-in UI lifetime, without persisting map data.
  const agentMapViewportStore = useMemo(
    createGraphViewportStore,
    [harness.authRevision],
  );
  const assistant = useAssistantDrafts(harness);
  // Live browser connectivity (navigator.onLine + online/offline events).
  // Combined with the boot-error kind below to pick the honest shell state.
  const online = useConnectivity();
  const isMobile = useMobileShell();
  const dialogs = useDialogs();
  const {
    composing,
    setComposing,
    composerProject,
    settingsOpen,
    setSettingsOpen,
    reviewSummary,
    setReviewSummary,
    templatesOpen,
    setTemplatesOpen,
    setOverviewOpen,
  } = dialogs;
  /**
   * WHAT THE CENTRE IS POINTED AT (design.md §1, the View slot): the selected
   * session, a project's Agent Map, or an agent's modal over that map.
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
  /** The agent picked on the map, by path: the card names it (4.2). */
  const [mapPanelPath, setMapPanelPath] = useState<string | null>(null);
  const mapChat = useMapChat({
    bootToken: harness.bootToken,
    authRevision: harness.authRevision,
  });
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
  /** See `ShellNav.navGenerationRef`. */
  const navGenerationRef = useRef(0);
  const viewProjectId = view.kind === "session" ? null : view.projectId;
  /** The centre map's full view. Its own flag, so leaving the map always
   *  lowers it. An agent's modal lowers it too: the full view is a fixed
   *  layer above the modal's (the modal shares the menu rung, so the board's
   *  own menus can open over it). */
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
  // Panel collapse: the rail unmounts (no state to preserve).
  const [railCollapsed, setRailCollapsed] = useState(
    () => isMobileShell() || (loadUiPrefs().railCollapsed ?? false),
  );
  const nav: ShellNav = {
    view,
    setView,
    navGenerationRef,
    setMapPanelPath,
    closeMobileDrawer: () => {
      if (isMobile) setRailCollapsed(true);
    },
  };
  const projects = harness.state
    ? shellProjects(harness.state, harness.settings?.recentDirs)
    : null;
  const sessions = useSessionActions({
    harness,
    projects,
    dialogs,
    nav,
  });
  const projectActions = useProjectActions({
    harness,
    projects,
    dialogs,
    nav,
    harnessChoice: sessions,
  });
  const verbs = useAgentVerbs({ harness, projects, nav, sessions, now });
  const { handleCloneDefinition } = useDeepLinks({
    harness,
    projects,
    dialogs,
    nav,
    sessions,
    openAgentCanvas: projectActions.openAgentCanvas,
  });
  const { hiddenSessionIds, pendingBindIds } = sessions;
  const navigation = useShellNavigation({
    harness,
    dialogs,
    nav,
    hiddenSessionIds,
    pendingBindIds,
  });

  const paneWidths = usePaneWidths();

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
    };
    registerViewContext(view);
    // Which coding agent is on screen, as a super-property, so an autocaptured
    // click can be broken down by agent. `session.started` already carries the
    // kind for the session it creates, but that is one event — everything
    // after it was unattributable. Null when nothing is active, rather than
    // leaving the last session's agent stamped on an empty workbench.
    syncHarnessKind(active?.harness ?? null);
  }, [st, harness.activeSessionId, settingsOpen, templatesOpen]);

  // Crossing the breakpoint resets the rail to that mode's default.
  const prevMobile = useRef(isMobile);
  useEffect(() => {
    if (prevMobile.current === isMobile) return;
    prevMobile.current = isMobile;
    setRailCollapsed(isMobile);
  }, [isMobile]);

  // Persist the arrangement. Mobile's forced-collapsed default is mode
  // behavior, not a user choice.
  useEffect(() => {
    if (!isMobile) saveUiPrefs({ railCollapsed });
  }, [railCollapsed, isMobile]);

  if (harness.loading) {
    return <div className="app-status">Loading Agent Studio…</div>;
  }
  // Boot failed (no state to render): degrade gracefully to a recoverable
  // state instead of a dead "Failed to load" white screen. The classifier
  // names it honestly from real signals — offline (browser/network), auth
  // (rejected credential — the server re-reads a rotated key on the retry's
  // request), or a generic server error — and Retry re-runs the boot fetch in
  // place. Mock mode never reaches here (its fetches always resolve).
  if (harness.error || !harness.state || !projects) {
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
  const { openSession, handleEndSession, handleHideSession } = sessions;
  const { handleNewProject, handleAddProject } = projectActions;
  navigation.openSessionRef.current = openSession;
  const { workspaceScopes } = projects;

  const activeSession =
    state.sessions.find((session) => session.id === harness.activeSessionId) ??
    null;
  const boundWorkflowPath = boundWorkflowPathOf(activeSession);
  const boundWorkflow =
    state.workflows.find((w) => w.path === boundWorkflowPath) ?? null;
  const sessionLabel = (session: HarnessSession): string =>
    sessionDisplayName(session, sessions.sessionNames);

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
  const conversationSession =
    centre.kind === "dead" || centre.kind === "workbench" ? activeSession : null;
  /** The session the header names: only when its workbench or dead pane is
   *  the centre. A project view's header names the project instead. */
  const sessionBarSession = conversationSession;
  // A live session to return to when the composer was opened over the workbench.
  const composerCanCancel =
    composing && activeSession != null && activeSession.status !== "exited";

  const { mapMode, header: projectViewHeader } = projectViewChrome({
    centre,
    state,
    projects,
    agentMapEntry,
    projectActions,
    onExpandMap: () => setMapExpanded(true),
  });

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
  const browseTemplates = (): void => {
    navGenerationRef.current += 1;
    setTemplatesOpen(true);
    setOverviewOpen(false);
  };
  const toggleTelemetry = async (next: boolean): Promise<void> => {
    await harness.updateSettings({ telemetryOptIn: next });
  };

  return (
    <div className="app-shell" data-rail-collapsed={railCollapsed || undefined}>
      <ShellRail
        harness={harness}
        state={state}
        dialogs={dialogs}
        nav={nav}
        sessions={sessions}
        projectActions={projectActions}
        navigation={navigation}
        paneWidths={paneWidths}
        isMobile={isMobile}
        railCollapsed={railCollapsed}
        setRailCollapsed={setRailCollapsed}
        shownProjectId={shownProject}
        pulseSessionId={mapChat.pulse?.sessionId ?? null}
        sessionLabel={sessionLabel}
        now={now}
        browseTemplates={browseTemplates}
        toggleTelemetry={toggleTelemetry}
      />

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
            (templatesOpen ? " is-browsing" : "")
          }
          style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
        >
          {/* Templates is a DESTINATION, not a session sub-view: it stands in
              for the workbench rather than sitting inside it, and brings its own
              header with the way back. Added as a sibling, with `.is-browsing`
              hiding the centre pane in CSS. */}
          {templatesOpen && (
            <TemplatesPanel
              onExit={() => setTemplatesOpen(false)}
              onUse={projectActions.handleUseTemplate}
              listTemplates={harness.listTemplates}
              getTemplate={harness.getTemplate}
              openTemplateId={dialogs.deepLinkTemplateId}
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
              onRenameSession={sessions.renameSession}
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
              projectView={projectViewHeader}
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
                  harness={sessions.selectedHarness}
                  entries={sessions.harnessEntries ?? FALLBACK_HARNESSES}
                  onHarnessChange={sessions.setSelectedHarness}
                  firstRun={state.firstRun === true}
                  onSubmitIdea={sessions.handleComposerSubmitIdea}
                  onAttachmentError={harness.showToast}
                  onUseTemplate={projectActions.handleComposerUseTemplate}
                  onBrowseTemplates={() => {
                    navGenerationRef.current += 1;
                    setTemplatesOpen(true);
                  }}
                  listTemplates={harness.listTemplates}
                  telemetryOptIn={
                    harness.settings?.telemetryOptIn ?? state.telemetryOptIn
                  }
                  onToggleTelemetry={toggleTelemetry}
                />
              ) : centre.kind === "project-map" ? (
                <ProjectView
                  harness={harness}
                  state={state}
                  projectId={centre.projectId}
                  projectLabel={projects.projectLabelOf(centre.projectId)}
                  projectRoot={
                    projects.projectScope(centre.projectId)?.cwd ?? ""
                  }
                  agentPath={centre.agentPath}
                  mapMode={mapMode}
                  agentMapEntry={agentMapEntry}
                  viewportStore={agentMapViewportStore}
                  agentsInProject={projects.agentsInProject}
                  mapExpanded={mapExpanded}
                  onToggleMapExpanded={() => setMapExpanded((value) => !value)}
                  mapPanelPath={mapPanelPath}
                  onPickAgent={setMapPanelPath}
                  onClosePanel={() => setMapPanelPath(null)}
                  onOpenAgent={projectActions.openAgentCanvas}
                  onCloseAgent={projectActions.backToMap}
                  mapChat={mapChat}
                  onSignIn={assistant.signIn}
                  onOpenSettings={() => setSettingsOpen(true)}
                  sessions={sessions}
                  verbs={verbs}
                />
              ) : (centre.kind === "dead" || centre.kind === "workbench") &&
                conversationSession ? (
                <SessionView
                  harness={harness}
                  session={conversationSession}
                  exited={centre.kind === "dead"}
                  setup={sessions.setupBySession.get(conversationSession.id)}
                  deadResumeMode={sessions.deadResumeMode}
                  assistant={assistant}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onHide={handleHideSession}
                />
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
                  onToggleTelemetry={toggleTelemetry}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <ShellDialogs
        harness={harness}
        state={state}
        dialogs={dialogs}
        nav={nav}
        sessions={sessions}
        verbs={verbs}
        activeSession={activeSession}
        sessionRoot={projects.sessionRoot}
        railCollapsed={railCollapsed}
        onToggleRail={() => setRailCollapsed((collapsed) => !collapsed)}
        onAddProject={handleAddProject}
        onFolderChosen={projectActions.handleProjectFolderChosen}
        onCloneDefinition={handleCloneDefinition}
        onRemoveProject={projectActions.handleRemoveProject}
      />

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
