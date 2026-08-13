/**
 * Code tab — the integration projection of the bound agent (the app's IA
 * right-pane contract: Canvas | Steps | Code | Skills). Same anatomy as the
 * sibling tabs: the shared subheader (title left, status right) over a
 * --pane-pad-x body. The body hosts the "Trigger from your code" snippets
 * for a DEPLOYED agent; the other states say honestly why there is nothing
 * to copy yet. Mounted lazily like Skills.
 */
import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { SnippetPanel } from "./SnippetPanel";
import { workflowDeploymentState } from "../lib/workflow-deployment";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";

interface CodePanelProps {
  /** The workflow bound to the active session, if any. */
  boundWorkflow: WorkflowInfo | null;
  /** Set when an agent is open with no live session in its workspace — the
   *  honest empty state names it (matching the pane below the header). */
  noSessionAgent?: string | null;
  /** The Agents API base URL (from AppState) — see SnippetPanel. */
  agentsBaseUrl?: string;
  /** Local terminal deploy error, used when cloud status could not refresh. */
  lastDeployError?: string | null;
}

export function CodePanel({
  boundWorkflow,
  noSessionAgent = null,
  agentsBaseUrl,
  lastDeployError = null,
}: CodePanelProps): JSX.Element {
  // No bound agent — the empty state centres like the sibling tabs (it is a
  // direct child of the flex-column right-pane panel, so its own flex:1 fills
  // the height). Naming the opened agent when there is one keeps it honest.
  if (!boundWorkflow) {
    return (
      <EmptyState
        className="code-panel-empty"
        icon="Code"
        title={noSessionAgent ? `No running session for ${noSessionAgent}` : "No agent bound"}
        body={
          noSessionAgent
            ? "Start a session to inspect this agent's integration snippets here."
            : "Open an agent to see how to trigger it from your code."
        }
      />
    );
  }
  const deploymentState = workflowDeploymentState(
    boundWorkflow,
    lastDeployError,
  );
  const deployed = deploymentState === "ready";
  const statusLabel =
    deploymentState === "building"
      ? "Building"
      : deploymentState === "failed"
        ? "Deploy failed"
        : deploymentState === "linked"
          ? "Linked"
          : "Draft";
  const emptyTitle =
    deploymentState === "building"
      ? "Cloud build in progress"
      : deploymentState === "failed"
        ? "Deploy did not produce a ready build"
        : deploymentState === "linked"
          ? "No ready deployment yet"
          : "Deploy to trigger from code";
  const emptyBody =
    deploymentState === "building"
      ? `${boundWorkflow.name} is linked and building. Integration snippets appear after the cloud build is ready.`
      : deploymentState === "failed"
        ? `Fix ${boundWorkflow.name} and retry Deploy. Studio only shows integration snippets for a ready cloud build.`
        : deploymentState === "linked"
          ? `${boundWorkflow.name} is linked to Sapiom, but Studio cannot confirm a ready cloud build. Deploy it before integrating.`
          : `${boundWorkflow.name} is a draft. Once it deploys, TypeScript SDK and cURL starter calls appear here.`;
  return (
    <div className="code-panel" {...trackingAttrs({ surface: "code_panel" })}>
      {/* The SAME subheader recipe Canvas and Steps use: agent name left,
          the one server-provable status right (flat status tag). */}
      <div className="workflow-actions-header code-panel-header" data-testid="code-panel-header">
        <span className="workflow-actions-name">{boundWorkflow.name}</span>
        {deployed ? (
          <span
            className="status-tag workflow-deployed-tag"
            data-testid="code-panel-status"
            data-tooltip="Ready cloud build"
          >
            <span className="workflow-dot workflow-dot-pinned" aria-hidden="true" />
            Deployed
          </span>
        ) : (
          <span
            className="status-tag code-panel-draft-tag"
            data-testid="code-panel-status"
            data-tooltip={emptyTitle}
          >
            <Icon name="CloudOff" size={13} />
            {statusLabel}
          </span>
        )}
      </div>
      {/* Deployed: the snippet card flows from the top of the scroll body,
          the SAME flex/scroll model the Steps tab body uses (a scroll
          surface, not a flex column with an orphaned void below the card).
          Draft: the empty state is a sibling of that body — flex:1 fills the
          pane so it centres like every other right-pane empty state. */}
      {deployed ? (
        <div className="code-panel-body" data-testid="code-panel-body">
          {/* Keyed by workflow path so switching between two deployed agents
              remounts the panel, resetting its tab/copied state. */}
          <SnippetPanel key={boundWorkflow.path} boundWorkflow={boundWorkflow} agentsBaseUrl={agentsBaseUrl} />
        </div>
      ) : (
        <EmptyState
          className="code-panel-empty"
          icon="Code"
          title={emptyTitle}
          body={emptyBody}
        />
      )}
    </div>
  );
}
