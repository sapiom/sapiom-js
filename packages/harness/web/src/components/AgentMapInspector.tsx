import type { JSX } from "react";
import type {
  AcceptedProposalDelta,
  AgentMapWorkspaceResponse,
  PlanNodeId,
} from "@shared/agent-map";

import { latestNodeAttribution } from "../lib/agent-map-projector";

interface AgentMapInspectorProps {
  snapshot: AgentMapWorkspaceResponse;
  nodeId: PlanNodeId;
  latestDelta?: AcceptedProposalDelta;
}

export function AgentMapInspector({
  snapshot,
  nodeId,
  latestDelta,
}: AgentMapInspectorProps): JSX.Element | null {
  const proposal = snapshot.proposal;
  const node = proposal?.nodes.find((candidate) => candidate.id === nodeId);
  if (!proposal || !node) return null;
  const owner = node.ownerAgentId
    ? proposal.nodes.find((candidate) => candidate.id === node.ownerAgentId)
    : null;
  const connected = proposal.relationships.filter(
    (relationship) =>
      relationship.fromNodeId === node.id || relationship.toNodeId === node.id,
  );
  const latest = latestNodeAttribution(snapshot, node.id, latestDelta);
  const assignment = latest?.actor.assignment;
  return (
    <aside
      className="agent-map-inspector"
      data-testid="agent-map-inspector"
      aria-label={`${node.name} details`}
    >
      <div className="agent-map-inspector-heading">
        <div>
          <p className="system-graph-node-meta">{node.kind}</p>
          <h3>{node.name}</h3>
        </div>
        <span className="status-tag">Proposed</span>
      </div>
      <section>
        <h4>Purpose</h4>
        <p>{node.purpose}</p>
      </section>
      <section>
        <h4>Semantic owner</h4>
        <p>
          {owner?.name ??
            (node.kind === "subagent" ? "Unavailable" : "Project")}
        </p>
      </section>
      <section>
        <h4>Contracts</h4>
        {node.contractRefs.length > 0 ? (
          <ul>
            {node.contractRefs.map((contract) => (
              <li key={contract}>{contract}</li>
            ))}
          </ul>
        ) : (
          <p>None declared</p>
        )}
      </section>
      <section>
        <h4>Relationships</h4>
        {connected.length > 0 ? (
          <ul>
            {connected.map((relationship) => (
              <li key={relationship.id}>
                {relationship.kind}
                {relationship.contractRef
                  ? ` · ${relationship.contractRef}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p>No connected relationships</p>
        )}
      </section>
      <section>
        <h4>Validation</h4>
        <p>No validation warnings</p>
      </section>
      {latest && (
        <section data-testid="agent-map-latest-attribution">
          <h4>Latest change</h4>
          <p>
            {latest.actor.role === "map-planner"
              ? "Map planner"
              : "Agent builder"}
            {assignment?.kind === "planned"
              ? " · planned assignment"
              : assignment?.kind === "unplanned"
                ? " · unplanned"
                : ""}
            {` · ${new Date(latest.acceptedAt).toLocaleString()}`}
          </p>
        </section>
      )}
    </aside>
  );
}
