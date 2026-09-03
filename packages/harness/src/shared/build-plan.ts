import type {
  MapProposalId,
  PlanNodeId,
  PlanRelationshipId,
  ProposalOperationId,
  StudioProjectId,
} from "./agent-map.js";

export const BUILD_PLAN_SCHEMA_VERSION = 1 as const;
export const BUILD_PLANNING_AGGREGATE_SCHEMA_VERSION = 1 as const;
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

export interface DependencyFingerprint {
  kind: "node" | "relationship" | "contract" | "plan";
  id: string;
  digest: string;
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
  idempotencyReceipts: readonly BuildPlanIdempotencyReceipt[];
  idempotencyTombstones: readonly BuildPlanIdempotencyTombstone[];
}

export interface BuildPlanImpactEvaluator {
  evaluate(input: {
    previousSource: ArchitectureSourceRef;
    nextSource: ArchitectureSourceRef;
    briefs: readonly AgentBriefVersionRecord[];
  }): Promise<Readonly<Record<string, readonly BriefStaleReason[]>>>;
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
  idempotencyReceipts: [],
  idempotencyTombstones: [],
});
