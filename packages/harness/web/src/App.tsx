/**
 * Harness SPA shell (workstream W2).
 *
 * Layout: workflows rail (left) | docked action strip (anchored to the
 * selected workflow's row) | session dropdown + terminal (center) |
 * canvas/preview pane (right). The strip carries the selected workflow's
 * full action set; the canvas gets a slim identity header for whichever
 * workflow is bound to the active session.
 */
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { HarnessKind, MacroDef, WorkflowInfo } from "@shared/types";

import { BrandHeader } from "./components/BrandHeader";
import { CanvasPane } from "./components/CanvasPane";
import { CommandPalette } from "./components/CommandPalette";
import { DeadSessionPane } from "./components/DeadSessionPane";
import { SessionBar } from "./components/SessionBar";
import { Terminal } from "./components/Terminal";
import { WorkflowActionStrip } from "./components/WorkflowActionStrip";
import { WorkflowsRail } from "./components/WorkflowsRail";
import { boundWorkflowPathOf } from "./lib/api";
import { useElementTopOffset } from "./lib/use-element-top-offset";
import { resolveMacroUrl } from "./lib/macro-gating";
import { usePaneWidths } from "./lib/use-pane-widths";
import { useHarnessState } from "./lib/use-harness-state";

export const App = (): JSX.Element => {
  const harness = useHarnessState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedRowEl, setSelectedRowEl] = useState<HTMLDivElement | null>(null);
  const [stripColEl, setStripColEl] = useState<HTMLDivElement | null>(null);
  const rowAnchor = useElementTopOffset(selectedRowEl, stripColEl);
  const { widths, startRailDrag, startCanvasDrag, resetRail, resetCanvas } = usePaneWidths();

  // Cmd+K (any platform) or Cmd/Ctrl+P — "jump to" like Cmd+P in Cursor/VS Code.
  // preventDefault so it doesn't fall through to the browser's print/search dialogs.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "p")) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (harness.loading) {
    return <div className="app-status">Loading Sapiom Harness…</div>;
  }
  if (harness.error || !harness.state) {
    return <div className="app-status app-status-error">Failed to load: {harness.error}</div>;
  }

  const { state } = harness;
  const activeSession = state.sessions.find((session) => session.id === harness.activeSessionId) ?? null;
  const boundWorkflowPath = boundWorkflowPathOf(activeSession);
  const boundWorkflow = state.workflows.find((w) => w.path === boundWorkflowPath) ?? null;
  const selectedWorkflow = state.workflows.find((w) => w.path === harness.selectedWorkflowPath) ?? null;

  const handleCreateSession = async (cwd: string, agentHarness: HarnessKind): Promise<void> => {
    await harness.createSession({ cwd, harness: agentHarness });
  };

  const handleSelectWorkflow = (path: string): void => {
    harness.setSelectedWorkflowPath(path);
    // Selecting a workflow IS "what I'm working on" — bind it to whichever
    // session is currently active so the chip and the agent's context stay in sync.
    if (harness.activeSessionId) void harness.bindWorkflow(harness.activeSessionId, path);
  };

  // Shared by the docked workflow action strip, the canvas empty-state's
  // Visualize CTA, and anything else that fires a macro. Running a macro
  // against a workflow also (re-)binds it, so acting on a workflow that isn't
  // the current binding switches "what I'm working on" too. `workflow` is
  // nullable for macros that don't require one when nothing's bound yet.
  // Every macro is one click — there's no subject/free-text step on this
  // side; the agent is the interface for anything more specific.
  const handleRunMacroForWorkflow = (workflow: WorkflowInfo | null, macro: MacroDef): void => {
    if (workflow) handleSelectWorkflow(workflow.path);
    if (macro.action.kind === "open-url") {
      window.open(resolveMacroUrl(macro.action.url, workflow), "_blank", "noopener,noreferrer");
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
      />

      <div
        className="app"
        style={{ gridTemplateColumns: `${widths.rail}px 32px minmax(360px, 1fr) ${widths.canvas}px` }}
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
              onRunMacro={(macro) => handleRunMacroForWorkflow(selectedWorkflow, macro)}
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
            onResumeHistory={(summary) => void harness.resumeFromHistory(summary)}
            history={harness.history}
            historyLoading={harness.historyLoading}
            onOpenDropdown={(cwd) => void harness.loadHistory(cwd)}
            recentDirs={harness.settings?.recentDirs ?? []}
            launchDir={state.launchDir ?? null}
            listDir={harness.listDir}
            onCreateSession={handleCreateSession}
            boundWorkflowName={boundWorkflow?.name ?? null}
            authenticated={state.authenticated}
            organizationName={state.organizationName}
            telemetryOptIn={harness.settings?.telemetryOptIn ?? state.telemetryOptIn}
            onToggleTelemetry={async (next) => {
              await harness.updateSettings({ telemetryOptIn: next });
            }}
          />
          <div className="terminal-slot">
            {activeSession?.status === "exited" ? (
              <DeadSessionPane
                session={activeSession}
                onResume={() => void harness.resumeSession(activeSession.id)}
                onClose={() => void harness.closeSession(activeSession.id)}
              />
            ) : harness.activeSessionId ? (
              <Terminal sessionId={harness.activeSessionId} token={harness.bootToken} />
            ) : (
              <div className="terminal-empty">No active session — click “+ new” to start one.</div>
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

        <CanvasPane
          sessionId={harness.activeSessionId}
          lastMessage={harness.lastMessage}
          boundWorkflow={boundWorkflow}
          activeSessionId={harness.activeSessionId}
          macros={state.macros}
          onRunMacro={(macro) => handleRunMacroForWorkflow(boundWorkflow, macro)}
        />
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
    </div>
  );
};
