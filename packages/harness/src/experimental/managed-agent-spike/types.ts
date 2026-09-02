import type {
  Options,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

export type ManagedAgentModelTargetId = "sonnet-5" | "minimax-m3";
export type ManagedAgentProbeScenario = "L1" | "L2";

export interface ManagedAgentModelTarget {
  readonly id: ManagedAgentModelTargetId;
  readonly alias: string;
  readonly upstreamProvider: "anthropic" | "fireworks_ai";
  readonly upstreamModel: string;
}

/**
 * Explicit inputs for one experimental probe. The gateway credential is
 * sensitive and must never be copied into events, results, logs, or CLI args.
 */
export interface ManagedAgentProbeConfig {
  readonly scenario: ManagedAgentProbeScenario;
  readonly workspaceRoot: string;
  readonly configRoot: string;
  readonly target: ManagedAgentModelTargetId;
  readonly gatewayOrigin: string;
  readonly gatewayCredential: string;
  readonly prompt: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly allowedBashCommands: readonly string[];
  /** Exact prompt literals mapped to privacy-safe roles inside the host policy. */
  readonly pathRoleBindings: readonly ManagedAgentPathRoleBinding[];
  /** Trusted expected hashes for the two L1 mutation targets; empty for L2. */
  readonly expectedL1FinalBytes: readonly ManagedAgentL1ExpectedFileHash[];
  /** Expected only for L1 and never copied into structural evidence. */
  readonly expectedMcpNonce?: string;
  readonly preservePaths?: readonly string[];
}

export type ManagedAgentPermissionDecision = "allow" | "deny";
export type ManagedAgentPermissionReason =
  | "fixture_path"
  | "exact_bash_command"
  | "managed_mcp_tool"
  | "policy_aborted"
  | "invalid_input"
  | "path_outside_workspace"
  | "path_symlink_escape"
  | "path_role_not_allowed"
  | "bash_command_not_allowed"
  | "tool_not_allowed";

export type ManagedAgentPermissionSource =
  | "pre_tool_use"
  | "can_use_tool_fallback";

export type ManagedAgentRegisteredPathRole =
  | "clean_target"
  | "dirty_sentinel"
  | "untracked_sentinel"
  | "managed_output"
  | "outside_sentinel"
  | "escape_link";

export type ManagedAgentPathRole =
  | ManagedAgentRegisteredPathRole
  | "unregistered";

export interface ManagedAgentPathRoleBinding {
  /** Sensitive prompt literal; this value never crosses the evidence boundary. */
  readonly path: string;
  readonly role: ManagedAgentRegisteredPathRole;
}

export type ManagedAgentL1FinalByteRole = "clean_target" | "managed_output";

export interface ManagedAgentL1ExpectedFileHash {
  /** Sensitive fixture path; this value never crosses the evidence boundary. */
  readonly path: string;
  readonly role: ManagedAgentL1FinalByteRole;
  readonly sha256: string;
}

export interface ManagedAgentL1FinalByteObservation {
  readonly role: ManagedAgentL1FinalByteRole;
  readonly matched: boolean;
}

export type ManagedAgentOperationId =
  | `read:${ManagedAgentPathRole}`
  | `edit:${ManagedAgentPathRole}`
  | `write:${ManagedAgentPathRole}`
  | "bash:exact_command"
  | "bash:unregistered"
  | "mcp:echo_nonce"
  | "mcp:fail_once"
  | "mcp:managed"
  | "unknown";

export type ManagedAgentProbeEventType =
  | "lifecycle"
  | "message"
  | "tool_requested"
  | "tool_completed"
  | "permission"
  | "sdk_result"
  | "terminal";

/**
 * A deliberately content-free event boundary. Raw prompts, message text,
 * tool inputs/results, filesystem paths, and error messages never cross it.
 */
export interface ManagedAgentProbeEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly type: ManagedAgentProbeEventType;
  readonly subtype?: string;
  readonly sessionId?: string;
  readonly toolUseId?: string;
  readonly toolName?: string;
  readonly permissionDecision?: ManagedAgentPermissionDecision;
  readonly permissionReason?: ManagedAgentPermissionReason;
  readonly permissionSource?: ManagedAgentPermissionSource;
  readonly operationId?: ManagedAgentOperationId;
  readonly isError?: boolean;
  readonly terminal?: ManagedAgentTerminalClassification;
}

export interface ManagedAgentSdkUsageEstimate {
  readonly authority: "sdk_non_authoritative";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly estimatedCostUsd?: number;
}

/**
 * Content-free SDK evidence that the configured alias was also reported by
 * the running SDK. Gateway reconciliation remains authoritative for the
 * upstream provider/model and fallback state.
 */
export interface ManagedAgentSdkModelEvidence {
  readonly authority: "sdk_non_authoritative";
  readonly initModelObserved: boolean;
  readonly initModelMatchesExpectedAlias: boolean;
  readonly resultModelUsageObserved: boolean;
  readonly resultModelUsageMatchesExpectedAlias: boolean;
  readonly resultModelCount: number;
}

export interface ManagedAgentWorkspaceChange {
  readonly path: string;
  readonly change: "created" | "modified" | "deleted";
}

export interface ManagedAgentPreservationObservation {
  readonly path: string;
  readonly preserved: boolean;
}

export interface ManagedAgentToolEvidence {
  readonly toolUseId?: string;
  readonly toolName: string;
  readonly status: "requested" | "success" | "error";
}

export interface ManagedAgentPermissionEvidence {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly decision: ManagedAgentPermissionDecision;
  readonly reason: ManagedAgentPermissionReason;
  readonly source: ManagedAgentPermissionSource;
  /** Trusted, content-free operation identity; never contains a raw path/input. */
  readonly operationId: ManagedAgentOperationId;
}

export type ManagedAgentPreToolUseGuardRejectionReason =
  | "unexpected_hook_event"
  | "input_tool_use_id_missing"
  | "input_tool_use_id_invalid"
  | "input_tool_use_id_too_long"
  | "callback_tool_use_id_invalid"
  | "callback_tool_use_id_too_long"
  | "callback_tool_use_id_mismatch";

/**
 * Content-free policy diagnostics. They explain why strict hook coverage
 * failed, but never count as permission evidence and therefore cannot certify
 * a tool request as authorized.
 */
export type ManagedAgentPolicyDiagnostic =
  | {
      readonly kind: "pre_tool_use_guard_rejection";
      readonly reason: ManagedAgentPreToolUseGuardRejectionReason;
      readonly toolName: string;
      readonly correlatedRequest: boolean;
    }
  | {
      readonly kind: "missing_pre_tool_use_callback";
      readonly reason: "no_callback_observed";
      readonly toolName: string;
      readonly correlatedRequest: true;
    };

export type ManagedAgentEventNormalizationFailureReason =
  | "assistant_message_id_invalid"
  | "inference_turn_limit_exceeded"
  | "tool_request_id_invalid"
  | "tool_result_id_invalid"
  | "sdk_num_turns_invalid";

export type ManagedAgentQueryExecutionOutcome =
  | "not_started"
  | "construction_failed"
  | "iteration_completed"
  | "iteration_failed"
  | "iteration_aborted"
  | "event_normalization_failed";

export interface ManagedAgentTerminationEvidence {
  /** Terminal classification before the strict policy override is applied. */
  readonly beforePolicyOverride: ManagedAgentTerminalClassification;
  readonly queryExecution: ManagedAgentQueryExecutionOutcome;
  readonly sdkResult: "not_observed" | "success" | "error";
  readonly eventNormalizationFailure?: ManagedAgentEventNormalizationFailureReason;
}

export interface ManagedAgentTeardownObservation {
  readonly quiescent: boolean;
  readonly deadlineMet: boolean;
  /** False means ps/CIM observation was unknown, never an empty table. */
  readonly processTableAvailable: boolean;
  /** False means the owned E0 containment model was escaped or unproven. */
  readonly containmentSupported: boolean;
  /** True after SDK-root authority and any required L2 observations are proven. */
  readonly ownershipProven: boolean;
  /** True only when forced termination was requested for every owned root. */
  readonly forceKillIssued: boolean;
  /** True after both exact L2 fixture lifetime channels pass fresh observation. */
  readonly toolProcessObservationComplete: boolean;
  /** True only when both observed L2 lifetime channels have closed. */
  readonly toolProcessChannelsClosed: boolean;
  readonly elapsedMs: number;
  readonly observedPids: readonly number[];
  readonly alivePidsAtDeadline: readonly number[];
  readonly emergencyCleanupAttempted: boolean;
}

export type ManagedAgentTerminalClassification =
  | "success"
  | "cancelled"
  | "sdk_result_error"
  | "query_error"
  | "policy_violation"
  | "incomplete"
  | "close_timeout"
  | "teardown_timeout";

export interface ManagedAgentProbeResult {
  readonly contractVersion: 1;
  readonly runId: string;
  readonly scenario: ManagedAgentProbeScenario;
  readonly target: ManagedAgentModelTargetId;
  readonly modelAlias: string;
  readonly sdkModelEvidence: ManagedAgentSdkModelEvidence;
  readonly sdkSessionId?: string;
  /** Distinct, hashed assistant message IDs; authoritative for BQ call count. */
  readonly inferenceTurns: number;
  /** SDK result.num_turns; informational and not a gateway reconciliation key. */
  readonly sdkNumTurns?: number;
  /** False if any requested tool lacked exactly one primary PreToolUse decision. */
  readonly policyHookCoverage: boolean;
  readonly terminal: ManagedAgentTerminalClassification;
  readonly terminationEvidence: ManagedAgentTerminationEvidence;
  readonly events: readonly ManagedAgentProbeEvent[];
  readonly toolEvidence: readonly ManagedAgentToolEvidence[];
  readonly permissionEvidence: readonly ManagedAgentPermissionEvidence[];
  readonly policyDiagnostics: readonly ManagedAgentPolicyDiagnostic[];
  readonly workspaceChanges: readonly ManagedAgentWorkspaceChange[];
  readonly preservation: readonly ManagedAgentPreservationObservation[];
  readonly cancellationRequested: boolean;
  readonly queryClosed: boolean;
  readonly teardown: ManagedAgentTeardownObservation;
  readonly correlation: {
    readonly executionId: string;
    readonly evalSource: string;
    /** True only after the marked prompt is handed to the query factory. */
    readonly promptEmbedded: boolean;
  };
  /** Present only for an L1 prompt validated against the frozen v2 marker. */
  readonly l1Certification?: {
    readonly contractVersion: 2;
    readonly promptVersion: "managed-agent-l1-prompt-v2";
  };
  /** Content-free proof of exact final bytes for both intended L1 mutations. */
  readonly l1FinalBytes?: readonly ManagedAgentL1FinalByteObservation[];
  /** Content-free proof that echo_nonce received the expected sentinel nonce. */
  readonly nonceVerified?: boolean;
  readonly sdkUsage?: ManagedAgentSdkUsageEstimate;
}

/**
 * Deliberately excludes Agent SDK control-channel methods. In particular,
 * Query.mcpCall bypasses permission checks and is outside this host boundary.
 */
export interface ManagedAgentQuery extends AsyncIterable<unknown> {
  close(): void | Promise<void>;
  /** Pinned SDK Query.return() awaits its fire-and-forget close cleanup. */
  return?(value?: void): Promise<IteratorResult<unknown, void>>;
}

export type ManagedAgentQueryFactory = (input: {
  readonly prompt: string;
  readonly options: Options;
}) => ManagedAgentQuery;

export interface ManagedAgentProcessObserver {
  spawn(options: SpawnOptions): SpawnedProcess;
  /**
   * Adopt the runtime's one immutable monotonic teardown deadline before any
   * abort, Query.close(), or Query.return() operation may begin.
   */
  beginTeardown(deadline: ManagedAgentTeardownDeadline): void;
  /**
   * Arm the two host-authenticated lifetime observations used only by the
   * exact E0.4 L2 fixture. Tool-reported identities never grant authority by
   * themselves; the observer also requires fresh owned-root ancestry.
   */
  armToolProcessContainment(): void;
  /** Prove the narrow POSIX observation model before allowing L2 to cancel. */
  prepareCancellation(): Promise<ManagedAgentCancellationReadiness>;
  /** Sample only members owned by the host-observed process anchors. */
  observeProcessTree(deadline?: ManagedAgentTeardownDeadline): Promise<boolean>;
  waitForQuiescence(
    deadline: ManagedAgentTeardownDeadline,
  ): Promise<ManagedAgentTeardownObservation>;
  /** Idempotently run the anchored fallback and confirm before this deadline. */
  emergencyCleanup(
    deadline: ManagedAgentTeardownDeadline,
  ): Promise<ManagedAgentTeardownObservation>;
  dispose(): void | Promise<void>;
}

/**
 * One immutable monotonic deadline shared by SDK close/return and host process
 * containment. It is created once at the first teardown-relevant event and is
 * never extended from wall-clock time or a later cleanup phase.
 */
export interface ManagedAgentTeardownDeadline {
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
}

export type ManagedAgentCancellationReadinessReason =
  | "ready"
  | "platform_unsupported"
  | "process_table_unavailable"
  | "root_count_invalid"
  | "root_not_active"
  | "root_not_group_leader"
  | "tool_process_not_registered"
  | "tool_process_identity_invalid"
  | "containment_escaped";

export interface ManagedAgentCancellationReadiness {
  readonly supported: boolean;
  readonly reason: ManagedAgentCancellationReadinessReason;
  readonly processTableAvailable: boolean;
  readonly containmentSupported: boolean;
  readonly ownershipProven: boolean;
  readonly observedPids: readonly number[];
}

export interface ManagedAgentProbeDependencies {
  readonly queryFactory?: ManagedAgentQueryFactory;
  /**
   * Explicit test-only origin seam. It is accepted only alongside an injected
   * query factory and only for reserved .test or loopback origins.
   */
  readonly hermeticGatewayOrigin?: string;
  readonly processObserver?: ManagedAgentProcessObserver;
  readonly uuid?: () => string;
  /** Injectable monotonic clock; wall time is never cancellation authority. */
  readonly monotonicNow?: () => number;
  readonly waitForCancellationSignal?: (signal: AbortSignal) => Promise<void>;
  readonly policySettingsGuard?: (input: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly nodeExecutable?: string;
  }) => Promise<void>;
}
