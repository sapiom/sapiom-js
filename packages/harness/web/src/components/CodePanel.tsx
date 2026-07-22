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

interface CodePanelProps {
  /** The workflow bound to the active session, if any. */
  boundWorkflow: WorkflowInfo | null;
  /** Set when an agent is open with no live session in its workspace — the
   *  honest empty state names it (matching the pane below the header). */
  noSessionAgent?: string | null;
  /** The Agents API base URL (from AppState) — see SnippetPanel. */
  agentsBaseUrl?: string;
}

export function CodePanel({ boundWorkflow, noSessionAgent = null, agentsBaseUrl }: CodePanelProps): JSX.Element {
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
            ? "Start a session to trigger this agent from your code."
            : "Open an agent to see how to trigger it from your code."
        }
      />
    );
  }
  const deployed = boundWorkflow.definitionId != null;
  return (
    <div className="code-panel">
      {/* The SAME subheader recipe Canvas and Steps use: agent name left,
          the one server-provable status right (flat status tag). */}
      <div className="workflow-actions-header code-panel-header" data-testid="code-panel-header">
        <span className="workflow-actions-name">{boundWorkflow.name}</span>
        {deployed ? (
          <span
            className="status-tag workflow-deployed-tag"
            data-testid="code-panel-status"
            data-tooltip="Deployed to production"
          >
            <span className="workflow-dot workflow-dot-pinned" aria-hidden="true" />
            Deployed
          </span>
        ) : (
          <span
            className="status-tag code-panel-draft-tag"
            data-testid="code-panel-status"
            data-tooltip="Exists locally only. Deploy it to call it from your code."
          >
            <Icon name="CloudOff" size={13} />
            Draft
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
          title="Deploy to trigger from code"
          body={`${boundWorkflow.name} is a draft. Once it deploys, copy-paste TypeScript SDK and cURL calls for it appear here.`}
        />
      )}
    </div>
  );
}
