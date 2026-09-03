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
export const AGENT_MAP_REVISION_SCHEMA_VERSION = 1 as const;

type AgentMapBrand<TBrand extends string> = string & {
  readonly __brand: TBrand;
};

/** Opaque, service-allocated identities. Callers must never derive these. */
export type PlanNodeId = AgentMapBrand<"PlanNodeId">;
export type PlanRelationshipId = AgentMapBrand<"PlanRelationshipId">;
export type MapProposalId = AgentMapBrand<"MapProposalId">;
export type ProposalOperationId = AgentMapBrand<"ProposalOperationId">;
export type AgentMapRevisionId = AgentMapBrand<"AgentMapRevisionId">;
export type AgentMapGraphDigest = AgentMapBrand<"AgentMapGraphDigest">;
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

const AGENT_MAP_ACTOR_KINDS = new Set<PlanNodeKind>(["agent", "subagent"]);
const AGENT_MAP_ALL_NODE_KINDS = new Set<PlanNodeKind>(PLAN_NODE_KINDS);

/** The single endpoint policy shared by proposal and revision validation. */
export const AGENT_MAP_RELATIONSHIP_ENDPOINT_MATRIX: Readonly<
  Record<
    RelationshipKind,
    { from: ReadonlySet<PlanNodeKind>; to: ReadonlySet<PlanNodeKind> }
  >
> = {
  invokes: { from: AGENT_MAP_ACTOR_KINDS, to: AGENT_MAP_ACTOR_KINDS },
  feeds: { from: AGENT_MAP_ALL_NODE_KINDS, to: AGENT_MAP_ACTOR_KINDS },
  reads: {
    from: AGENT_MAP_ACTOR_KINDS,
    to: new Set<PlanNodeKind>(["resource", "artifact"]),
  },
  writes: {
    from: AGENT_MAP_ACTOR_KINDS,
    to: new Set<PlanNodeKind>(["resource", "artifact"]),
  },
  uses: {
    from: AGENT_MAP_ACTOR_KINDS,
    to: new Set<PlanNodeKind>(["resource", "connector"]),
  },
  triggers: { from: AGENT_MAP_ALL_NODE_KINDS, to: AGENT_MAP_ACTOR_KINDS },
};

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

/** Minimal, content-free evidence binding one human approval to one source. */
export interface ArchitectureApproval {
  approvedProposalId: MapProposalId;
  approvedProposalVersion: number;
  approvingUserId: string;
  approvingSessionId: string;
  approvingMessageId: string;
  approvedAt: string;
}

/** Trusted host receipt; message text is deliberately never retained here. */
export interface PlannerUserMessageReceipt {
  messageId: string;
  projectId: StudioProjectId;
  userId: string;
  sessionId: string;
  origin: "human";
  acceptedAt: string;
}

/** Model-controlled confirmation input. All authority is service-derived. */
export interface ConfirmArchitectureRequest {
  schemaVersion: typeof AGENT_MAP_REVISION_SCHEMA_VERSION;
  requestId: string;
  proposalId: MapProposalId;
  expectedVersion: number;
  expectedDigest: AgentMapGraphDigest;
  approvingMessageId: string;
}

/** A bounded revision projection suitable for later architecture sources. */
export interface AgentMapRevisionRef {
  id: AgentMapRevisionId;
  revisionNumber: number;
  parentRevisionId: AgentMapRevisionId | null;
  digest: AgentMapGraphDigest;
  createdAt: string;
}

/** Immutable complete architecture snapshot. It is never an operation delta. */
export interface AgentMapRevision {
  schemaVersion: typeof AGENT_MAP_REVISION_SCHEMA_VERSION;
  id: AgentMapRevisionId;
  projectId: StudioProjectId;
  revisionNumber: number;
  parentRevisionId: AgentMapRevisionId | null;
  nodes: PlanNode[];
  relationships: PlanRelationship[];
  digest: AgentMapGraphDigest;
  approval: ArchitectureApproval;
  createdAt: string;
}

/** Confirmation returns identity and source evidence, never the full graph. */
export interface ConfirmArchitectureResult {
  schemaVersion: typeof AGENT_MAP_REVISION_SCHEMA_VERSION;
  outcome: "confirmed" | "replayed";
  approvedProposal: {
    id: MapProposalId;
    version: number;
    digest: AgentMapGraphDigest;
  };
  revision: AgentMapRevisionRef;
  workspaceRecordVersion: number;
}

export type ConfirmArchitectureFailure =
  | { code: "malformed_input"; recovery: "reread" }
  | { code: "stale_proposal"; recovery: "reread" }
  | { code: "proposal_digest_mismatch"; recovery: "reread" }
  | { code: "approval_message_invalid"; recovery: "ask_again" }
  | { code: "approval_message_reused"; recovery: "ask_again" }
  | { code: "request_id_reused"; recovery: "new_request" }
  | { code: "cross_project"; recovery: "reread" }
  | { code: "invalid_revision_chain"; recovery: "retry" }
  | { code: "storage_unavailable"; recovery: "retry" };

export type ConfirmArchitectureErrorCode = ConfirmArchitectureFailure["code"];
export type ConfirmArchitectureRecovery =
  ConfirmArchitectureFailure["recovery"];

export interface AgentMapReadSnapshot {
  schemaVersion: typeof AGENT_MAP_PROPOSAL_SCHEMA_VERSION;
  project: StudioProjectSummary;
  workspace: AgentMapWorkspaceState;
  proposal: MapChangeProposal | null;
}

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

/** Authoritative coordinator state returned after a planner mutation. */
export interface PlannerSessionMetadataResponse {
  metadata: PlannerSessionMetadata;
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
