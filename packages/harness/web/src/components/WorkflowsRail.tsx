import { useState } from "react";
import type { JSX } from "react";
import type { HarnessSession, MacroDef, WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { MacroButtons } from "./MacroButtons";
import { needsSubject } from "../lib/macro-gating";
import { buildWorkspaceTree } from "../lib/workspace-tree";

interface WorkflowsRailProps {
  workflows: WorkflowInfo[];
  sessions: HarnessSession[];
  activeSessionId: string | null;
  selectedPath: string | null;
  macros: MacroDef[];
  onSelect: (path: string) => void;
  onRunMacro: (workflow: WorkflowInfo, macro: MacroDef, subject?: string) => void;
  onConnect: (path: string) => Promise<void>;
}

function WorkflowRow({
  workflow,
  isSelected,
  activeSessionId,
  rowMacros,
  onSelect,
  onRunMacro,
}: {
  workflow: WorkflowInfo;
  isSelected: boolean;
  activeSessionId: string | null;
  rowMacros: MacroDef[];
  onSelect: (path: string) => void;
  onRunMacro: (workflow: WorkflowInfo, macro: MacroDef, subject?: string) => void;
}): JSX.Element {
  return (
    <div className={"workflow-item" + (isSelected ? " is-selected" : "")} data-testid={`workflow-${workflow.name}`}>
      <button className="workflow-item-trigger" onClick={() => onSelect(workflow.path)} title={workflow.path}>
        <span className="workflow-caret">▸</span>
        <span className="workflow-name">{workflow.name}</span>
        {workflow.definitionId != null && <span className="workflow-dot" title="Deployed" />}
      </button>
      <div className="workflow-row-actions">
        <MacroButtons
          macros={rowMacros}
          workflow={workflow}
          activeSessionId={activeSessionId}
          onRun={(macro, subject) => onRunMacro(workflow, macro, subject)}
          size={13}
          testIdPrefix={`${workflow.name}-`}
        />
      </div>
    </div>
  );
}

export function WorkflowsRail({
  workflows,
  sessions,
  activeSessionId,
  selectedPath,
  macros,
  onSelect,
  onRunMacro,
  onConnect,
}: WorkflowsRailProps): JSX.Element {
  const [connecting, setConnecting] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitConnect = async (): Promise<void> => {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onConnect(trimmed);
      setPathInput("");
      setConnecting(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Row actions are compact quick-actions, not the full macro set — anything
  // needing a subject (Visualize) stays reserved for the bound-workflow header.
  const rowMacros = macros.filter((macro) => !needsSubject(macro));

  const { groups, ungrouped } = buildWorkspaceTree(workflows, sessions, activeSessionId);

  const renderRow = (workflow: WorkflowInfo): JSX.Element => (
    <WorkflowRow
      key={workflow.path}
      workflow={workflow}
      isSelected={workflow.path === selectedPath}
      activeSessionId={activeSessionId}
      rowMacros={rowMacros}
      onSelect={onSelect}
      onRunMacro={onRunMacro}
    />
  );

  return (
    <aside className="rail rail-workflows">
      <div className="rail-header">Workspace</div>
      <div className="rail-list">
        {groups.length === 0 && ungrouped.length === 0 && <div className="rail-empty">No workflows yet</div>}

        {groups.map((group) => (
          <div key={group.cwd} className={"workspace-group" + (group.isActive ? " is-active" : "")}>
            <div className="workspace-group-header" data-testid={`workspace-group-${group.label}`}>
              <Icon name={group.isActive ? "Radio" : "Folder"} size={11} />
              {group.label}
            </div>
            {group.workflows.length === 0 && <div className="workspace-group-empty">No workflows here yet</div>}
            {group.workflows.map(renderRow)}
          </div>
        ))}

        {ungrouped.length > 0 && (
          <div className="workspace-group">
            <div className="workspace-group-header">Other</div>
            {ungrouped.map(renderRow)}
          </div>
        )}
      </div>

      {connecting ? (
        <div className="connect-form">
          <input
            autoFocus
            className="connect-input"
            placeholder="/path/to/project"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitConnect();
              if (e.key === "Escape") setConnecting(false);
            }}
          />
          {error && <div className="connect-error">{error}</div>}
          <div className="connect-actions">
            <button className="btn-ghost" onClick={() => setConnecting(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => void submitConnect()} disabled={busy || !pathInput.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      ) : (
        <button className="connect-trigger" onClick={() => setConnecting(true)}>
          + Connect
        </button>
      )}
    </aside>
  );
}
