/**
 * Harness SPA shell (workstream W2).
 *
 * Layout: workflows rail (left) | docked action strip (anchored to the
 * selected workflow's row) | session tab strip + terminal (center) |
 * canvas/skills right pane. The strip carries the selected workflow's
 * full action set; the right pane has a segmented switch (Canvas | Skills)
 * at the top — canvas stays mounted behind CSS when Skills is active so a
 * running Visualize enrichment is never disturbed by a tab flip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { HarnessKind, MacroDef, WorkflowInfo } from "@shared/types";

import { BrandHeader } from "./components/BrandHeader";
import { CanvasPane } from "./components/CanvasPane";
import { CommandPalette } from "./components/CommandPalette";
import { DeadSessionPane } from "./components/DeadSessionPane";
import { SessionBar } from "./components/SessionBar";
import { SkillsPanel } from "./components/SkillsPanel";
import { TelemetryNotice } from "./components/TelemetryNotice";
import { Terminal } from "./components/Terminal";
import { Toast } from "./components/Toast";
import { WelcomePanel } from "./components/WelcomePanel";
import { WorkflowActionStrip } from "./components/WorkflowActionStrip";
import { WorkflowsRail } from "./components/WorkflowsRail";
import { boundWorkflowPathOf } from "./lib/api";
import { useElementTopOffset } from "./lib/use-element-top-offset";
import { resolveMacroUrl } from "./lib/macro-gating";
import { CANVAS_MIN, RAIL_MIN, usePaneWidths } from "./lib/use-pane-widths";
import { useHarnessState } from "./lib/use-harness-state";
import { useRunPolling } from "./lib/use-run-polling";

type RightTab = "canvas" | "skills";

export const App = (): JSX.Element => {
  const harness = useHarnessState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  // Lifted so the telemetry chip in BrandHeader can open the settings popover
  // from outside SessionBar (which owns the popover's render).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedRowEl, setSelectedRowEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [stripColEl, setStripColEl] = useState<HTMLDivElement | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("canvas");
  // Tracks whether Skills has ever been shown — once true, SkillsPanel stays
  // mounted (hidden via CSS) so re-opening never triggers a refetch.
  const [skillsPanelEverShown, setSkillsPanelEverShown] = useState(false);
  const rowAnchor = useElementTopOffset(selectedRowEl, stripColEl);

  // Stable function references for SkillsPanel props — prevents the panel's
  // effects from refiring on every unrelated App re-render (e.g. tab switches,
  // session state updates) since `api.listSkills.bind(api)` produces a new
  // function object on each render. Must be before any early return (React
  // hooks must be called unconditionally).
  const listSkills = useMemo(
    () => harness.api.listSkills.bind(harness.api),
    [harness.api],
  );
  const getSkill = useMemo(
    () => harness.api.getSkill.bind(harness.api),
    [harness.api],
  );
  const { widths, startRailDrag, startCanvasDrag, resetRail, resetCanvas } =
    usePaneWidths();

  // Live run polling — tracks deployed run state per executionId.
  const runViews = useRunPolling(harness.lastMessage);

  // Map: sessionId → latest executionId seen for that session. Updated when
  // an execution.started bus message arrives with target "prod".
  const sessionExecRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const msg = harness.lastMessage;
    if (msg?.type === "execution.started" && msg.target === "prod") {
      sessionExecRef.current.set(msg.harnessSessionId, msg.executionId);
    }
  }, [harness.lastMessage]);

  // The ref above is written in an effect, which runs AFTER the render that
  // processed the execution.started message — so on that first render
  // activeExecId is still undefined and the panel stays hidden until the first
  // poll resolves (which is what we want: no empty panel before there's data).
  // This recomputes on every `runViews` update (React state) as polls land.
  const activeExecId = harness.activeSessionId
    ? sessionExecRef.current.get(harness.activeSessionId)
    : undefined;
  const activeRunView = activeExecId ? runViews.get(activeExecId) : undefined;

  // Cmd+K (any platform) or Cmd/Ctrl+P — "jump to" like Cmd+P in Cursor/VS Code.
  // preventDefault so it doesn't fall through to the browser's print/search dialogs.
  // Cmd/Ctrl+1..9 switches directly to that tab — same ordering SessionBar
  // renders its tabs in (oldest live session first), so "3" always means the
  // third tab from the left, not an arbitrary session.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "p")) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const tabs = harness.state?.sessions
          .filter((session) => session.status !== "exited")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const target = tabs?.[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          harness.setActiveSessionId(target.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness.state?.sessions]);

  if (harness.loading) {
    return <div className="app-status">Loading Sapiom Harness…</div>;
  }
  if (harness.error || !harness.state) {
    return (
      <div className="app-status app-status-error">
        Failed to load: {harness.error}
      </div>
    );
  }

  const { state } = harness;
  const activeSession =
    state.sessions.find((session) => session.id === harness.activeSessionId) ??
    null;
  const boundWorkflowPath = boundWorkflowPathOf(activeSession);
  const boundWorkflow =
    state.workflows.find((w) => w.path === boundWorkflowPath) ?? null;
  const selectedWorkflow =
    state.workflows.find((w) => w.path === harness.selectedWorkflowPath) ??
    null;

  // First-run welcome: this install has never been used (firstRun — the CLI
  // also skips the auto boot session then) and nothing is live yet. Taking
  // either welcome action creates a session, which hides it; a returning
  // user (firstRun absent/false) never sees it at all.
  const hasLiveSession = state.sessions.some(
    (session) => session.status !== "exited",
  );
  const showWelcome =
    state.firstRun === true && !hasLiveSession && !welcomeDismissed;

  const handleCreateSession = async (
    cwd: string,
    agentHarness: HarnessKind,
  ): Promise<void> => {
    await harness.createSession({ cwd, harness: agentHarness });
  };

  const handleSelectWorkflow = (path: string): void => {
    harness.setSelectedWorkflowPath(path);
    // Selecting a workflow IS "what I'm working on" — bind it to whichever
    // session is currently active so the chip and the agent's context stay in sync.
    if (harness.activeSessionId)
      void harness.bindWorkflow(harness.activeSessionId, path);
  };

  // Shared by the docked workflow action strip, the canvas empty-state's
  // Visualize CTA, and anything else that fires a macro. Running a macro
  // against a workflow also (re-)binds it, so acting on a workflow that isn't
  // the current binding switches "what I'm working on" too. `workflow` is
  // nullable for macros that don't require one when nothing's bound yet.
  // Every macro is one click — there's no subject/free-text step on this
  // side; the agent is the interface for anything more specific.
  const handleRunMacroForWorkflow = (
    workflow: WorkflowInfo | null,
    macro: MacroDef,
  ): void => {
    if (workflow) handleSelectWorkflow(workflow.path);
    if (macro.action.kind === "open-url") {
      window.open(
        resolveMacroUrl(macro.action.url, workflow),
        "_blank",
        "noopener,noreferrer",
      );
      return;
    }
    if (!harness.activeSessionId) return;
    void harness.runMacro(macro.id, {
      harnessSessionId: harness.activeSessionId,
      workflowPath: workflow?.path,
    });
  };

  return (
    <div className="app-shell">
      <BrandHeader
        authenticated={state.authenticated}
        organizationName={state.organizationName}
        onOpenPalette={() => setPaletteOpen(true)}
        telemetryOptIn={
          harness.settings?.telemetryOptIn ?? state.telemetryOptIn
        }
        consentSource={state.consentSource}
        consentEnvReason={state.consentEnvReason}
        onOpenSettings={() => setSettingsOpen(true)}
      />

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
        className="app"
        style={{
          // minmax (not a bare px) on the rail/canvas tracks too — a laptop-
          // width browser with generously dragged panes was overflowing off
          // the right edge and getting silently clipped by .app's overflow;
          // letting these shrink to their own floors under space pressure
          // (with a horizontal scrollbar as the last resort — see .app in
          // styles.css) keeps the canvas header from vanishing off-screen.
          gridTemplateColumns: `minmax(${RAIL_MIN}px, ${widths.rail}px) 32px minmax(360px, 1fr) minmax(${CANVAS_MIN}px, ${widths.canvas}px)`,
        }}
      >
        <WorkflowsRail
          workflows={state.workflows}
          sessions={state.sessions}
          activeSessionId={harness.activeSessionId}
          selectedPath={harness.selectedWorkflowPath}
          onSelect={handleSelectWorkflow}
          onSelectedRowElement={setSelectedRowEl}
          onConnect={async (path) => {
            await harness.connectWorkflow(path);
          }}
        />

        <div className="workflow-action-strip-col" ref={setStripColEl}>
          {selectedWorkflow && rowAnchor && (
            <WorkflowActionStrip
              workflow={selectedWorkflow}
              top={rowAnchor.top}
              height={rowAnchor.height}
              activeSessionId={harness.activeSessionId}
              macros={state.macros}
              onRunMacro={(macro) =>
                handleRunMacroForWorkflow(selectedWorkflow, macro)
              }
            />
          )}
        </div>

        <div
          className="pane-resize-handle pane-resize-handle-rail"
          style={{ left: widths.rail + 32 }}
          onPointerDown={startRailDrag}
          onDoubleClick={resetRail}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace rail"
          data-testid="resize-handle-rail"
        />

        <div className="center-pane">
          <SessionBar
            sessions={state.sessions}
            activeSessionId={harness.activeSessionId}
            onSelectSession={harness.setActiveSessionId}
            onResumeHistory={(summary) =>
              void harness.resumeFromHistory(summary)
            }
            history={harness.history}
            historyLoading={harness.historyLoading}
            onOpenHistory={(cwd) => void harness.loadHistory(cwd)}
            recentDirs={harness.settings?.recentDirs ?? []}
            launchDir={state.launchDir ?? null}
            listDir={harness.listDir}
            onCreateSession={handleCreateSession}
            boundWorkflowName={boundWorkflow?.name ?? null}
            authenticated={state.authenticated}
            organizationName={state.organizationName}
            telemetryOptIn={
              harness.settings?.telemetryOptIn ?? state.telemetryOptIn
            }
            onToggleTelemetry={async (next) => {
              await harness.updateSettings({ telemetryOptIn: next });
            }}
            busySessionIds={harness.busySessionIds}
            settingsOpen={settingsOpen}
            onSetSettingsOpen={setSettingsOpen}
          />
          <div className="terminal-slot">
            {activeSession?.status === "exited" ? (
              <DeadSessionPane
                session={activeSession}
                onResume={() => void harness.resumeSession(activeSession.id)}
                onClose={() => void harness.closeSession(activeSession.id)}
              />
            ) : harness.activeSessionId ? (
              <Terminal
                sessionId={harness.activeSessionId}
                token={harness.bootToken}
              />
            ) : showWelcome ? (
              <WelcomePanel
                recentDirs={harness.settings?.recentDirs ?? []}
                launchDir={state.launchDir ?? null}
                listDir={harness.listDir}
                onCreateSession={handleCreateSession}
                onRunSample={async () => {
                  await harness.createSampleSession();
                }}
                onDismiss={() => setWelcomeDismissed(true)}
              />
            ) : (
              <div className="terminal-empty">
                No active session — click "+ new" to start one.
              </div>
            )}
          </div>
        </div>

        <div
          className="pane-resize-handle pane-resize-handle-canvas"
          style={{ right: widths.canvas }}
          onPointerDown={startCanvasDrag}
          onDoubleClick={resetCanvas}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize canvas pane"
          data-testid="resize-handle-canvas"
        />

        {/* Right pane: Canvas | Skills segmented switch + panels */}
        <div className="right-pane">
          <div
            className="right-pane-tabs"
            role="tablist"
            aria-label="Right pane"
          >
            <button
              role="tab"
              aria-selected={rightTab === "canvas"}
              className={
                "right-pane-tab" + (rightTab === "canvas" ? " is-active" : "")
              }
              onClick={() => setRightTab("canvas")}
              data-testid="right-tab-canvas"
            >
              Canvas
            </button>
            <button
              role="tab"
              aria-selected={rightTab === "skills"}
              className={
                "right-pane-tab" + (rightTab === "skills" ? " is-active" : "")
              }
              onClick={() => {
                setRightTab("skills");
                setSkillsPanelEverShown(true);
              }}
              data-testid="right-tab-skills"
            >
              Skills
            </button>
          </div>

          {/* Canvas: always mounted so a running Visualize enrichment is never
              disturbed when the user flips to Skills — hidden via CSS only. */}
          <div
            className={
              "right-pane-panel" + (rightTab === "canvas" ? "" : " is-hidden")
            }
            data-testid="right-panel-canvas"
          >
            <CanvasPane
              sessionId={harness.activeSessionId}
              lastMessage={harness.lastMessage}
              boundWorkflow={boundWorkflow}
              activeSessionId={harness.activeSessionId}
              macros={state.macros}
              tasks={harness.tasks}
              onRunMacro={(macro) =>
                handleRunMacroForWorkflow(boundWorkflow, macro)
              }
              runView={activeRunView}
            />
          </div>

          {/* Skills: lazy-mount on first open, then kept alive hidden via CSS.
              isActive flips to true on each tab activation, which triggers a
              fresh skills list fetch — newly created skills appear without a
              page reload. The component instance is preserved so detail view
              state and scroll position survive tab flips. */}
          {(rightTab === "skills" || skillsPanelEverShown) && (
            <div
              className={
                "right-pane-panel" + (rightTab === "skills" ? "" : " is-hidden")
              }
              data-testid="right-panel-skills"
            >
              <SkillsPanel
                listSkills={listSkills}
                getSkill={getSkill}
                isActive={rightTab === "skills"}
                activeSession={activeSession}
                onUseSkill={(sessionId, text) =>
                  void harness.useSkill(sessionId, text)
                }
              />
            </div>
          )}
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          sessions={state.sessions}
          workflows={state.workflows}
          recentDirs={harness.settings?.recentDirs ?? []}
          listDir={harness.listDir}
          onSelectSession={harness.setActiveSessionId}
          onOpenPath={(cwd) => void handleCreateSession(cwd, "claude-code")}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {harness.toast && (
        <Toast message={harness.toast} onDismiss={harness.dismissToast} />
      )}
    </div>
  );
};
