import type {
  AgentMapImplementationsResponse,
  AgentMapWorkspaceResponse,
  PlanNodeId,
  StudioProjectId,
} from "@shared/agent-map";
import { AGENT_MAP_UUID_V7_PATTERN } from "@shared/agent-map-codec";
import type { WorkflowInfo } from "@shared/types";
import {
  DEPLOYMENT_RETAINED,
  DEPLOYMENT_UNAVAILABLE,
  workflowDeploymentIndicator,
  workflowDeploymentTitle,
} from "./workflow-deployment";

const UUID_V4 =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export function parseAgentMapImplementations(
  raw: unknown,
  projectId: StudioProjectId,
): AgentMapImplementationsResponse {
  const value = raw as AgentMapImplementationsResponse | null;
  const ids = new Set<string>();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.projectId !== projectId ||
    !new RegExp(`^project_${UUID_V4}$`).test(projectId) ||
    (value.mapVersionId !== null &&
      (typeof value.mapVersionId !== "string" ||
        !new RegExp(`^mapv_${AGENT_MAP_UUID_V7_PATTERN}$`).test(
          value.mapVersionId,
        ))) ||
    !Array.isArray(value.bindings) ||
    value.bindings.some((binding) => {
      if (
        !binding ||
        typeof binding !== "object" ||
        Array.isArray(binding) ||
        typeof binding.nodeId !== "string" ||
        !new RegExp(`^node_${AGENT_MAP_UUID_V7_PATTERN}$`).test(
          binding.nodeId,
        ) ||
        ids.has(binding.nodeId)
      )
        return true;
      ids.add(binding.nodeId);
      return (
        !Number.isSafeInteger(binding.revision) ||
        binding.revision < 0 ||
        !["bound", "unbound", "missing", "ambiguous", "unavailable"].includes(
          binding.resolution,
        ) ||
        (binding.agentId !== null &&
          (typeof binding.agentId !== "string" ||
            !new RegExp(`^agent_${UUID_V4}$`).test(binding.agentId))) ||
        (binding.resolution === "unbound"
          ? binding.agentId !== null
          : ["bound", "missing"].includes(binding.resolution) &&
            binding.agentId === null)
      );
    })
  )
    throw new Error("Invalid Agent Map implementations");
  return value;
}

export interface AgentMapDeployment {
  bindingKey: string | null;
  indicator: "draft" | "deployed" | null;
  loading: boolean;
  unavailable: boolean;
  title: string | null;
}
export type AgentMapDeployments = ReadonlyMap<PlanNodeId, AgentMapDeployment>;

/** Stable node ids survive live proposal edits; canonical version pointers can lag. */
export function agentMapDeployments(
  snapshot: AgentMapWorkspaceResponse,
  response: AgentMapImplementationsResponse | null,
  workflows: readonly WorkflowInfo[],
  previous: AgentMapDeployments,
  phase: "loading" | "available" | "unavailable",
): AgentMapDeployments {
  const bindings = new Map(
    response?.bindings.map((binding) => [binding.nodeId, binding]),
  );
  const result = new Map<PlanNodeId, AgentMapDeployment>();
  for (const node of snapshot.proposal?.nodes ?? []) {
    if (node.kind !== "agent" && node.kind !== "subagent") continue;
    const old = previous.get(node.id);
    const binding = bindings.get(node.id);
    const key = binding
      ? `${response!.projectId}:${node.id}:${binding.agentId}:${binding.revision}`
      : null;
    let matched = false;
    let title: string | null = null;
    let display: ReturnType<typeof workflowDeploymentIndicator> = {
      indicator: null,
      unavailable: true,
    };
    if (binding?.resolution === "unbound") {
      display = { indicator: "draft", unavailable: false };
      title = workflowDeploymentTitle({ definitionId: null });
    }
    if (binding?.resolution === "bound") {
      const matches = workflows.filter((workflow) =>
        workflow.studioBindings?.some(
          (entry) =>
            entry.projectId === snapshot.project.projectId &&
            entry.agentId === binding.agentId,
        ),
      );
      if (matches.length === 1) {
        matched = true;
        display = workflowDeploymentIndicator(matches[0]);
        title = workflowDeploymentTitle(matches[0]);
      }
    }
    // Retain only the same binding, or the last projection when the entire
    // bulk request failed. An omitted/rebound node cannot inherit a badge.
    const retain =
      !matched &&
      (response === null || (key !== null && key === old?.bindingKey));
    result.set(node.id, {
      bindingKey: response === null ? (old?.bindingKey ?? null) : key,
      indicator:
        display.indicator ?? (retain ? (old?.indicator ?? null) : null),
      loading: phase === "loading",
      unavailable: phase === "unavailable" || display.unavailable,
      title,
    });
  }
  return result;
}

export function agentMapDeploymentLabel(
  status: AgentMapDeployment,
  compact = false,
): string {
  if (status.indicator)
    return status.indicator === "deployed" ? "Deployed" : "Draft";
  return status.loading
    ? compact
      ? "Checking…"
      : "Checking deployment…"
    : compact
      ? "Status unavailable"
      : DEPLOYMENT_UNAVAILABLE;
}
export function agentMapDeploymentTitle(status: AgentMapDeployment): string {
  return status.indicator && status.unavailable
    ? DEPLOYMENT_RETAINED
    : (status.title ?? agentMapDeploymentLabel(status));
}
