import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";

/**
 * One agent (workflow) row — the hero of the rail, LEVEL 2 under a workspace
 * folder header. The rail is an EXPLORER of what exists on disk:
 * clicking a row FOCUSES the agent, which swaps the main panel's session tab
 * strip to that agent's sessions. Sessions are not a rail concern, so this row
 * carries no session dot, no expander, and no session sub-rows.
 *
 * Row anatomy: [zap glyph][agent name][deployed/draft cloud glyph]. The
 * focused agent is the single filled selection (is-focused).
 */
export function WorkflowRow({
  workflow,
  isFocused,
  onFocus,
}: {
  workflow: WorkflowInfo;
  /** The focused agent — THE single filled selection in the rail. */
  isFocused: boolean;
  onFocus: (path: string) => void;
}): JSX.Element {
  const deployed = workflow.definitionId != null;
  return (
    <div
      className={"workflow-item" + (isFocused ? " is-focused" : "")}
      data-testid={`workflow-${workflow.name}`}
    >
      <button
        className="tree-row workflow-item-trigger"
        onClick={() => onFocus(workflow.path)}
        aria-pressed={isFocused}
        data-tooltip={isFocused ? "Focused agent" : "Focus this agent"}
      >
        <Icon name="Zap" size={13} />
        <span className="tree-row-label">{workflow.name}</span>
        <span
          className="workflow-status"
          data-deployed={deployed}
          data-testid={`workflow-status-${workflow.name}`}
          title={deployed ? "Deployed to Sapiom" : "Draft. Not deployed to Sapiom yet."}
        >
          <Icon name={deployed ? "Cloud" : "CloudOff"} size={13} />
        </span>
      </button>
    </div>
  );
}
