/**
 * Public, path-free contracts for the plan-first Agent Map.
 *
 * Durable filesystem bindings live in core/studio-project-catalog.ts. This
 * module is safe to import in the browser: it deliberately has no local root,
 * repository URL, legacy WorkspaceKey, prompt, or source-inventory fields.
 */

export type StudioProjectId = string;

export const STUDIO_PROJECT_CATALOG_SCHEMA_VERSION = 1;
export const AGENT_MAP_WORKSPACE_SCHEMA_VERSION = 1;
export const AGENT_MAP_INITIAL_RECORD_VERSION = 1;

export type ProjectRootBindingStatus = "active" | "missing";

/** The public projection of a server-private root binding. */
export interface StudioProjectBindingSummary {
  id: string;
  repositoryId: string | null;
  status: ProjectRootBindingStatus;
}

/** Stable project identity published to AppState and Agent Map consumers. */
export interface StudioProjectSummary {
  projectId: StudioProjectId;
  identityVersion: number;
  displayName: string;
  bindings: StudioProjectBindingSummary[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The deliberately empty E1 workspace record. Schema and record versions are
 * independent: schemaVersion controls persistence migration while
 * recordVersion is reserved for optimistic application mutations.
 */
export interface AgentMapWorkspaceState {
  projectId: StudioProjectId;
  schemaVersion: number;
  recordVersion: number;
  confirmedRevisionId: string | null;
  activeProposalId: string | null;
  projectBuildPlanId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMapWorkspaceResponse {
  project: StudioProjectSummary;
  workspace: AgentMapWorkspaceState;
}

export type AgentMapErrorCode =
  | "project_not_found"
  | "malformed_state"
  | "unsupported_schema"
  | "storage_unavailable";

/** Stable error shape; `error` is intentionally bounded and path-free. */
export interface AgentMapErrorResponse {
  code: AgentMapErrorCode;
  error: string;
}
