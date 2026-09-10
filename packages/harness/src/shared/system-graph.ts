/** Retired graph contracts, pending engine deletion. */
import type { WorkspaceKey } from "./workspace-scope.js";
import type { AgentInvocationMode } from "../core/canvas-interconnections.js";
export type { WorkspaceKey, WorkspaceScopeSummary } from "./workspace-scope.js";
export { workspaceRelativeLocalKey } from "./workspace-scope.js";
export type { AgentInvocationMode } from "../core/canvas-interconnections.js";
export type AgentKey = string;

/** Internal HTTP metadata; it is deliberately not part of SystemGraph JSON. */
export const SYSTEM_GRAPH_CACHE_HEADER = "X-Sapiom-System-Graph-Cache";
export type SystemGraphCacheStatus = "complete" | "degraded";

export interface SystemGraphNode {
  id: string;
  agentKey: AgentKey;
  label: string;
}

export interface StaticInvocationGraphEdge {
  from: string;
  to: string;
  kind: "invokes";
  basis: "static-invocation";
  mode: AgentInvocationMode;
}

export type SystemGraphEdge = StaticInvocationGraphEdge;

export interface GraphWarning {
  code:
    | "unresolved-target"
    | "dynamic-target"
    | "duplicate-edge"
    | "projection-failed"
    | "duplicate-agent-key"
    | "inventory-extraction-failed";
  message: string;
  agentKey?: AgentKey;
}

export interface SystemGraph {
  kind: "system";
  scope: {
    kind: "working-tree";
    workspaceKey: WorkspaceKey;
  };
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
  warnings: GraphWarning[];
}
export type SystemGraphLifecycleState =
  | "building"
  | "ready"
  | "stale"
  | "degraded";

/** Path-free lifecycle envelope for one workspace projection. */
export interface SystemGraphSnapshot {
  workspaceKey: WorkspaceKey;
  /** Monotonic within one server process and workspace. */
  revision: number;
  state: SystemGraphLifecycleState;
  /** Null only before a usable projection exists. */
  graph: SystemGraph | null;
}

/** Protected local resolver payload. Paths remain separate from SystemGraph. */
export interface SystemGraphNavigationTarget {
  agentKey: AgentKey;
  workflowPath: string;
}

export interface SystemGraphNavigationResponse {
  workspaceKey: WorkspaceKey;
  /** Must equal the displayed SystemGraphSnapshot revision before use. */
  revision: number;
  targets: SystemGraphNavigationTarget[];
}
