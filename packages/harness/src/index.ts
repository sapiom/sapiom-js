/**
 * @sapiom/harness — library entry. The CLI (`sapiom-harness`) is the primary
 * interface; this export exists so other packages can reuse the contract.
 */

export * from "./shared/types.js";
export type {
  AgentMapInitializationError,
  AgentMapInitializationState,
  AgentMapInitializationStatus,
} from "./shared/agent-map-initialization.js";
export {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  EXECUTION_MODES,
  PLAN_NODE_KINDS,
  RELATIONSHIP_KINDS,
} from "./shared/agent-map.js";
export type {
  AcceptedProposalDelta,
  ExecutionMode,
  MapOperation,
  MapProposalId,
  PlanNode,
  PlanNodeChanges,
  PlanNodeId,
  PlanNodeKind,
  PlanRelationship,
  PlanRelationshipId,
  AgentMapVersion,
  AgentMapVersionId,
  AgentMapVersionRef,
  AgentMapGraph,
  GraphContentDigest,
  ProjectAgentActorRef,
  ProjectMutationOrigin,
  ProjectVersionChangeKind,
  RecordDigest,
  RoleNeutralMapOperationRecord,
  ProjectAgentSession,
  ProjectBootstrapInputReceipt,
  ProjectBootstrapMetadata,
  ProjectBootstrapState,
  ProposalActor,
  ProposalOperationId,
  RelationshipChanges,
  RelationshipKind,
  StudioProjectId,
} from "./shared/agent-map.js";
export {
  canonicalJson,
  canonicalizeAgentMapGraph,
  computeAgentMapVersionRecordDigest,
  computeArchitectureGraphDigest,
  computeGraphContentDigest,
} from "./shared/agent-map-canonical.js";
export {
  AGENT_BRIEF_COMPILER_VERSION,
  AGENT_BRIEF_FINGERPRINT_KINDS,
  BUILD_PLAN_SCHEMA_VERSION,
  PROJECT_PLANNING_STORAGE_SCHEMA_VERSION,
  emptyProjectBuildPlanContent,
  agentMapVersionRefsEqual,
  projectBuildPlanVersionRefsEqual,
} from "./shared/build-plan.js";
export {
  PROJECT_SUBSESSION_CLAIM_TTL_MS,
  PROJECT_SUBSESSION_DELEGATION_LIMIT,
  PROJECT_SUBSESSION_KEY_BYTES,
  PROJECT_SUBSESSION_KICKOFF_CONTEXT_BYTES,
  PROJECT_SUBSESSION_OUTCOME_BYTES,
  PROJECT_SUBSESSION_REQUEST_BYTES,
  PROJECT_SUBSESSION_SCHEMA_VERSION,
  SUBSESSION_COORDINATOR_STORAGE_SCHEMA_VERSION,
} from "./shared/subsession-delegation.js";
export type {
  CanonicalDelegationBindingDigest,
  CanonicalDelegationRequestDigest,
  DelegatedContextState,
  DelegatedKickoffState,
  DelegatedSessionState,
  DelegationError,
  DelegationErrorCode,
  DelegationFocusRef,
  DelegationItemOutcome,
  DelegationItemResult,
  DelegationRecovery,
  ProjectSubsessionDelegation,
  ProjectSubsessionRequest,
  ProjectSubsessionResult,
  SubsessionBindingId,
  SubsessionBindingRecord,
  SubsessionClaim,
  SubsessionContextDigest,
  SubsessionKickoffDelivery,
  SubsessionProjectionDigest,
  SubsessionRuntimeBinding,
} from "./shared/subsession-delegation.js";
export {
  computeCanonicalDelegationBindingDigest,
  computeCanonicalDelegationRequestDigest,
  computeSubsessionContextDigest,
  parseProjectSubsessionRequest,
  SubsessionDelegationValidationError,
} from "./shared/subsession-delegation-codec.js";
export {
  canonicalWorkstreamScopes,
  canonicalizeAgentBriefFocusScope,
  computeAgentBriefId,
  computeAgentBriefScopeKey,
} from "./shared/agent-brief.js";
export type {
  AgentBriefFocusSelection,
  AgentBriefRefreshRequest,
  AgentBriefRefreshReceipt,
  AgentBriefRefreshResult,
  CompileAgentBriefsRequest,
  CompileAgentBriefsResult,
  CompiledAgentBriefCandidate,
  PreviousAgentBrief,
} from "./shared/agent-brief.js";
export type {
  AgentBriefContent,
  AgentBriefDependencyFingerprint,
  AgentBriefDisposition,
  AgentBriefFingerprintKind,
  AgentBriefFocusScope,
  AgentBriefHistoryPointer,
  AgentBriefId,
  AgentBriefImpact,
  AgentBriefImpactEntry,
  AgentBriefScopeKey,
  AgentBriefSemanticDigest,
  AgentBriefStaleReason,
  AgentBriefStaleReasonCode,
  AgentBriefVersion,
  AgentBriefVersionRecord,
  AgentBriefVersionId,
  AgentBriefVersionRef,
  ArchitectureSourceRef,
  BuildPlanDependencyId,
  BuildPlanDependencyIntent,
  BuildPlanId,
  BuildPlanAssignmentIntent,
  BuildPlanCurrentPointers,
  BuildPlanDecision,
  BuildPlanDiagnostic,
  BuildPlanHistorySummary,
  BuildPlanIdMapping,
  BuildPlanMilestone,
  BuildPlanReadResult,
  BuildPlanReadSelector,
  BuildPlanRepositoryIntent,
  BuildPlanRisk,
  BuildPlanSemanticDigest,
  BuildPlanSequenceGate,
  MilestoneId,
  PlanDecisionId,
  PlanRiskId,
  PlanningAssignmentId,
  ProjectBuildPlanContent,
  ProjectBuildPlanId,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionId,
  ProjectBuildPlanVersionRef,
  ProjectMutationReceipt,
  ProjectMutationTombstone,
  SequenceGateId,
} from "./shared/build-plan.js";
export {
  parseAgentBriefFocusScope,
  parseAgentBriefVersion,
  parseAgentBriefVersionRef,
  parseAgentMapVersionRef,
  parseBuildPlanCurrentPointers,
  parseProjectBuildPlanContent,
  parseProjectBuildPlanVersion,
  parseProjectBuildPlanVersionRef,
} from "./shared/build-plan-codec.js";
export {
  agentBriefSemanticProjection,
  buildPlanSemanticProjection,
  canonicalizeProjectBuildPlanContent,
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanRequestDigest,
  computeBuildPlanSemanticDigest,
} from "./core/build-plan-canonicalization.js";
export {
  AGENT_BRIEF_COMPILER_DIAGNOSTIC_LIMIT,
  DeterministicAgentBriefCompiler,
  compileAgentBriefs,
  compileCanonicalWorkstreamBriefs,
  projectFocusedBriefs,
} from "./core/agent-brief-compiler.js";
export {
  AGENT_BRIEF_IMPACT_ENTRY_LIMIT,
  AGENT_BRIEF_IMPACT_EVIDENCE_LIMIT,
  evaluateAgentBriefImpact,
} from "./core/build-plan-impact-evaluator.js";
export {
  AgentBriefService,
  AgentBriefServiceError,
} from "./core/agent-brief-service.js";
export type {
  AgentBriefServiceErrorCode,
  AgentBriefServiceOptions,
} from "./core/agent-brief-service.js";
export {
  FOCUSED_SESSION_CONTEXT_MAX_BYTES,
  FOCUSED_SESSION_CONTEXT_MAX_LIST_LENGTH,
  FOCUSED_SESSION_CONTEXT_MAX_STRING_LENGTH,
  serializeFocusedSessionContext,
} from "./core/focused-session-context.js";
export type {
  FocusedSessionContextProjection,
  FocusedSessionContextResult,
} from "./core/focused-session-context.js";
export {
  PROJECT_AGENT_PROMPT_APPENDIX,
  projectAgentPromptAppendix,
} from "./profiles/project-agent.js";
export type { WorkspaceScopeSummary } from "./shared/system-graph.js";
export { AGENT_STUDIO_PRODUCT_NAME } from "./shared/branding.js";
export {
  HarnessError,
  UnknownSessionError,
  SessionNotReadyError,
  SessionNotResumeableError,
  SessionAlreadyLiveError,
  SubsessionBindingMismatchError,
  SubsessionFreshRestartForbiddenError,
  AdapterNotFoundError,
  ExternalHarnessError,
  SpawnTargetError,
} from "./core/errors.js";
export {
  listHarnessAdapters,
  getHarnessAdapter,
  createHarnessAdapterRegistry,
  UnknownHarnessAdapterError,
} from "./core/adapters/registry.js";
export type {
  HarnessAdapterInfo,
  HarnessAdapterId,
  HarnessAdapterMode,
  EmbeddedHarnessAdapterInfo,
  ExternalHarnessAdapterInfo,
} from "./core/adapters/adapter.js";

// Embedding surface (SAP: harness-desktop) — lets a second host (the Electron
// app) reuse the exact server + setup flow the CLI (`bin.ts`) runs, instead of
// forking it. `ensureConsent`/`printDoctorReport` are intentionally NOT exported:
// they are TTY-shaped, and a native host supplies `telemetryOptIn`/`consentSource`
// to `startServer` directly — which is why `saveSettings` is exported too: a
// native host that prompts for consent itself must persist the answer the way
// `ensureConsent` does, or the settings file (the source of truth for the UI's
// analytics chip and for the next launch) never learns about it.
export { startServer } from "./server/index.js";
export type { HarnessServer, HarnessServerOptions } from "./server/index.js";
export {
  runDoctor,
  pickDefaultHarness,
  CLAUDE_INSTALL_COMMAND,
  CODEX_INSTALL_COMMAND,
} from "./cli/doctor.js";
export type { DoctorReport } from "./cli/doctor.js";
export { ensureAuthenticated } from "./cli/auth.js";
export type { HarnessIdentity } from "./cli/auth.js";
export { getOrCreateMachineId } from "./cli/machine-id.js";
export { ensureSpawnHelperExecutable } from "./core/session-manager.js";
// Exported so a host can spawn a pty the same way the harness does — Windows
// cannot launch a bare command name or a .cmd shim directly (see the module).
export { resolveSpawnTarget } from "./core/spawn-target.js";
export type { SpawnTarget } from "./core/spawn-target.js";
// Lets a host point the claude-code adapter at a different binary. Used by the
// desktop app's --smoke mode to create a REAL session against a stub agent, so
// per-OS session coverage doesn't require Claude Code installed on a CI runner.
export { createClaudeCodeAdapter } from "./core/adapters/claude-code.js";
export { createCodexAdapter } from "./core/adapters/codex.js";
export {
  loadSettings,
  saveSettings,
  recordRecentDir,
  hasStoredSettings,
} from "./cli/settings.js";
