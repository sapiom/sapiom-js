import type { JSX } from "react";
import type { AppState, HarnessSession } from "@shared/types";

import { WorkflowsRail } from "./WorkflowsRail";
import { resolveEditor } from "../lib/editors";
import { track } from "../lib/track";
import type { Dialogs } from "../lib/use-dialogs";
import type { HarnessStateHook } from "../lib/use-harness-state";
import { RAIL_MIN, type usePaneWidths } from "../lib/use-pane-widths";
import type { ProjectActions } from "../lib/use-project-actions";
import type { SessionActions, ShellNav } from "../lib/use-session-actions";
import type { ShellNavigation } from "../lib/use-shell-navigation";

/**
 * THE RAIL in its slot (flow-navigation.md 4.2): projects with their sessions,
 * the history card, settings and the account menu, plus its resize handle and
 * the mobile drawer's scrim. Every door it offers is the shell's own.
 */
export function ShellRail({
  harness,
  state,
  dialogs,
  nav,
  sessions,
  projectActions,
  navigation,
  paneWidths,
  isMobile,
  railCollapsed,
  setRailCollapsed,
  shownProjectId,
  pulseSessionId,
  sessionLabel,
  now,
  browseTemplates,
  toggleTelemetry,
}: {
  harness: HarnessStateHook;
  state: AppState;
  dialogs: Dialogs;
  nav: ShellNav;
  sessions: SessionActions;
  projectActions: ProjectActions;
  navigation: ShellNavigation;
  paneWidths: ReturnType<typeof usePaneWidths>;
  isMobile: boolean;
  railCollapsed: boolean;
  setRailCollapsed: (collapsed: boolean) => void;
  shownProjectId: string | null;
  /** The session a map chat's hand-off just made (I6): its row pulses. */
  pulseSessionId: string | null;
  sessionLabel: (session: HarnessSession) => string;
  now: number;
  browseTemplates: () => void;
  toggleTelemetry: (next: boolean) => Promise<void>;
}): JSX.Element {
  const { widths, railResizing, startRailDrag, resetRail } = paneWidths;
  const { navHistory, applyVisit } = navigation;
  return (
    <>
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
        hiddenSessionIds={sessions.hiddenSessionIds}
        pendingBindSessionIds={sessions.pendingBindIds}
        now={now}
        sessionLabel={sessionLabel}
        workspaceScopes={state.workspaceScopes}
        studioProjects={state.studioProjects}
        shownProjectId={dialogs.templatesOpen ? null : shownProjectId}
        pulseSessionId={pulseSessionId}
        onSelectProject={projectActions.handleSelectProject}
        onNewChat={sessions.handleNewChat}
        onSelectSession={(id) => {
          sessions.openSession(id);
          track("session.switched", { navigation_kind: "rail_session" }, id);
        }}
        onEndSession={sessions.handleEndSession}
        onHideSession={sessions.handleHideSession}
        onRemoveProject={(project, trigger) => {
          dialogs.removeTriggerRef.current = trigger;
          dialogs.setRemoving({ root: project.root, label: project.label });
        }}
        onOpenPalette={() => dialogs.setPaletteOpen(true)}
        onCollapse={() => setRailCollapsed(true)}
        canGoBack={navHistory.canGoBack}
        canGoForward={navHistory.canGoForward}
        onGoBack={() => applyVisit(navHistory.goBack())}
        onGoForward={() => applyVisit(navHistory.goForward())}
        overviewSelected={dialogs.overviewOpen}
        onSelectOverview={() => {
          nav.navGenerationRef.current += 1;
          dialogs.setOverviewOpen(true);
          dialogs.setComposing(false);
          dialogs.setReviewSummary(null);
          dialogs.setTemplatesOpen(false);
          nav.closeMobileDrawer();
        }}
        onNewProject={projectActions.handleNewProject}
        onAddProject={projectActions.handleAddProject}
        onReviewSummary={sessions.reviewPastSession}
        history={harness.history}
        historyLoading={harness.historyLoading}
        onOpenHistory={(cwds) => void harness.loadHistory(cwds)}
        recentDirs={harness.settings?.recentDirs ?? []}
        closedProjects={harness.closedProjects}
        unsearchedCheckouts={harness.unsearchedCheckouts}
        onBrowseTemplates={browseTemplates}
        templatesActive={dialogs.templatesOpen}
        onToast={harness.showToast}
        telemetryOptIn={
          harness.settings?.telemetryOptIn ?? state.telemetryOptIn
        }
        consentSource={state.consentSource}
        consentEnvReason={state.consentEnvReason}
        authenticated={state.authenticated}
        organizationName={state.organizationName}
        onToggleTelemetry={toggleTelemetry}
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
        settingsOpen={dialogs.settingsOpen}
        onSetSettingsOpen={dialogs.setSettingsOpen}
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
    </>
  );
}
