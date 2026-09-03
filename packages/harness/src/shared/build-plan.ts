import type {
  MapProposalId,
  PlanNodeId,
  PlanRelationshipId,
  ProposalOperationId,
  StudioProjectId,
} from "./agent-map.js";

export const BUILD_PLAN_SCHEMA_VERSION = 1 as const;
export const BUILD_PLANNING_AGGREGATE_SCHEMA_VERSION = 1 as const;
export const BUILD_PLAN_ID_MAPPING_LIMIT = 128;
export const BUILD_PLAN_VERSION_HISTORY_LIMIT = 1_024;
export const AGENT_BRIEF_VERSION_HISTORY_LIMIT = 1_024;
export const PLANNING_SUBMISSION_HISTORY_LIMIT = 1_024;

type BuildPlanBrand<T, TBrand extends string> = T & {
  readonly __brand: TBrand;
};

export type BuildPlanId = BuildPlanBrand<string, "BuildPlanId">;
export type BuildPlanVersion = BuildPlanBrand<number, "BuildPlanVersion">;
export type BuildPlanSemanticDigest = BuildPlanBrand<
  string,
  "BuildPlanSemanticDigest"
>;
export type AgentBriefId = BuildPlanBrand<string, "AgentBriefId">;
export type AgentBriefVersion = BuildPlanBrand<number, "AgentBriefVersion">;
export type AgentBriefSemanticDigest = BuildPlanBrand<
  string,
  "AgentBriefSemanticDigest"
>;
export type PlanningAssignmentId = BuildPlanBrand<
  string,
  "PlanningAssignmentId"
>;
export type BuilderPlanningSubmissionId = BuildPlanBrand<
  string,
  "BuilderPlanningSubmissionId"
>;
export type AgentMapRevisionId = BuildPlanBrand<string, "AgentMapRevisionId">;
export type PlanContractId = BuildPlanBrand<string, "PlanContractId">;
export type MilestoneId = BuildPlanBrand<string, "MilestoneId">;
export type DeliverableId = BuildPlanBrand<string, "DeliverableId">;
export type AcceptanceCriterionId = BuildPlanBrand<
  string,
  "AcceptanceCriterionId"
>;
export type PlanDecisionId = BuildPlanBrand<string, "PlanDecisionId">;
export type BriefDependencyId = BuildPlanBrand<string, "BriefDependencyId">;
export type GraphDigest = BuildPlanBrand<string, "GraphDigest">;
export type RecordDigest = BuildPlanBrand<string, "RecordDigest">;
export type PlanningSubmissionDigest = BuildPlanBrand<
  string,
  "PlanningSubmissionDigest"
>;
export type BuilderBootstrapDigest = BuildPlanBrand<
  string,
  "BuilderBootstrapDigest"
>;
export type ImpactDigest = BuildPlanBrand<string, "ImpactDigest">;
export type PlanningFanoutApprovalId = BuildPlanBrand<
  string,
  "PlanningFanoutApprovalId"
>;
export type PlanningFanoutApprovalDigest = BuildPlanBrand<
  string,
  "PlanningFanoutApprovalDigest"
>;
export type BuilderPlanningSessionBindingId = BuildPlanBrand<
  string,
  "BuilderPlanningSessionBindingId"
>;
export type BuilderKickoffId = BuildPlanBrand<string, "BuilderKickoffId">;

export type ArchitectureSourceRef =
  | Readonly<{
      kind: "proposal";
      proposalId: MapProposalId;
      version: number;
      graphDigest: GraphDigest;
    }>
  | Readonly<{
      kind: "revision";
      revisionId: AgentMapRevisionId;
      revisionNumber: number;
      graphDigest: GraphDigest;
    }>;

/** Compare exact source identities without depending on object property order. */
export function architectureSourceRefsEqual(
  left: ArchitectureSourceRef,
  right: ArchitectureSourceRef,
): boolean {
  if (left.kind !== right.kind || left.graphDigest !== right.graphDigest)
    return false;
  if (left.kind === "proposal" && right.kind === "proposal")
    return (
      left.proposalId === right.proposalId && left.version === right.version
    );
  if (left.kind === "revision" && right.kind === "revision")
    return (
      left.revisionId === right.revisionId &&
      left.revisionNumber === right.revisionNumber
    );
  return false;
}

export interface BuildPlanRef {
  planId: BuildPlanId;
  version: BuildPlanVersion;
  semanticDigest: BuildPlanSemanticDigest;
}

export interface AgentBriefRef {
  briefId: AgentBriefId;
  version: AgentBriefVersion;
  semanticDigest: AgentBriefSemanticDigest;
}

export interface PlanningAssignmentRef {
  assignmentId: PlanningAssignmentId;
  briefId: AgentBriefId;
  plannedAgentId: PlanNodeId;
}

/** Trusted, path-free identity carried into a future builder planning session. */
export interface BuilderPlanningContextRef {
  projectId: StudioProjectId;
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  brief: AgentBriefRef;
  assignment: PlanningAssignmentRef;
}

export interface PlanningActorRef {
  userId: string;
  sessionId: string;
  role: "map-planner" | "agent-builder";
}

export interface ProjectOutcome {
  summary: string;
}

export interface BuildMilestone {
  milestoneId: MilestoneId;
  ordinal: number;
  title: string;
  outcome: string;
  dependsOn: readonly MilestoneId[];
}

export interface PlanConstraint {
  constraintId: string;
  description: string;
  required: boolean;
}

export interface RepositoryIntent {
  repositoryIntentId: string;
  plannedAgentId: PlanNodeId;
  action: "create" | "bind" | "reuse";
  repositoryName: string;
  notes: string;
}

export interface AcceptanceCriterion {
  criterionId: AcceptanceCriterionId;
  ordinal: number;
  description: string;
  verification: string;
}

export interface PlanDecision {
  decisionId: PlanDecisionId;
  question: string;
  required: boolean;
  status: "open" | "resolved";
  resolution: string | null;
}

export interface BriefDeliverable {
  deliverableId: DeliverableId;
  description: string;
  artifactNodeIds: readonly PlanNodeId[];
  acceptanceCriterionIds: readonly AcceptanceCriterionId[];
}

export interface AgentAssignmentIntent {
  plannedAgentId: PlanNodeId;
  mission: string;
  scope: Readonly<{ inScope: readonly string[]; nonGoals: readonly string[] }>;
  deliverables: readonly BriefDeliverable[];
  constraints: readonly PlanConstraint[];
  acceptanceCriteria: readonly AcceptanceCriterion[];
  milestoneIds: readonly MilestoneId[];
  unresolvedDecisions: readonly PlanDecision[];
}

export interface ProjectBuildPlanVersion {
  schemaVersion: typeof BUILD_PLAN_SCHEMA_VERSION;
  projectId: StudioProjectId;
  planId: BuildPlanId;
  version: BuildPlanVersion;
  parentVersion: BuildPlanVersion | null;
  changeKind:
    | "created"
    | "edited"
    | "recompiled"
    | "source-rebound"
    | "restored";
  source: ArchitectureSourceRef;
  outcome: ProjectOutcome;
  milestones: readonly BuildMilestone[];
  sharedConstraints: readonly PlanConstraint[];
  repositoryIntents: readonly RepositoryIntent[];
  integrationCriteria: readonly AcceptanceCriterion[];
  assignments: readonly AgentAssignmentIntent[];
  unresolvedDecisions: readonly PlanDecision[];
  semanticDigest: BuildPlanSemanticDigest;
  recordDigest: RecordDigest;
  authoredBy: PlanningActorRef;
  createdAt: string;
}

export interface BriefContractPort {
  contractId: PlanContractId;
  nodeId: PlanNodeId;
  relationshipIds: readonly PlanRelationshipId[];
  executionModes?: readonly import("./agent-map.js").ExecutionMode[];
  description: string;
}

export interface BriefDependency {
  dependencyId: BriefDependencyId;
  kind:
    | "consumes-output"
    | "provides-input"
    | "shared-resource"
    | "sequence-gate"
    | "coordination";
  direction: "upstream" | "downstream" | "bidirectional";
  counterpartAgentId: PlanNodeId;
  relationshipIds: readonly PlanRelationshipId[];
  contractIds: readonly PlanContractId[];
  requiredByMilestoneIds: readonly MilestoneId[];
  blocking: boolean;
  description: string;
}

export type DependencyFingerprintKind =
  | "owned-nodes"
  | "relevant-nodes"
  | "input-contracts"
  | "output-contracts"
  | "cross-agent-relationships"
  | "shared-resources"
  | "milestones"
  | "shared-plan-content"
  | "assignment-content";

export interface DependencyFingerprint {
  kind: DependencyFingerprintKind;
  digest: string;
  nodeIds: readonly PlanNodeId[];
  relationshipIds: readonly PlanRelationshipId[];
  contractIds: readonly PlanContractId[];
}

export interface BriefChangeProtocol {
  proposeArchitectureChanges: boolean;
  instructions: readonly string[];
}

export interface AgentBriefVersionRecord {
  schemaVersion: typeof BUILD_PLAN_SCHEMA_VERSION;
  projectId: StudioProjectId;
  briefId: AgentBriefId;
  version: AgentBriefVersion;
  parentVersion: AgentBriefVersion | null;
  plannedAgentId: PlanNodeId;
  assignmentId: PlanningAssignmentId;
  plan: BuildPlanRef;
  source: ArchitectureSourceRef;
  mission: string;
  scope: Readonly<{ inScope: readonly string[]; nonGoals: readonly string[] }>;
  ownedNodeIds: readonly PlanNodeId[];
  relevantNodeIds: readonly PlanNodeId[];
  inputs: readonly BriefContractPort[];
  outputs: readonly BriefContractPort[];
  dependencies: readonly BriefDependency[];
  deliverables: readonly BriefDeliverable[];
  acceptanceCriteria: readonly AcceptanceCriterion[];
  constraints: readonly PlanConstraint[];
  milestones: readonly MilestoneId[];
  unresolvedDecisions: readonly PlanDecision[];
  changeProtocol: BriefChangeProtocol;
  compilerVersion: string;
  dependencyFingerprints: readonly DependencyFingerprint[];
  semanticDigest: AgentBriefSemanticDigest;
  recordDigest: RecordDigest;
  authoredBy: PlanningActorRef;
  createdAt: string;
}

export interface BuildPlanDiagnostic {
  code:
    | "missing-agent-assignment"
    | "unknown-node-reference"
    | "cross-project-reference"
    | "missing-brief"
    | "incompatible-contract-direction"
    | "ambiguous-contract-direction"
    | "ownership-cycle"
    | "multiple-top-level-owners"
    | "dangling-ownership"
    | "authored-architecture-conflict"
    | "brief-mission-missing"
    | "brief-scope-missing"
    | "brief-non-goals-suspicious"
    | "brief-deliverable-missing"
    | "brief-acceptance-criterion-missing"
    | "brief-change-protocol-missing"
    | "bootstrap-limit-exceeded"
    | "invalid-dependency"
    | "unresolved-required-decision"
    | "source-not-found"
    | "source-digest-mismatch";
  severity: "error" | "warning";
  path: string;
  message: string;
  relatedIds: readonly string[];
}

export interface BriefStaleReason {
  code:
    | "source-changed"
    | "agent-added"
    | "agent-removed"
    | "ownership-changed"
    | "contract-changed"
    | "relationship-changed"
    | "relevant-node-changed"
    | "shared-plan-content-changed"
    | "assignment-content-changed";
  affectedNodeIds: readonly PlanNodeId[];
  affectedRelationshipIds: readonly PlanRelationshipId[];
  affectedContractIds: readonly PlanContractId[];
  previousFingerprint?: string;
  currentFingerprint?: string;
}

export type BuildPlanCompleteness = Readonly<{
  status: "incomplete" | "complete";
  issues: readonly BuildPlanDiagnostic[];
}>;

export type BriefFreshness = Readonly<{
  status: "current" | "stale";
  evaluatedAgainst: ArchitectureSourceRef;
  reasons: readonly BriefStaleReason[];
}>;

export interface PlanNodeSummary {
  id: PlanNodeId;
  kind: import("./agent-map.js").PlanNodeKind;
  name: string;
  purpose: string;
  ownerAgentId: PlanNodeId | null;
  contractRefs: readonly string[];
}

export interface BuildMilestoneSummary {
  milestoneId: MilestoneId;
  ordinal: number;
  title: string;
  outcome: string;
  dependsOn: readonly MilestoneId[];
}

export interface FocusedAgentBriefProjection {
  mission: string;
  scope: Readonly<{ inScope: readonly string[]; nonGoals: readonly string[] }>;
  inputs: readonly BriefContractPort[];
  outputs: readonly BriefContractPort[];
  dependencies: readonly BriefDependency[];
  deliverables: readonly BriefDeliverable[];
  acceptanceCriteria: readonly AcceptanceCriterion[];
  constraints: readonly PlanConstraint[];
  repositoryIntents: readonly RepositoryIntent[];
  unresolvedDecisions: readonly PlanDecision[];
  changeProtocol: BriefChangeProtocol;
}

export interface BuilderBootstrapContext {
  schemaVersion: 1;
  compilerVersion: string;
  assignmentId: PlanningAssignmentId;
  plannedAgentId: PlanNodeId;
  architectureSource: ArchitectureSourceRef;
  plan: BuildPlanRef;
  brief: AgentBriefRef;
  contextDigest: BuilderBootstrapDigest;
  project: Readonly<{
    outcome: string;
    relevantMilestones: readonly BuildMilestoneSummary[];
    sharedConstraints: readonly PlanConstraint[];
    integrationCriteria: readonly AcceptanceCriterion[];
  }>;
  architecture: Readonly<{
    agent: PlanNodeSummary;
    ownedNodes: readonly PlanNodeSummary[];
    relevantNodes: readonly PlanNodeSummary[];
    contracts: readonly BriefContractPort[];
  }>;
  assignment: FocusedAgentBriefProjection;
}

export interface AssignmentImpact {
  plannedAgentId: PlanNodeId;
  assignmentId: PlanningAssignmentId | null;
  briefId: AgentBriefId | null;
  disposition:
    | "added"
    | "removed"
    | "stale"
    | "preserved"
    | "presentation-refreshed";
  reasons: readonly BriefStaleReason[];
}

export interface BuildPlanImpactResult {
  from: Readonly<{ source: ArchitectureSourceRef; plan: BuildPlanRef }>;
  to: Readonly<{ source: ArchitectureSourceRef; plan: BuildPlanRef }>;
  assignmentChanges: readonly AssignmentImpact[];
  staleBriefIds: readonly AgentBriefId[];
  preservedBriefIds: readonly AgentBriefId[];
  addedAgentIds: readonly PlanNodeId[];
  removedAgentIds: readonly PlanNodeId[];
  changedNodeIds: readonly PlanNodeId[];
  changedRelationshipIds: readonly PlanRelationshipId[];
  changedContractIds: readonly PlanContractId[];
  semanticChange: boolean;
  digest: ImpactDigest;
}

export interface CompiledBriefCandidate {
  plannedAgentId: PlanNodeId;
  assignmentId: PlanningAssignmentId;
  existingBriefRef: AgentBriefRef | null;
  disposition:
    | "created"
    | "new-version"
    | "source-rebound"
    | "unchanged"
    | "retired";
  brief: AgentBriefVersionRecord;
  bootstrap: BuilderBootstrapContext;
}

export interface CompileAgentBriefsRequest {
  projectId: StudioProjectId;
  source: ArchitectureSourceRef;
  graph: import("./agent-map.js").AgentMapGraph;
  plan: ProjectBuildPlanVersion;
  /** Stable identities are resolved by the calling orchestration boundary. */
  assignments?: readonly PlanningAssignmentRef[];
  previous?: Readonly<{
    plan: ProjectBuildPlanVersion;
    graph: import("./agent-map.js").AgentMapGraph;
    briefs: readonly AgentBriefVersionRecord[];
    /** Exact bounded aggregate lineage against which historical briefs bind. */
    allowedPlanRefs?: readonly BuildPlanRef[];
  }>;
}

export interface CompileAgentBriefsResult {
  plan: BuildPlanRef;
  source: ArchitectureSourceRef;
  briefs: readonly CompiledBriefCandidate[];
  impact: BuildPlanImpactResult;
  completeness: BuildPlanCompleteness;
  eligibility: BuildPlanEligibility;
  diagnostics: readonly BuildPlanDiagnostic[];
}

export type EligibilityReason =
  | "plan-incomplete"
  | "brief-missing"
  | "brief-stale"
  | "source-not-confirmed";

export type BuildPlanEligibility = Readonly<{
  planningEligible: boolean;
  implementationEligible: boolean;
  reasons: readonly EligibilityReason[];
}>;

export interface ImplementationPlanStep {
  stepId: string;
  ordinal: number;
  description: string;
  verification: string;
}

export interface PlanningRisk {
  riskId: string;
  description: string;
  mitigation: string;
}

export interface PlanningQuestion {
  questionId: string;
  question: string;
}

export interface BuilderPlanningSubmission {
  schemaVersion: typeof BUILD_PLAN_SCHEMA_VERSION;
  submissionId: BuilderPlanningSubmissionId;
  projectId: StudioProjectId;
  assignmentId: PlanningAssignmentId;
  sessionId: string;
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  brief: AgentBriefRef;
  status: "ready" | "blocked" | "changes-proposed";
  implementationPlan: readonly ImplementationPlanStep[];
  risks: readonly PlanningRisk[];
  questions: readonly PlanningQuestion[];
  proposedMapOperationIds: readonly ProposalOperationId[];
  supersedesSubmissionId: BuilderPlanningSubmissionId | null;
  semanticDigest: PlanningSubmissionDigest;
  recordDigest: RecordDigest;
  submittedAt: string;
}

export interface PlanningFanoutApproval {
  approvalId: PlanningFanoutApprovalId;
  projectId: StudioProjectId;
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  assignmentIds: readonly PlanningAssignmentId[];
  approvedByUserId: string;
  approvingSessionId: string;
  userInputId: string;
  approvedAt: string;
  approvalDigest: PlanningFanoutApprovalDigest;
}

/** Exact, path-free facts shown before the authenticated user consents. */
export type PlanningFanoutPreview =
  | Readonly<{
      available: true;
      source: ArchitectureSourceRef;
      plan: BuildPlanRef;
      assignmentIds: readonly PlanningAssignmentId[];
      assignmentCount: number;
      expectedSessionCount: number;
      expectedModelTurnCount: number;
      warnings: readonly string[];
    }>
  | Readonly<{ available: false; warnings: readonly string[] }>;

export interface PlanningFanoutOpenResponse {
  approvalId: PlanningFanoutApprovalId;
  bindings: readonly BuilderPlanningSessionBinding[];
}

export interface PlanningFanoutOpenRequest {
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  assignmentIds: readonly PlanningAssignmentId[];
  harness?: import("./types.js").HarnessKind;
  theme?: import("./types.js").UiTheme;
}

export interface BuilderKickoffDelivery {
  kickoffId: BuilderKickoffId;
  inputId: string;
  state: "pending" | "delivering" | "delivered" | "delivery-uncertain";
  attemptCount: number;
  deliveredAt: string | null;
  acknowledgedBy: Readonly<{
    source: "hook" | "transcript-marker";
    observedAt: string;
  }> | null;
}

export interface BuilderPlanningSessionBinding {
  bindingId: BuilderPlanningSessionBindingId;
  projectId: StudioProjectId;
  assignmentId: PlanningAssignmentId;
  plannedAgentId: PlanNodeId;
  purpose: "implementation-planning";
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  brief: AgentBriefRef;
  bootstrapDigest: BuilderBootstrapDigest;
  executionPolicy: "planning-readonly";
  /** Monotonic durable create/reconcile claim for this stable binding. */
  spawnEpoch: number;
  spawnClaimId: string | null;
  spawnClaimedAt: string | null;
  sessionId: string | null;
  state: import("./types.js").BuilderPlanningLifecycleState;
  staleReasons: readonly BriefStaleReason[];
  kickoff: BuilderKickoffDelivery | null;
  failureCode: "spawn_failed" | "policy_unavailable" | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningSubmissionIdempotencyReceipt {
  sessionId: string;
  requestId: string;
  requestDigest: string;
  submissionId: BuilderPlanningSubmissionId;
}

export interface PlanningAssignmentRecord {
  schemaVersion: typeof BUILD_PLAN_SCHEMA_VERSION;
  projectId: StudioProjectId;
  assignmentId: PlanningAssignmentId;
  briefId: AgentBriefId;
  plannedAgentId: PlanNodeId;
  status: "active" | "retired";
  createdAt: string;
  retiredAt: string | null;
  transitions: readonly Readonly<{
    status: "active" | "retired";
    at: string;
    planVersion: BuildPlanVersion;
  }>[];
  recordDigest: RecordDigest;
}

export interface BuildPlanIdempotencyReceipt {
  sessionId: string;
  requestId: string;
  requestDigest: string;
  resultRecordDigest: RecordDigest;
  result?: BuildPlanReceiptResult;
  createdAt: string;
}

export interface BuildPlanIdMapping {
  kind: "milestone" | "criterion" | "deliverable" | "decision";
  clientRef: string;
  id: string;
}

/** Bounded mutation metadata needed to reproduce an exact idempotent result. */
export interface BuildPlanReceiptResult {
  operation: "apply" | "rebase";
  briefChanges: readonly Readonly<{
    plannedAgentId: PlanNodeId;
    change: "created" | "changed" | "staled" | "preserved";
  }>[];
  idMappings: readonly BuildPlanIdMapping[];
  completeness: BuildPlanCompleteness;
  eligibility: BuildPlanEligibility;
  diagnostics: readonly BuildPlanDiagnostic[];
  impact?: BuildPlanImpactResult;
}

/** Permanent compact provenance for requests whose exact result aged out. */
export interface BuildPlanIdempotencyTombstone {
  sessionId: string;
  requestId: string;
}

export interface BuildPlanningAggregateV1 {
  schemaVersion: typeof BUILD_PLANNING_AGGREGATE_SCHEMA_VERSION;
  planId: BuildPlanId | null;
  currentPlanVersion: BuildPlanVersion | null;
  planVersions: readonly ProjectBuildPlanVersion[];
  currentBriefByAgentId: Readonly<Record<string, AgentBriefRef>>;
  briefVersionsById: Readonly<
    Record<string, readonly AgentBriefVersionRecord[]>
  >;
  assignmentByAgentId: Readonly<Record<string, PlanningAssignmentRecord>>;
  submissionsByAssignmentId: Readonly<
    Record<string, readonly BuilderPlanningSubmission[]>
  >;
  fanoutApprovals: readonly PlanningFanoutApproval[];
  builderBindingsByAssignmentId: Readonly<
    Record<string, BuilderPlanningSessionBinding>
  >;
  planningSubmissionReceipts: readonly PlanningSubmissionIdempotencyReceipt[];
  idempotencyReceipts: readonly BuildPlanIdempotencyReceipt[];
  idempotencyTombstones: readonly BuildPlanIdempotencyTombstone[];
}

export interface BuildPlanImpactEvaluator {
  evaluate(input: {
    previousSource: ArchitectureSourceRef;
    nextSource: ArchitectureSourceRef;
    briefs: readonly AgentBriefVersionRecord[];
    previousPlan?: ProjectBuildPlanVersion;
    nextPlan?: ProjectBuildPlanVersion;
    previousGraph?: import("./agent-map.js").AgentMapGraph;
    nextGraph?: import("./agent-map.js").AgentMapGraph;
    nextBriefs?: readonly AgentBriefVersionRecord[];
  }):
    | BuildPlanImpactResult
    | Readonly<Record<string, readonly BriefStaleReason[]>>
    | Promise<
        | BuildPlanImpactResult
        | Readonly<Record<string, readonly BriefStaleReason[]>>
      >;
}

export const emptyBuildPlanningAggregate = (): BuildPlanningAggregateV1 => ({
  schemaVersion: BUILD_PLANNING_AGGREGATE_SCHEMA_VERSION,
  planId: null,
  currentPlanVersion: null,
  planVersions: [],
  currentBriefByAgentId: {},
  briefVersionsById: {},
  assignmentByAgentId: {},
  submissionsByAssignmentId: {},
  fanoutApprovals: [],
  builderBindingsByAssignmentId: {},
  planningSubmissionReceipts: [],
  idempotencyReceipts: [],
  idempotencyTombstones: [],
});
