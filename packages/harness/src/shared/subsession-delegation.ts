import type {
  AgentMapVersionRef,
  PlanNodeId,
  StudioProjectId,
} from "./agent-map.js";
import type {
  AgentBriefVersionRef,
  PlanningAssignmentId,
  ProjectBuildPlanVersionRef,
} from "./build-plan.js";

export const PROJECT_SUBSESSION_SCHEMA_VERSION = 1 as const;
export const SUBSESSION_COORDINATOR_STORAGE_SCHEMA_VERSION = 1 as const;

export const PROJECT_SUBSESSION_DELEGATION_LIMIT = 16;
export const PROJECT_SUBSESSION_KEY_BYTES = 128;
export const PROJECT_SUBSESSION_OUTCOME_BYTES = 4 * 1_024;
export const PROJECT_SUBSESSION_KICKOFF_CONTEXT_BYTES = 16 * 1_024;
export const PROJECT_SUBSESSION_REQUEST_BYTES = 64 * 1_024;
export const PROJECT_SUBSESSION_CLAIM_TTL_MS = 120_000;

type Brand<TBrand extends string> = string & { readonly __brand: TBrand };

export type CanonicalDelegationRequestDigest =
  Brand<"CanonicalDelegationRequestDigest">;
export type CanonicalDelegationBindingDigest =
  Brand<"CanonicalDelegationBindingDigest">;
export type SubsessionBindingId = Brand<"SubsessionBindingId">;
export type SubsessionContextDigest = Brand<"SubsessionContextDigest">;
export type SubsessionProjectionDigest = Brand<"SubsessionProjectionDigest">;

export type DelegationFocusRef =
  | Readonly<{
      kind: "assignment";
      map: AgentMapVersionRef;
      plan: ProjectBuildPlanVersionRef;
      assignmentId: PlanningAssignmentId;
    }>
  | Readonly<{
      kind: "map-node";
      map: AgentMapVersionRef;
      plan: ProjectBuildPlanVersionRef | null;
      nodeId: PlanNodeId;
    }>
  | Readonly<{
      kind: "brief";
      brief: AgentBriefVersionRef;
    }>;

export type ProjectSubsessionDelegation = Readonly<{
  delegationKey: string;
  outcome: string;
  kickoffContext?: string;
  focus?: DelegationFocusRef;
}>;

export type ProjectSubsessionRequest = Readonly<{
  schemaVersion: typeof PROJECT_SUBSESSION_SCHEMA_VERSION;
  requestKey: string;
  operation:
    | Readonly<{
        kind: "delegate";
        delegations: readonly ProjectSubsessionDelegation[];
      }>
    | Readonly<{
        kind: "refresh-focused-context";
        target:
          | Readonly<{ kind: "self" }>
          | Readonly<{ kind: "child"; delegationKey: string }>;
        expectedContextEpoch: number;
        expectedContextDigest: SubsessionContextDigest;
        focus: DelegationFocusRef | null;
      }>;
}>;

export type DelegationErrorCode =
  | "invalid_capability"
  | "expired_capability"
  | "revoked_capability"
  | "capability_scope_mismatch"
  | "invalid_request"
  | "unsupported_schema"
  | "capacity_exceeded"
  | "request_key_reused"
  | "storage_unavailable"
  | "internal_error"
  | "delegation_key_reused"
  | "context_not_found"
  | "context_stale"
  | "context_refresh_conflict"
  | "binding_session_mismatch"
  | "session_incompatible"
  | "session_unreachable"
  | "session_closed"
  | "adapter_unavailable"
  | "adapter_identity_ambiguous"
  | "session_create_failed"
  | "session_restart_failed"
  | "readiness_timeout"
  | "kickoff_failed";

export type DelegationRecovery =
  | "none"
  | "correct"
  | "retry"
  | "reread"
  | "refresh_context"
  | "inspect_session"
  | "new_request_key"
  | "new_delegation_key"
  | "reduce_request";

export type DelegationError = Readonly<{
  code: DelegationErrorCode;
  retryable: boolean;
  recovery: DelegationRecovery;
  issues?: readonly Readonly<{ path: string; code: string }>[];
}>;

export type DelegatedSessionState =
  | "reserved"
  | "spawn-claimed"
  | "starting"
  | "awaiting-ready"
  | "ready"
  | "exited"
  | "failed"
  | "closed";

export type DelegatedContextState =
  | "none"
  | "current"
  | "stale"
  | "refreshing";

export type DelegatedKickoffState =
  | "pending"
  | "claimed"
  | "submitted-unacknowledged"
  | "acknowledged"
  | "uncertain";

export type DelegationItemOutcome =
  | "created"
  | "reused"
  | "already-running"
  | "failed";

export type DelegationItemResult = Readonly<{
  delegationKey: string;
  bindingId: SubsessionBindingId | null;
  sessionId: string | null;
  outcome: DelegationItemOutcome;
  sessionState: DelegatedSessionState;
  contextState: DelegatedContextState;
  kickoffState: DelegatedKickoffState;
  error?: DelegationError;
}>;

export type ProjectSubsessionResult = Readonly<{
  schemaVersion: typeof PROJECT_SUBSESSION_SCHEMA_VERSION;
  requestKey: string;
  requestDigest: CanonicalDelegationRequestDigest;
  replayed: boolean;
  results: readonly DelegationItemResult[];
}>;

export type SubsessionClaim = Readonly<{
  claimId: string;
  ownerId: string;
  claimedAt: string;
  expiresAt: string;
}>;

export type SubsessionRuntimeBinding = Readonly<{
  runtimeToken: string;
  incarnation: number;
  spawnEpoch: number;
}>;

export type SubsessionKickoffDelivery = Readonly<{
  contextEpoch: number;
  deliveryId: string;
  inputId: string;
  eventWatermark: string | null;
  state: DelegatedKickoffState;
  attempt: number;
  claim: SubsessionClaim | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
}>;

/**
 * Durable coordinator ownership. The private SessionManager marker added by
 * the runtime slice must match project, parent, binding, session, and
 * incarnation before this record authorizes any session mutation.
 */
export type SubsessionBindingRecord = Readonly<{
  bindingId: SubsessionBindingId;
  projectId: StudioProjectId;
  parentSessionId: string;
  delegationKey: string;
  bindingDigest: CanonicalDelegationBindingDigest;
  outcome: string;
  kickoffContext: string | null;
  initialFocus: DelegationFocusRef | null;
  sessionId: string;
  harness: "claude-code" | "codex";
  projectRoot: string;
  lifecycleEpoch: number;
  spawnEpoch: number;
  contextEpoch: number;
  contextDigest: SubsessionContextDigest;
  contextState: DelegatedContextState;
  currentFocus: DelegationFocusRef | null;
  projectionDigest: SubsessionProjectionDigest | null;
  sessionState: DelegatedSessionState;
  spawnClaim: SubsessionClaim | null;
  runtime: SubsessionRuntimeBinding | null;
  deliveries: readonly SubsessionKickoffDelivery[];
  lastError: DelegationError | null;
  createdAt: string;
  updatedAt: string;
}>;

