import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * The map's stand-in for a project with no map drawn: every agent in the
 * project as a card, so the one interaction the flow asks of the map (click
 * an agent, see it, start a chat) works on every project, including one with
 * no Studio project behind it (an older server). This is not a layout, it is
 * a list that behaves like the map's nodes do.
 */
export function ProjectAgentGrid({
  agents,
  selectedPath,
  onPick,
  onEnter,
  panel,
}: {
  agents: readonly WorkflowInfo[];
  selectedPath: string | null;
  onPick: (agent: WorkflowInfo) => void;
  onEnter: (agent: WorkflowInfo) => void;
  panel: JSX.Element | null;
}): JSX.Element {
  return (
    <div className="project-agent-grid-wrap">
      <p
        className="project-agent-grid-note"
        data-testid="project-agent-grid-note"
      >
        No map is drawn for this project yet, so its agents are listed. Click
        one to open it.
      </p>
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
            onDoubleClick={() => onEnter(agent)}
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
