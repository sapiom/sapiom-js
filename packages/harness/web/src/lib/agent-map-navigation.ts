import type { PlanNodeId, StudioProjectId } from "@shared/agent-map";
import { AGENT_MAP_UUID_V7_PATTERN } from "@shared/agent-map-codec";
import type { WorkflowInfo } from "@shared/types";

export interface AgentMapNodeTarget {
  projectId: StudioProjectId;
  nodeId: PlanNodeId;
  agentId: string;
  workflowPath: string;
}

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function parseAgentMapNodeTarget(
  raw: unknown,
  projectId: StudioProjectId,
  nodeId: PlanNodeId,
): AgentMapNodeTarget {
  const value = raw as Partial<AgentMapNodeTarget> | null;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 4 ||
    value.projectId !== projectId ||
    !new RegExp(`^project_${UUID_V4}$`).test(projectId) ||
    value.nodeId !== nodeId ||
    !new RegExp(`^node_${AGENT_MAP_UUID_V7_PATTERN}$`).test(nodeId) ||
    typeof value.agentId !== "string" ||
    !new RegExp(`^agent_${UUID_V4}$`).test(value.agentId) ||
    typeof value.workflowPath !== "string" ||
    !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value.workflowPath) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.workflowPath)
  ) {
    throw new Error("Invalid Agent Map navigation target");
  }
  return value as AgentMapNodeTarget;
}

export function agentMapTargetWorkflow(
  target: AgentMapNodeTarget,
  workflows: readonly WorkflowInfo[],
): WorkflowInfo | null {
  const matches = workflows.filter((workflow) =>
    workflow.studioBindings?.some(
      (binding) =>
        binding.projectId === target.projectId &&
        binding.agentId === target.agentId,
    ),
  );
  if (matches.length > 1)
    throw Object.assign(new Error(), { code: "target_ambiguous" });
  return matches[0]?.path === target.workflowPath ? matches[0] : null;
}

export function agentMapNavigationError(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  switch (code) {
    case "unbound":
      return "No implementation is linked yet.";
    case "target_not_found":
    case "project_not_found":
    case "node_not_found":
      return "This agent isn't available locally.";
    case "target_ambiguous":
      return "Studio can't identify one implementation for this node.";
    default:
      return "Couldn't open this agent. Try again.";
  }
}
