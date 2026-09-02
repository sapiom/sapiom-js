import type { JSX } from "react";

import type { AgentMapWorkspacePaneState } from "../lib/use-agent-map-entry";
import { EmptyState } from "./EmptyState";

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
  return (
    <EmptyState
      className="canvas-empty"
      testId="agent-map-empty"
      icon="Workflow"
      title="Nothing generated yet"
    />
  );
}
