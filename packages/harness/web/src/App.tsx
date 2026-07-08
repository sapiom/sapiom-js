/**
 * Harness SPA shell (workstream W2).
 *
 * Layout: workflows rail (left) | session dropdown + terminal (center)
 * | canvas/preview pane (right) | action icon rail (far right).
 */
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { HarnessKind, MacroDef } from "@shared/types";

import { ActionRail } from "./components/ActionRail";
import { BrandHeader } from "./components/BrandHeader";
import { CanvasPane } from "./components/CanvasPane";
import { CommandPalette } from "./components/CommandPalette";
import { DeadSessionPane } from "./components/DeadSessionPane";
import { SessionBar } from "./components/SessionBar";
import { Terminal } from "./components/Terminal";
import { WorkflowsRail } from "./components/WorkflowsRail";
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
  const selectedWorkflow = state.workflows.find((w) => w.path === harness.selectedWorkflowPath) ?? null;
  const activeSession = state.sessions.find((session) => session.id === harness.activeSessionId) ?? null;

  const handleCreateSession = async (cwd: string, agentHarness: HarnessKind): Promise<void> => {
    await harness.createSession({ cwd, harness: agentHarness });
  };

  const disabledReasonFor = (macro: MacroDef): string | null => {
    if (macro.requiresWorkflow) {
      if (!selectedWorkflow) return "Select a workflow first";
      if (macro.action.kind === "open-url" && macro.action.url.includes("{{workflow.definitionId}}") &&
        selectedWorkflow.definitionId == null) {
        return "Not deployed yet";
      }
    }
    if (macro.action.kind === "inject" && !harness.activeSessionId) return "Start a session first";
    return null;
  };

  const handleRunMacro = (macro: MacroDef, subject?: string): void => {
    if (macro.action.kind === "open-url") {
      const url = macro.action.url.replace(
        "{{workflow.definitionId}}",
        String(selectedWorkflow?.definitionId ?? ""),
      );
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!harness.activeSessionId) return;
    void harness.runMacro(macro.id, {
      harnessSessionId: harness.activeSessionId,
      workflowPath: harness.selectedWorkflowPath ?? undefined,
      subject,
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
          selectedPath={harness.selectedWorkflowPath}
          onSelect={harness.setSelectedWorkflowPath}
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

        <CanvasPane sessionId={harness.activeSessionId} lastMessage={harness.lastMessage} />

        <ActionRail macros={state.macros} disabledReasonFor={disabledReasonFor} onRun={handleRunMacro} />
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
