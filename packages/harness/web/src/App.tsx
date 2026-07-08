/**
 * Harness SPA shell (workstream W2).
 *
 * Layout: workflows rail (left) | session dropdown + terminal (center)
 * | canvas/preview pane (right). Actions live on their workflow: inline
 * row icons in the rail, and a header strip above the canvas for whichever
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
import { WorkflowsRail } from "./components/WorkflowsRail";
import { boundWorkflowPathOf } from "./lib/api";
import { resolveMacroUrl } from "./lib/macro-gating";
import { useHarnessState } from "./lib/use-harness-state";

export const App = (): JSX.Element => {
  const harness = useHarnessState();
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  const handleCreateSession = async (cwd: string, agentHarness: HarnessKind): Promise<void> => {
    await harness.createSession({ cwd, harness: agentHarness });
  };

  const handleSelectWorkflow = (path: string): void => {
    harness.setSelectedWorkflowPath(path);
    // Selecting a workflow IS "what I'm working on" — bind it to whichever
    // session is currently active so the chip and the agent's context stay in sync.
    if (harness.activeSessionId) void harness.bindWorkflow(harness.activeSessionId, path);
  };

  // Shared by workflow-row hover actions, the bound-workflow header above the
  // canvas, and the canvas empty-state's Visualize CTA. Running a macro against
  // a workflow also (re-)binds it, so acting on a row that isn't the current
  // binding switches "what I'm working on" too. `workflow` is nullable for
  // macros that don't require one (Visualize) when nothing's bound yet. Every
  // macro is one click — there's no subject/free-text step on this side; the
  // agent is the interface for anything more specific.
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

      <div className="app">
        <WorkflowsRail
          workflows={state.workflows}
          sessions={state.sessions}
          activeSessionId={harness.activeSessionId}
          selectedPath={harness.selectedWorkflowPath}
          macros={state.macros}
          onSelect={handleSelectWorkflow}
          onRunMacro={handleRunMacroForWorkflow}
          onConnect={async (path) => {
            await harness.connectWorkflow(path);
          }}
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
