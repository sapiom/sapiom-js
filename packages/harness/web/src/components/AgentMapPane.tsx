import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { AgentMapWorkspaceResponse, PlanNodeId } from "@shared/agent-map";
import type { PlanningFanoutPreview } from "@shared/build-plan";

import type { AgentMapWorkspacePaneState } from "../lib/use-agent-map-entry";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { EmptyState } from "./EmptyState";
import { AgentMapCanvas } from "./AgentMapCanvas";
import { AgentMapInspector } from "./AgentMapInspector";
import { Icon } from "./Icon";

interface AgentMapPaneProps {
  state: AgentMapWorkspacePaneState;
  focusedNodeId?: PlanNodeId | null;
  planningFanout?: PlanningFanoutPreview | null;
  planningFanoutPending?: boolean;
  onOpenPlanningFanout?: () => void;
  onRetry: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

/** The honest E1 map: durable state around the existing neutral canvas empty. */
export function AgentMapPane({
  state,
  focusedNodeId = null,
  planningFanout = null,
  planningFanoutPending = false,
  onOpenPlanningFanout,
  onRetry,
  expanded,
  onToggleExpanded,
}: AgentMapPaneProps): JSX.Element {
  const value = state.status === "ready" ? state.value : null;
  const proposal = value?.proposal ?? null;
  const [selected, setSelected] = useState<PlanNodeId | null>(null);
  const mapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (
      focusedNodeId &&
      proposal?.nodes.some((node) => node.id === focusedNodeId)
    )
      setSelected(focusedNodeId);
  }, [focusedNodeId, proposal]);

  useEffect(() => {
    if (
      selected &&
      (!proposal || !proposal.nodes.some((node) => node.id === selected))
    ) {
      setSelected(null);
    }
  }, [proposal, selected]);

  const closeInspector = useCallback((): void => {
    const selectedNode = mapRef.current?.querySelector<HTMLButtonElement>(
      ".agent-map-node.is-selected",
    );
    setSelected(null);
    selectedNode?.focus();
  }, []);

  // Match the per-agent graph's full-view contract: Escape unwinds one layer
  // at a time, closing node detail before it lowers the map overlay.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (selected !== null) closeInspector();
      else if (expanded) onToggleExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeInspector, expanded, onToggleExpanded, selected]);

  let content: JSX.Element;
  if (state.status === "error") {
    content = (
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
  } else if (value === null) {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-loading"
        icon="Workflow"
        title="Loading Agent Map…"
      />
    );
  } else if (proposal && proposal.nodes.length > 0) {
    content = (
      <PopulatedAgentMap
        value={value}
        selected={selected}
        onSelectNode={setSelected}
        onCloseInspector={closeInspector}
        planningFanout={planningFanout}
        planningFanoutPending={planningFanoutPending}
        onOpenPlanningFanout={onOpenPlanningFanout}
      />
    );
  } else {
    content = (
      <EmptyState
        className="canvas-empty"
        testId="agent-map-empty"
        icon="Workflow"
        title="Nothing generated yet"
      />
    );
  }

  return (
    <div
      ref={mapRef}
      className={`canvas-frame-wrap${expanded ? " is-expanded" : ""}`}
      data-testid="agent-map-frame"
    >
      {content}
      {expanded && (
        <button
          type="button"
          className="macro-icon-btn canvas-expand-exit"
          data-testid="canvas-expand-exit"
          aria-label="Exit expanded Agent Map"
          title="Exit expanded Agent Map (Esc)"
          onClick={onToggleExpanded}
        >
          <Icon name="Minimize2" size={14} />
        </button>
      )}
    </div>
  );
}

function PopulatedAgentMap({
  value,
  selected,
  onSelectNode,
  onCloseInspector,
  planningFanout,
  planningFanoutPending,
  onOpenPlanningFanout,
}: {
  value: AgentMapWorkspaceResponse;
  selected: PlanNodeId | null;
  onSelectNode: (nodeId: PlanNodeId) => void;
  onCloseInspector: () => void;
  planningFanout: PlanningFanoutPreview | null;
  planningFanoutPending: boolean;
  onOpenPlanningFanout?: () => void;
}): JSX.Element {
  const proposal = value.proposal!;
  const exactFanoutLabel = planningFanout?.available
    ? `Plan ${planningFanout.plan.planId} version ${planningFanout.plan.version} digest ${planningFanout.plan.semanticDigest}; source ${
        planningFanout.source.kind === "proposal"
          ? `${planningFanout.source.proposalId} version ${planningFanout.source.version}`
          : `${planningFanout.source.revisionId} revision ${planningFanout.source.revisionNumber}`
      } digest ${planningFanout.source.graphDigest}; ${planningFanout.assignmentCount} assignments; ${planningFanout.expectedSessionCount} sessions; ${planningFanout.expectedModelTurnCount} model turns`
    : null;
  return (
    <div
      className="agent-map-live"
      data-testid="agent-map-live"
      data-project-id={value.project.projectId}
      {...trackingAttrs({ surface: "agent_map" })}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !selected) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseInspector();
      }}
    >
      <div className="agent-map-live-header">
        <span className="status-tag">Proposed</span>
        <span className="system-graph-node-meta">
          Version {proposal.version}
        </span>
      </div>
      {planningFanout?.available && onOpenPlanningFanout && (
        <div
          className="agent-map-live-header"
          data-testid="planning-fanout-consent"
        >
          <span
            className="system-graph-node-meta"
            aria-label={exactFanoutLabel ?? undefined}
            title={exactFanoutLabel ?? undefined}
          >
            Plan {planningFanout.plan.planId} v{planningFanout.plan.version} (
            {planningFanout.plan.semanticDigest.slice(0, 15)}…) · Source{" "}
            {planningFanout.source.kind === "proposal"
              ? `${planningFanout.source.proposalId} v${planningFanout.source.version}`
              : `${planningFanout.source.revisionId} r${planningFanout.source.revisionNumber}`}{" "}
            ({planningFanout.source.graphDigest.slice(0, 15)}…) ·{" "}
            {planningFanout.assignmentCount} assignments ·{" "}
            {planningFanout.expectedSessionCount} sessions ·{" "}
            {planningFanout.expectedModelTurnCount} model turns
          </span>
          {planningFanout.warnings.length > 0 && (
            <span className="system-graph-node-meta">
              Warnings: {planningFanout.warnings.join(", ")}
            </span>
          )}
          <button
            type="button"
            className="btn-primary"
            data-testid="open-planning-sessions"
            disabled={planningFanoutPending}
            onClick={onOpenPlanningFanout}
          >
            {planningFanoutPending ? "Opening…" : "Open planning sessions"}
          </button>
        </div>
      )}
      <div className="agent-map-live-body">
        <AgentMapCanvas
          proposal={proposal}
          selectedNodeId={selected}
          onSelectNode={onSelectNode}
        />
        {selected && (
          <AgentMapInspector
            snapshot={value}
            nodeId={selected}
            onClose={onCloseInspector}
          />
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {selected
          ? `Selected ${proposal.nodes.find((node) => node.id === selected)?.name ?? "node"}`
          : ""}
      </p>
    </div>
  );
}
