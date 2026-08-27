import type { CSSProperties, JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { Icon } from "./Icon";
import { displayAgentName } from "../lib/agent-name";
import { workflowDeploymentState } from "../lib/workflow-deployment";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

/**
 * One agent (workflow) row — the hero of the rail. The rail is an EXPLORER of
 * what exists on disk: clicking a row FOCUSES the agent, which swaps the main
 * panel's session tab strip to that agent's sessions. Sessions are not a rail
 * concern, so this row carries no session dot, no expander, and no session
 * sub-rows.
 *
 * Row anatomy: [dimmed parent prefix]/[agent name][deployed/draft cloud glyph].
 * The prefix is the unbranched directory chain compacted onto this row — the
 * `tools` of `scripts/tools/rollup` when nothing else lives down that path. It
 * is context, not identity: it renders quiet and never wins the row, because
 * the path is not what you are looking for most of the time. The focused agent
 * is the single filled selection (is-focused).
 */
export function WorkflowRow({
  workflow,
  isFocused,
  onFocus,
  prefix = "",
  prefixFull = "",
  depth = 0,
}: {
  workflow: WorkflowInfo;
  /** The focused agent — THE single filled selection in the rail. */
  isFocused: boolean;
  onFocus: (path: string) => void;
  /** The agent's IMMEDIATE parent directory, never the abbreviated chain — a
   *  directory row owns its whole row, but this one shares its width with the
   *  agent's name and must never beat it. See project-tree's AgentNode. */
  prefix?: string;
  /** The same chain unabbreviated, for the prefix's own tooltip. */
  prefixFull?: string;
  /** Nesting level under the project row. Indent alone carries the nesting. */
  depth?: number;
}): JSX.Element {
  const deploymentState = workflowDeploymentState(workflow);
  const deployed = deploymentState === "ready";
  const statusTitle =
    deploymentState === "ready"
      ? "Deployed to Sapiom with a ready build."
      : deploymentState === "building"
        ? "Cloud build in progress."
        : deploymentState === "failed"
          ? "Cloud build failed."
          : deploymentState === "linked"
            ? "Linked to Sapiom; no ready build confirmed."
            : "Draft. Not deployed to Sapiom yet.";
  return (
    <div
      className={"workflow-item" + (isFocused ? " is-focused" : "")}
      data-testid={`workflow-${workflow.name}`}
      style={depth > 0 ? ({ "--tree-depth": depth } as CSSProperties) : undefined}
      // `object: "agent"` is load-bearing for privacy, not just for breakdowns:
      // before-send reads it to drop $el_text on this subtree, because an
      // agent's label is a name its owner wrote. See USER_NAMED_OBJECTS.
      {...trackingAttrs({ object: "agent" })}
    >
      <button
        className="tree-row workflow-item-trigger"
        onClick={() => onFocus(workflow.path)}
        aria-pressed={isFocused}
        /* The ABSOLUTE path, matching directory and project rows. The title
           used to be the agent's own name — a tooltip repeating the label it
           is attached to. The row shows you what it is; the title is for where
           it actually lives, and only the absolute path answers that. */
        title={workflow.path}
        data-tooltip={isFocused ? "Focused agent" : "Focus this agent"}
      >
        {/* Prefix and name are ONE flex child so the row's gap cannot open a
            space inside a path — `scripts/tools/ rollup` read as two separate
            things rather than one location. */}
        <span className="tree-row-name">
          {prefix && (
            <>
              <span className="tree-row-prefix" data-testid={`workflow-prefix-${workflow.name}`}>
                {prefix}
              </span>
              {/* The slash sits OUTSIDE the truncating span so it survives.
                  Inside it, a clipped prefix lost its separator and
                  `components/mailer` rendered as `componen…mailer` — one word
                  where there were two things. */}
              <span className="tree-row-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          <span
            className="tree-row-label"
            data-testid={`workflow-name-${workflow.name}`}
            title={prefixFull ? `${prefixFull}/${workflow.name}` : undefined}
          >
            {displayAgentName(workflow.name)}
          </span>
        </span>
        <span
          className="workflow-status"
          data-deployed={deployed}
          data-deployment-state={deploymentState}
          data-testid={`workflow-status-${workflow.name}`}
          title={statusTitle}
        >
          <Icon name={deployed ? "Cloud" : "CloudOff"} size={13} />
        </span>
      </button>
    </div>
  );
}
