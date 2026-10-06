/**
 * Public, path-free contracts for Studio projects: identity, root bindings,
 * the current-workspace preference, and the session principal.
 *
 * Durable filesystem bindings live in core/studio-project-catalog.ts. This
 * module is safe to import in the browser: it deliberately has no local root,
 * repository URL, legacy WorkspaceKey, prompt, or source-inventory fields.
 * The agent map itself is computed from code by `@sapiom/mcp/map` and has no
 * types here.
 */

export type StudioProjectId = string;

export const STUDIO_PROJECT_CATALOG_SCHEMA_VERSION = 1;
/** The map schema `@sapiom/mcp` advertises in its capability descriptor. */
export const AGENT_MAP_WORKSPACE_SCHEMA_VERSION = 1;
export const STUDIO_WORKSPACE_PREFERENCE_SCHEMA_VERSION = 1;

export type ProjectRootBindingStatus = "active" | "missing";

/** The public projection of a server-private root binding. */
export interface StudioProjectBindingSummary {
  id: string;
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

/** Stable, path-free identity for the workspace currently open in Studio. */
export type StudioWorkspaceSelection =
  | { kind: "agent-map"; projectId: StudioProjectId }
  | { kind: "agent"; projectId: StudioProjectId; agentId: string };

/** Server-owned preference. The user id is derived from the trusted host. */
export interface StudioWorkspacePreference {
  userId: string;
  projectId: StudioProjectId;
  selection: StudioWorkspaceSelection;
  updatedAt: string;
}

/** Public projection of a server-private agent/path binding. */
export interface StudioWorkspaceAgentSummary {
  agentId: string;
  name: string;
  definitionId: number | null;
}

export interface StudioCurrentWorkspaceResponse {
  projectId: StudioProjectId;
  selection: StudioWorkspaceSelection;
  agents: StudioWorkspaceAgentSummary[];
  /** True when a missing, deleted, or foreign selection was repaired to map. */
  repaired: boolean;
}

export interface PutStudioCurrentWorkspaceRequest {
  selection: StudioWorkspaceSelection;
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

export interface SessionPrincipal {
  projectId: StudioProjectId;
  sessionId: string;
  userId: string;
}

/**
 * Server-derived authority for an ordinary session inside a Studio project.
 *
 * Any other session metadata lives outside this principal: it may describe
 * why a session exists, but it cannot change which project tools or execution
 * policy the session receives.
 */
export type ProjectAgentSession = Readonly<SessionPrincipal>;
