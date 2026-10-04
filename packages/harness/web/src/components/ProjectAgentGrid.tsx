import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * The map's stand-in for a project with no Agent Map drawn yet: every agent in
 * the project as a card, so the one interaction the flow asks of the map
 * (click an agent, see it, start a chat) works on every project and not only
 * on the ones whose map has been generated (flow-navigation.md Q6, design.md
 * §3). The map's DRAWING is the separate rebuild track; this is not a layout,
 * it is a list that behaves like the map's nodes do.
 */
export function ProjectAgentGrid({
  agents,
  map,
  onRetryGeneration,
  selectedPath,
  onPick,
  panel,
}: {
  agents: readonly WorkflowInfo[];
  /** Where the project's map is: not drawn, being generated, or failed. */
  map: "not-drawn" | "generating" | "failed";
  /** Present when a failed generation may be retried. */
  onRetryGeneration: (() => void) | null;
  selectedPath: string | null;
  onPick: (agent: WorkflowInfo) => void;
  panel: JSX.Element | null;
}): JSX.Element {
  return (
    <div className="project-agent-grid-wrap">
      {map === "generating" ? (
        <p
          className="project-agent-grid-note"
          data-testid="project-agent-grid-note"
        >
          <span data-testid="agent-map-generating">Generating Agent Map…</span>{" "}
          Its agents are listed meanwhile. Click one to open it.
        </p>
      ) : map === "failed" ? (
        <div
          className="project-agent-grid-note"
          data-testid="project-agent-grid-note"
        >
          <span data-testid="agent-map-generation-error">
            The Agent Map couldn't be generated, so its agents are listed.
          </span>
          {onRetryGeneration && (
            <button
              type="button"
              className="btn-line"
              data-testid="agent-map-generation-retry"
              onClick={onRetryGeneration}
            >
              Retry generation
            </button>
          )}
        </div>
      ) : (
        <p
          className="project-agent-grid-note"
          data-testid="project-agent-grid-note"
        >
          No map is drawn for this project yet, so its agents are listed. Click
          one to open it.
        </p>
      )}
      <div
        className="project-agent-grid"
        data-testid="project-agent-grid"
        role="list"
      >
        {agents.map((agent) => (
          <div key={agent.path} role="listitem" className="project-agent-grid-item">
          <button
            type="button"
            className={
              "project-agent-card" +
              (agent.path === selectedPath ? " is-selected" : "")
            }
            data-testid={`map-agent-${agent.name}`}
            aria-pressed={agent.path === selectedPath}
            onClick={() => onPick(agent)}
            {...trackingAttrs({ object: "agent" })}
          >
            <span className="project-agent-card-name">{agent.name}</span>
            <span className="project-agent-card-path" title={agent.path}>
              {agent.path}
            </span>
            <span className="project-agent-card-state">
              {agent.definitionId != null ? "deployed" : "draft"}
            </span>
          </button>
          </div>
        ))}
      </div>
      {panel && <div className="project-agent-grid-panel">{panel}</div>}
    </div>
  );
}
