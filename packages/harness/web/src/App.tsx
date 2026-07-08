/**
 * Harness SPA shell (workstream W2).
 *
 * Layout: workflows rail (left) | session dropdown + terminal (center)
 * | canvas/preview pane (right) | action icon rail (far right).
 */
import type { JSX } from "react";
import type { HarnessKind, MacroDef } from "@shared/types";

import { ActionRail } from "./components/ActionRail";
import { BrandHeader } from "./components/BrandHeader";
import { CanvasPane } from "./components/CanvasPane";
import { SessionBar } from "./components/SessionBar";
import { Terminal } from "./components/Terminal";
import { WorkflowsRail } from "./components/WorkflowsRail";
import { useHarnessState } from "./lib/use-harness-state";

export const App = (): JSX.Element => {
  const harness = useHarnessState();

  if (harness.loading) {
    return <div className="app-status">Loading Sapiom Harness…</div>;
  }
  if (harness.error || !harness.state) {
    return <div className="app-status app-status-error">Failed to load: {harness.error}</div>;
  }

  const { state } = harness;
  const selectedWorkflow = state.workflows.find((w) => w.path === harness.selectedWorkflowPath) ?? null;

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
      <BrandHeader authenticated={state.authenticated} organizationName={state.organizationName} />

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
            {harness.activeSessionId ? (
              <Terminal sessionId={harness.activeSessionId} token={harness.bootToken} />
            ) : (
              <div className="terminal-empty">No active session — click “+ new” to start one.</div>
            )}
          </div>
        </div>

        <CanvasPane sessionId={harness.activeSessionId} lastMessage={harness.lastMessage} />

        <ActionRail macros={state.macros} disabledReasonFor={disabledReasonFor} onRun={handleRunMacro} />
      </div>
    </div>
  );
};
