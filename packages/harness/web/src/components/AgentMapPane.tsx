import { useEffect, useState, type JSX } from "react";
import type { AgentMapWorkspaceResponse, PlanNodeId } from "@shared/agent-map";

import type { AgentMapWorkspacePaneState } from "../lib/use-agent-map-entry";
import { EmptyState } from "./EmptyState";
import { AgentMapCanvas } from "./AgentMapCanvas";
import { AgentMapInspector } from "./AgentMapInspector";

interface AgentMapPaneProps {
  state: AgentMapWorkspacePaneState;
  onRetry: () => void;
}

/** The honest E1 map: durable state around the existing neutral canvas empty. */
export function AgentMapPane({
  state,
  onRetry,
}: AgentMapPaneProps): JSX.Element {
  if (state.status === "error") {
    return (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-load-error"
        icon="TriangleAlert"
        title="Agent Map couldn't load"
        body={state.message}
        cta={
          <button
            type="button"
            className="btn-secondary"
            data-testid="agent-map-retry"
            onClick={onRetry}
          >
            Retry map
          </button>
        }
      />
    );
  }
  if (state.status !== "ready") {
    return (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-loading"
        icon="Workflow"
        title="Loading Agent Map…"
      />
    );
  }
  const proposal = state.value.proposal;
  if (proposal && proposal.nodes.length > 0) {
    return <PopulatedAgentMap value={state.value} />;
  }
  return (
    <EmptyState
      className="canvas-empty"
      testId="agent-map-empty"
      icon="Workflow"
      title="Nothing generated yet"
    />
  );
}

function PopulatedAgentMap({
  value,
}: {
  value: AgentMapWorkspaceResponse;
}): JSX.Element {
  const proposal = value.proposal!;
  const [selected, setSelected] = useState<PlanNodeId | null>(null);
  useEffect(() => {
    if (selected && !proposal.nodes.some((node) => node.id === selected)) {
      setSelected(null);
    }
  }, [proposal.nodes, selected]);
  return (
    <div
      className="agent-map-live"
      data-testid="agent-map-live"
      data-project-id={value.project.projectId}
    >
      <div className="agent-map-live-header">
        <span className="status-tag">Proposed</span>
        <span className="system-graph-node-meta">
          Version {proposal.version}
        </span>
      </div>
      <div className="agent-map-live-body">
        <AgentMapCanvas
          proposal={proposal}
          selectedNodeId={selected}
          onSelectNode={setSelected}
        />
        {selected && <AgentMapInspector snapshot={value} nodeId={selected} />}
      </div>
      <p className="sr-only" aria-live="polite">
        {selected
          ? `Selected ${proposal.nodes.find((node) => node.id === selected)?.name ?? "node"}`
          : ""}
      </p>
    </div>
  );
}
