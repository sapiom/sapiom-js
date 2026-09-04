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
export const STUDIO_WORKSPACE_PREFERENCE_SCHEMA_VERSION = 1;
export const AGENT_MAP_PROPOSAL_SCHEMA_VERSION = 1 as const;

type AgentMapBrand<TBrand extends string> = string & {
  readonly __brand: TBrand;
};

/** Opaque, service-allocated identities. Callers must never derive these. */
export type PlanNodeId = AgentMapBrand<"PlanNodeId">;
export type PlanRelationshipId = AgentMapBrand<"PlanRelationshipId">;
export type MapProposalId = AgentMapBrand<"MapProposalId">;
export type ProposalOperationId = AgentMapBrand<"ProposalOperationId">;
export type AgentMapVersionId = AgentMapBrand<"AgentMapVersionId">;
/** Identity of normalized graph meaning. It is deliberately project-neutral. */
export type GraphContentDigest = AgentMapBrand<"GraphContentDigest">;
/** Integrity identity for a complete immutable record or aggregate. */
export type RecordDigest = AgentMapBrand<"RecordDigest">;
/** A caller-authored alias whose lifetime is exactly one operation batch. */
export type DraftRef = AgentMapBrand<"DraftRef">;

export const PLAN_NODE_KINDS = [
  "agent",
  "subagent",
  "resource",
  "connector",
  "artifact",
] as const;
export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number];

export const RELATIONSHIP_KINDS = [
  "invokes",
  "feeds",
  "reads",
  "writes",
  "uses",
  "triggers",
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const EXECUTION_MODES = [
  "synchronous",
  "asynchronous",
  "scheduled",
  "human-triggered",
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface PlanNode {
  id: PlanNodeId;
  kind: PlanNodeKind;
  name: string;
  purpose: string;
  ownerAgentId: PlanNodeId | null;
  contractRefs: string[];
}

export interface PlanRelationship {
  id: PlanRelationshipId;
  fromNodeId: PlanNodeId;
  toNodeId: PlanNodeId;
  kind: RelationshipKind;
  executionMode: ExecutionMode | null;
  contractRef: string | null;
  description: string;
}

export interface AgentMapGraph {
  nodes: PlanNode[];
  relationships: PlanRelationship[];
}

export type NodeRef = { nodeId: PlanNodeId } | { draftRef: DraftRef };

export type PlanNodeChanges = Partial<
  Pick<PlanNode, "name" | "purpose" | "contractRefs">
>;
export type RelationshipChanges = Partial<
  Pick<PlanRelationship, "description" | "executionMode" | "contractRef">
>;

/** Caller-facing operations. Authority and permanent IDs are intentionally absent. */
export type MapOperationInput =
  | {
      kind: "add-node";
      draftRef: DraftRef;
      node: Omit<PlanNode, "id" | "ownerAgentId"> & {
        ownerAgent: NodeRef | null;
      };
    }
  | { kind: "update-node"; nodeId: PlanNodeId; changes: PlanNodeChanges }
  | { kind: "remove-node"; nodeId: PlanNodeId }
  | {
      kind: "add-relationship";
      draftRef: DraftRef;
      relationship: Omit<PlanRelationship, "id" | "fromNodeId" | "toNodeId"> & {
        from: NodeRef;
        to: NodeRef;
      };
    }
  | {
      kind: "update-relationship";
      relationshipId: PlanRelationshipId;
      changes: RelationshipChanges;
    }
  | { kind: "remove-relationship"; relationshipId: PlanRelationshipId };

/** Persistable operations after the service allocates every permanent ID. */
export type MapOperation =
  | { kind: "add-node"; node: PlanNode }
  | { kind: "update-node"; nodeId: PlanNodeId; changes: PlanNodeChanges }
  | { kind: "remove-node"; nodeId: PlanNodeId }
  | { kind: "add-relationship"; relationship: PlanRelationship }
  | {
      kind: "update-relationship";
      relationshipId: PlanRelationshipId;
      changes: RelationshipChanges;
    }
  | { kind: "remove-relationship"; relationshipId: PlanRelationshipId };

export interface ProposalBatchRequest {
  schemaVersion: typeof AGENT_MAP_PROPOSAL_SCHEMA_VERSION;
  proposalId: MapProposalId | null;
  expectedVersion: number;
  requestId: string;
  operations: MapOperationInput[];
}

export type ProposalValidationRecovery = "reread" | "correct" | "retry";

export type ProposalValidationIssueCode =
  | "malformed_input"
  | "unsupported_schema"
  | "empty_batch"
  | "duplicate_draft_ref"
  | "unknown_reference"
  | "duplicate_target"
  | "invalid_owner"
  | "self_relationship"
  | "invalid_relationship_endpoints"
  | "duplicate_relationship"
  | "immutable_field"
  | "dependent_entity";

/** Bounded and field-addressable. It never echoes caller values or prose. */
export interface ProposalValidationIssue {
  code: ProposalValidationIssueCode;
  operationIndex: number | null;
  path: Array<string | number>;
  recovery: ProposalValidationRecovery;
}

export type ProposalValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ProposalValidationIssue[] };

export type ProposalConflictCode =
  | "stale_version"
  | "request_id_reused"
  | "request_id_expired";

export interface ProposalConflict {
  code: ProposalConflictCode;
  currentVersion: number;
  affectedNodeIds: PlanNodeId[];
  affectedRelationshipIds: PlanRelationshipId[];
  recovery: "reread" | "retry" | "new_request";
}

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

/** Backwards-compatible route name for the canonical Agent Map read shape. */
export type AgentMapWorkspaceResponse = AgentMapReadSnapshot;

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
 * Optional assignment, bootstrap, and focused-context metadata deliberately
 * live outside this principal: they may describe why a session exists, but
 * they cannot change which project tools or execution policy it receives.
 */
export type ProjectAgentSession = Readonly<SessionPrincipal>;

/** Trusted, role-neutral attribution stored on immutable project records. */
export type ProjectAgentActorRef = Readonly<{
  userId: string;
  sessionId: string;
}>;

/** Exact project-bound identity of immutable Agent Map content. */
export type AgentMapVersionRef = Readonly<{
  projectId: StudioProjectId;
  versionId: AgentMapVersionId;
  contentDigest: GraphContentDigest;
}>;

export type ProjectVersionChangeKind = "created" | "edited" | "rebased" | "restored" | "migrated";

export type ProjectMutationOrigin = Readonly<{
  kind: "request" | "migration";
  requestDigest: string;
  operationIds: readonly ProposalOperationId[];
  touchKeys: readonly string[];
}>;

/** One immutable entry in the sole project Agent Map history. */
export type AgentMapVersion = Readonly<{
  schemaVersion: 1;
  projectId: StudioProjectId;
  versionId: AgentMapVersionId;
  version: number;
  parentVersionId: AgentMapVersionId | null;
  changeKind: ProjectVersionChangeKind;
  restoredFromVersionId: AgentMapVersionId | null;
  graph: AgentMapGraph;
  contentDigest: GraphContentDigest;
  authoredBy: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
  recordDigest: RecordDigest;
}>;

/** Role-neutral operation provenance used after the deployed E2 migration. */
export type RoleNeutralMapOperationRecord = Readonly<{
  id: ProposalOperationId;
  requestId: string;
  acceptedVersion: number;
  operation: MapOperation;
  actor: ProjectAgentActorRef;
  acceptedAt: string;
}>;

/**
 * @deprecated Persisted rolling-compatibility metadata only. Live Agent Map
 * authority uses {@link ProjectAgentSession}; role and assignment must never
 * participate in authorization or capability composition.
 */
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

/**
 * Legacy E2 persisted attribution shape. SAP-3148 keeps the codec stable while
 * live authority moves to ProjectAgentSession; SAP-3149 owns its durable
 * role-neutral replacement.
 */
export interface ProposalActor {
  userId: string;
  sessionId: string;
  role: "map-planner" | "agent-builder";
  assignment:
    | { kind: "planned"; agentId: string }
    | { kind: "unplanned" }
    | null;
}

export interface ProposalOperationRecord {
  id: ProposalOperationId;
  requestId: string;
  acceptedVersion: number;
  operation: MapOperation;
  actor: ProposalActor;
  acceptedAt: string;
}

export interface AcceptedProposalDelta {
  schemaVersion: typeof AGENT_MAP_PROPOSAL_SCHEMA_VERSION;
  projectId: StudioProjectId;
  proposalId: MapProposalId;
  fromVersion: number;
  version: number;
  operationIds: ProposalOperationId[];
  operations: MapOperation[];
  actor: ProposalActor;
  acceptedAt: string;
}

export interface ProposalBatchResult {
  schemaVersion: typeof AGENT_MAP_PROPOSAL_SCHEMA_VERSION;
  proposalId: MapProposalId;
  version: number;
  operationIds: ProposalOperationId[];
  allocatedNodeIds: Record<DraftRef, PlanNodeId>;
  allocatedRelationshipIds: Record<DraftRef, PlanRelationshipId>;
  delta: AcceptedProposalDelta;
}

export interface MapChangeProposal {
  schemaVersion: typeof AGENT_MAP_PROPOSAL_SCHEMA_VERSION;
  id: MapProposalId;
  projectId: StudioProjectId;
  baseRevisionId: string | null;
  version: number;
  nodes: PlanNode[];
  relationships: PlanRelationship[];
  history: ProposalOperationRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentMapReadSnapshot {
  schemaVersion: typeof AGENT_MAP_PROPOSAL_SCHEMA_VERSION;
  project: StudioProjectSummary;
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
}

export type ProjectBootstrapErrorCode =
  | "session_not_ready"
  | "session_exited"
  | "injection_failed"
  | "model_turn_failed"
  | "delivery_timeout"
  | "persistence_failed"
  | "scope_unavailable";

export type ProjectBootstrapState =
  | { status: "pending" }
  | { status: "generating"; attemptId: string }
  | { status: "delivered"; messageId: string }
  | {
      status: "failed";
      retryable: boolean;
      errorCode: ProjectBootstrapErrorCode;
    }
  | {
      status: "skipped";
      reason: "user-proceeded" | "map-not-empty";
    };

/** @deprecated Persisted planner-era bootstrap error vocabulary. */
export type PlannerGreetingErrorCode = ProjectBootstrapErrorCode;

/** @deprecated Persisted planner-era bootstrap state. */
export type PlannerGreetingState =
  | Exclude<ProjectBootstrapState, { status: "skipped" }>
  | { status: "skipped"; reason: "user-proceeded" };

export interface PlannerSessionMetadata {
  identity: Extract<PlanningSessionIdentity, { role: "map-planner" }>;
  greeting: PlannerGreetingState;
  queuedInputIds: string[];
}

/**
 * Lifecycle context for the one automatic map seed owned by a newly created
 * project. It is deliberately separate from ProjectAgentSession authority.
 */
export interface ProjectBootstrapMetadata {
  projectId: StudioProjectId;
  userId: string;
  targetSessionId: string;
  bootstrap: ProjectBootstrapState;
  queuedInputIds: string[];
}

export interface ProjectBootstrapQueuedInput {
  id: string;
  sessionId: string;
  text: string;
  acceptedAt: string;
}

/**
 * Content-free receipt for input accepted by the durable bootstrap FIFO.
 * `uncertain` is terminal: Studio cannot prove whether that logical turn ran,
 * so it will never replay it automatically.
 */
export interface ProjectBootstrapInputReceipt {
  requestId: string | null;
  inputId: string;
  status: "queued" | "submitted" | "uncertain" | "completed";
  acceptedAt: string;
}

export type ProjectBootstrapRegistrationMode =
  | "boot"
  | "created"
  | "live"
  | "resumed";

/** Content-free lifecycle telemetry for project bootstrap reliability. */
export type ProjectBootstrapLifecycleEvent =
  | {
      name: "project_bootstrap.scheduled" | "project_bootstrap.recovered";
      projectId: StudioProjectId;
      sessionId: string;
    }
  | {
      name: "project_bootstrap.attempted" | "project_bootstrap.retried";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId: string;
      retryOrdinal: number;
      queueDepth: number;
    }
  | {
      name: "project_bootstrap.delivered";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId: string;
      queueDepth: number;
    }
  | {
      name: "project_bootstrap.failed";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId?: string;
      errorCode: ProjectBootstrapErrorCode;
      retryable: boolean;
      queueDepth: number;
    }
  | {
      name: "project_bootstrap.preempted" | "project_bootstrap.skipped";
      projectId: StudioProjectId;
      sessionId: string;
      attemptId?: string;
      reason: "user-proceeded" | "map-not-empty";
      queueDepth: number;
    }
  | {
      name: "project_bootstrap.input_delivery_uncertain";
      projectId: StudioProjectId;
      sessionId: string;
      inputId: string;
      errorCode: "delivery_uncertain";
      queueDepth: number;
    };

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
  /** Optional idempotency key while the durable bootstrap FIFO owns input. */
  requestId?: string;
}

/**
 * @deprecated Rolling planner-route response. The route now delegates to the
 * neutral project-bootstrap coordinator and never recreates planner identity.
 */
export interface PlannerSessionMetadataResponse {
  metadata: ProjectBootstrapMetadata | null;
  /** Present only when the durable bootstrap FIFO handled this request. */
  receipt?: ProjectBootstrapInputReceipt;
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
    }
  | {
      name: "planner_session.input_delivery_uncertain";
      projectId: StudioProjectId;
      sessionId: string;
      inputId: string;
      errorCode: "delivery_uncertain";
      queueDepth: number;
    };
