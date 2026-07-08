import { useState } from "react";
import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

interface WorkflowsRailProps {
  workflows: WorkflowInfo[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onConnect: (path: string) => Promise<void>;
}

export function WorkflowsRail({ workflows, selectedPath, onSelect, onConnect }: WorkflowsRailProps): JSX.Element {
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

  return (
    <aside className="rail rail-workflows">
      <div className="rail-header">Workflows</div>
      <div className="rail-list">
        {workflows.length === 0 && <div className="rail-empty">No workflows yet</div>}
        {workflows.map((workflow) => (
          <button
            key={workflow.path}
            className={"workflow-item" + (workflow.path === selectedPath ? " is-selected" : "")}
            data-testid={`workflow-${workflow.name}`}
            onClick={() => onSelect(workflow.path)}
            title={workflow.path}
          >
            <span className="workflow-caret">▸</span>
            <span className="workflow-name">{workflow.name}</span>
            {workflow.definitionId != null && <span className="workflow-dot" title="Deployed" />}
          </button>
        ))}
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
