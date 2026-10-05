import type { JSX } from "react";
import type { WorkflowInfo } from "@shared/types";

import {
  stepInputFields,
  type CanvasGraph,
  type CanvasGraphNode,
} from "../lib/canvas-graph";
import { trackingAttrs } from "../lib/analytics/tracking-attrs";
import { Icon } from "./Icon";

/** The agent a launched node points at, when the registry knows it: matched
 *  by path, name, or path basename against the node's label (the same rule
 *  as the board's own Open agent, `CanvasStepDetail`). A node is a launched
 *  agent when a `launch` edge reaches it. */
function launchedAgent(
  node: CanvasGraphNode,
  graph: CanvasGraph,
  workflows: readonly WorkflowInfo[],
): WorkflowInfo | null {
  if (!graph.edges.some((edge) => edge.to === node.id && edge.kind === "launch"))
    return null;
  return (
    workflows.find((workflow) => workflow.path === node.label) ??
    workflows.find((workflow) => workflow.name === node.label) ??
    workflows.find((workflow) => workflow.path.endsWith(`/${node.label}`)) ??
    null
  );
}

/**
 * A picked step's detail, small and inside the agent modal
 * (flow-map-chat-overlay.md 4.2b.4, Q8; mock `StepCard.tsx`): its one-line
 * description, its inputs, its outputs, and what it calls. Only what the
 * canvas already has: the posted graph's node (description, input contract,
 * capabilities) and its edges (where it goes next, the only output the graph
 * declares, and the child agent a `launch` edge starts). The one move it
 * offers is opening that child agent, in the same modal (mock MAP-CHAT.md).
 *
 * Every capability is marked metered: the graph lists Sapiom capabilities
 * only, and those are what Sapiom bills for (`CanvasGraphNode.capabilities`).
 */
export function StepCard({
  node,
  graph,
  workflows,
  onOpenAgent,
  onClose,
}: {
  node: CanvasGraphNode;
  graph: CanvasGraph;
  workflows: readonly WorkflowInfo[];
  /** A launched child agent, opened in the modal in this agent's place. */
  onOpenAgent: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const inputs = stepInputFields(node);
  const label = (id: string): string =>
    graph.nodes.find((candidate) => candidate.id === id)?.label ?? id;
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  const outputs = outgoing.filter((edge) => edge.kind !== "launch");
  const children = [
    launchedAgent(node, graph, workflows),
    ...outgoing
      .filter((edge) => edge.kind === "launch")
      .map((edge) => {
        const target = graph.nodes.find((candidate) => candidate.id === edge.to);
        return target ? launchedAgent(target, graph, workflows) : null;
      }),
  ].filter((child): child is WorkflowInfo => child != null);
  const calls = node.capabilities.length > 0 || children.length > 0;

  return (
    <div
      className="step-card"
      data-testid="step-card"
      data-step={node.id}
      role="complementary"
      aria-label={node.label}
      {...trackingAttrs({ object: "agent" })}
    >
      <div className="step-card-head">
        <span className={"canvas-step-dot dot--" + node.kind} aria-hidden="true" />
        <span className="step-card-title" data-testid="step-card-title">
          {node.label}
        </span>
        {node.role && <span className="step-card-role">{node.role}</span>}
        <button
          type="button"
          className="theme-toggle step-card-close"
          data-testid="step-card-close"
          aria-label="Close step"
          data-tooltip="Close"
          onClick={onClose}
        >
          <Icon name="X" size={14} />
        </button>
      </div>
      <div className="step-card-body">
        {node.description && (
          <p className="step-card-desc" data-testid="step-card-desc">
            {node.description}
          </p>
        )}
        <section className="step-card-section" data-testid="step-card-inputs">
          <h4 className="step-card-label">Inputs</h4>
          {inputs.length === 0 ? (
            <p className="step-card-none">None declared</p>
          ) : (
            <ul className="step-card-list">
              {inputs.map((field) => (
                <li key={field.name}>
                  <code>{field.name}</code>
                  <span className="step-card-meta">
                    {field.type}
                    {field.required ? "" : ", optional"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="step-card-section" data-testid="step-card-outputs">
          <h4 className="step-card-label">Outputs</h4>
          {outputs.length === 0 ? (
            <p className="step-card-none">Ends here</p>
          ) : (
            <ul className="step-card-list">
              {outputs.map((edge) => (
                <li key={`${edge.to}-${edge.label}`}>
                  <span>To {label(edge.to)}</span>
                  {edge.label && <span className="step-card-meta">{edge.label}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="step-card-section" data-testid="step-card-calls">
          <h4 className="step-card-label">Calls</h4>
          {!calls ? (
            <p className="step-card-none">Nothing declared</p>
          ) : (
            <ul className="step-card-list">
              {node.capabilities.map((capability) => (
                <li key={capability}>
                  <code>{capability}</code>
                  <span className="step-card-pill" data-testid="step-card-metered">
                    metered
                  </span>
                </li>
              ))}
              {children.map((child) => (
                <li key={child.path}>
                  <span>Launches {child.name}</span>
                  <span className="step-card-meta">agent</span>
                  <button
                    type="button"
                    className="theme-toggle step-card-open"
                    data-testid="step-card-open-agent"
                    aria-label={`Open ${child.name}`}
                    data-tooltip="Open agent"
                    onClick={() => onOpenAgent(child.path)}
                  >
                    <Icon name="ArrowUpRight" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
