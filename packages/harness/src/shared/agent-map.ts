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

export interface SessionPrincipal {
  projectId: StudioProjectId;
  sessionId: string;
  userId: string;
}

export type PlanningSessionIdentity =
  | (SessionPrincipal & { role: "map-planner" })
  | (SessionPrincipal & {
      role: "agent-builder";
      assignment: { kind: "planned"; agentId: string };
    })
  | (SessionPrincipal & {
      role: "agent-builder";
      assignment: { kind: "unplanned" };
    });

export type PlannerGreetingErrorCode =
  | "session_not_ready"
  | "session_exited"
  | "injection_failed"
  | "model_turn_failed"
  | "delivery_timeout"
  | "persistence_failed";

export type PlannerGreetingState =
  | { status: "pending" }
  | { status: "generating"; attemptId: string }
  | { status: "delivered"; messageId: string }
  | {
      status: "failed";
      retryable: boolean;
      errorCode: PlannerGreetingErrorCode;
    }
  | { status: "skipped"; reason: "user-proceeded" };

export interface PlannerSessionMetadata {
  identity: Extract<PlanningSessionIdentity, { role: "map-planner" }>;
  greeting: PlannerGreetingState;
  queuedInputIds: string[];
}

export interface PlannerQueuedInput {
  id: string;
  sessionId: string;
  text: string;
  acceptedAt: string;
}

export interface PlannerSessionRequest {
  mode: "resume-or-create" | "fresh";
  harness?: import("./types.js").HarnessKind;
  theme?: import("./types.js").UiTheme;
}

export interface PlannerSessionResponse {
  session: import("./types.js").HarnessSession;
  resolution: "created" | "live" | "resumed" | "rehydrated";
}

export interface PlannerMessageRequest {
  text: string;
}

/**
 * Content-free planner lifecycle telemetry. Callers may persist these fields,
 * but must never add prompts, assistant text, local paths, or provider errors.
 */
export type PlannerLifecycleEvent =
  | {
      name: "planner_session.created" | "planner_session.resumed";
      projectId: StudioProjectId;
      sessionId: string;
      resolution: PlannerSessionResponse["resolution"];
    }
  | {
      name: "planner_greeting.attempted" | "planner_greeting.retried";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId: string;
      queueDepth: number;
    }
  | {
      name: "planner_greeting.delivered";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId: string;
      queueDepth: number;
    }
  | {
      name: "planner_greeting.failed";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId?: string;
      errorCode: PlannerGreetingErrorCode;
      retryable: boolean;
      queueDepth: number;
    }
  | {
      name: "planner_greeting.skipped";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId?: string;
      reason: "user-proceeded";
      queueDepth: number;
    };
