import type {
  AgentMapVersionId,
  AgentMapVersionRef,
  PlanNodeId,
  ProjectAgentActorRef,
  ProjectMutationOrigin,
  ProjectVersionChangeKind,
  RecordDigest,
  StudioProjectId,
} from "./agent-map.js";

export const BUILD_PLAN_SCHEMA_VERSION = 1 as const;
export const PROJECT_PLANNING_STORAGE_SCHEMA_VERSION = 2 as const;
export const BUILD_PLAN_VERSION_HISTORY_LIMIT = 1_024;
export const AGENT_BRIEF_VERSION_HISTORY_LIMIT = 1_024;
export const PROJECT_MUTATION_RECEIPT_LIMIT = 1_024;
export const PROJECT_MUTATION_TOMBSTONE_LIMIT = 8_192;
export const BUILD_PLAN_ID_MAPPING_LIMIT = 128;

type Brand<TBrand extends string> = string & { readonly __brand: TBrand };

export type ProjectBuildPlanId = Brand<"ProjectBuildPlanId">;
export type BuildPlanId = ProjectBuildPlanId;
export type ProjectBuildPlanVersionId = Brand<"ProjectBuildPlanVersionId">;
export type BuildPlanSemanticDigest = Brand<"BuildPlanSemanticDigest">;
export type AgentBriefId = Brand<"AgentBriefId">;
export type AgentBriefVersionId = Brand<"AgentBriefVersionId">;
export type AgentBriefSemanticDigest = Brand<"AgentBriefSemanticDigest">;
export type AgentBriefScopeKey = Brand<"AgentBriefScopeKey">;
export type PlanningAssignmentId = Brand<"PlanningAssignmentId">;
export type MilestoneId = Brand<"MilestoneId">;
export type SequenceGateId = Brand<"SequenceGateId">;
export type PlanDecisionId = Brand<"PlanDecisionId">;
export type PlanRiskId = Brand<"PlanRiskId">;
export type BuildPlanDependencyId = Brand<"BuildPlanDependencyId">;

export type ProjectBuildPlanVersionRef = Readonly<{
  projectId: StudioProjectId;
  planId: ProjectBuildPlanId;
  versionId: ProjectBuildPlanVersionId;
  semanticDigest: BuildPlanSemanticDigest;
}>;

export type AgentBriefVersionRef = Readonly<{
  projectId: StudioProjectId;
  briefId: AgentBriefId;
  versionId: AgentBriefVersionId;
  semanticDigest: AgentBriefSemanticDigest;
}>;

/** Neutral focus identity; delegation scopes may nest without becoming roles. */
export type AgentBriefFocusScope =
  | Readonly<{
      family: "canonical-workstream";
      plannedAgentId: PlanNodeId;
    }>
  | Readonly<{
      family: "ad-hoc-delegation";
      delegationKey: string;
      parentScopeKey: AgentBriefScopeKey | null;
    }>;

export type AgentBriefHistoryPointer = Readonly<{
  scopeKey: AgentBriefScopeKey;
  focusScope: AgentBriefFocusScope;
  briefId: AgentBriefId;
  status: "active" | "retired";
  version: AgentBriefVersionRef;
}>;

export interface BuildPlanMilestone {
  id: MilestoneId;
  ordinal: number;
  title: string;
  outcome: string;
  dependsOn: readonly MilestoneId[];
}

export interface BuildPlanSequenceGate {
  id: SequenceGateId;
  ordinal: number;
  description: string;
  milestoneIds: readonly MilestoneId[];
}

export interface BuildPlanRepositoryIntent {
  id: string;
  plannedAgentId: PlanNodeId;
  repository: string;
  packages: readonly string[];
  ownershipBoundaries: readonly string[];
}

export interface BuildPlanDecision {
  id: PlanDecisionId;
  question: string;
  resolution: string;
  status: "open" | "resolved";
}

export interface BuildPlanRisk {
  id: PlanRiskId;
  description: string;
  mitigation: string;
}

/** Intent only: map nodes and relationships remain the sole editable topology. */
export interface BuildPlanAssignmentIntent {
  id: PlanningAssignmentId;
  plannedAgentId: PlanNodeId;
  briefId: AgentBriefId | null;
  mission: string;
  scope: readonly string[];
  nonGoals: readonly string[];
  dependencies: readonly BuildPlanDependencyIntent[];
}

export interface BuildPlanDependencyIntent {
  id: BuildPlanDependencyId;
  kind: "input" | "output" | "shared-resource" | "depends-on";
  nodeId: PlanNodeId;
  relationshipIds: readonly string[];
  contractRef: string | null;
}

export interface ProjectBuildPlanContent {
  outcome: string;
  nonGoals: readonly string[];
  milestones: readonly BuildPlanMilestone[];
  sequenceGates: readonly BuildPlanSequenceGate[];
  sharedConstraints: readonly string[];
  repositoryIntents: readonly BuildPlanRepositoryIntent[];
  integrationCriteria: readonly string[];
  acceptanceCriteria: readonly string[];
  decisions: readonly BuildPlanDecision[];
  assignments: readonly BuildPlanAssignmentIntent[];
  unresolvedDecisions: readonly BuildPlanDecision[];
  risks: readonly BuildPlanRisk[];
}

export type ProjectBuildPlanVersion = Readonly<{
  schemaVersion: typeof BUILD_PLAN_SCHEMA_VERSION;
  projectId: StudioProjectId;
  planId: ProjectBuildPlanId;
  versionId: ProjectBuildPlanVersionId;
  version: number;
  parentVersionId: ProjectBuildPlanVersionId | null;
  changeKind: ProjectVersionChangeKind;
  restoredFromVersionId: ProjectBuildPlanVersionId | null;
  map: AgentMapVersionRef;
  content: ProjectBuildPlanContent;
  semanticDigest: BuildPlanSemanticDigest;
  authoredBy: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
  recordDigest: RecordDigest;
}>;

export interface AgentBriefContent {
  mission: string;
  scope: readonly string[];
  nonGoals: readonly string[];
  ownedNodeIds: readonly PlanNodeId[];
  relevantNodeIds: readonly PlanNodeId[];
  inputs: readonly string[];
  outputs: readonly string[];
  dependencies: readonly string[];
  sharedResourceNodeIds: readonly PlanNodeId[];
  sequenceGateIds: readonly SequenceGateId[];
  deliverables: readonly string[];
  acceptanceCriteria: readonly string[];
  constraints: readonly string[];
  milestoneIds: readonly MilestoneId[];
  unresolvedDecisionIds: readonly PlanDecisionId[];
}

export const AGENT_BRIEF_COMPILER_VERSION = "1.0.0";

export const AGENT_BRIEF_FINGERPRINT_KINDS = [
  "owned-nodes",
  "relevant-nodes",
  "input-contracts",
  "output-contracts",
  "relationships",
  "resources",
  "milestones",
  "shared-plan-content",
  "assignment-content",
] as const;
export type AgentBriefFingerprintKind =
  (typeof AGENT_BRIEF_FINGERPRINT_KINDS)[number];

export type AgentBriefDependencyFingerprint = Readonly<{
  kind: AgentBriefFingerprintKind;
  digest: string;
  nodeIds: readonly PlanNodeId[];
  relationshipIds: readonly string[];
  contractRefs: readonly string[];
}>;

export type AgentBriefDisposition =
  | "created"
  | "new-version"
  | "unchanged"
  | "retired";

export type AgentBriefStaleReasonCode =
  | "agent-added"
  | "agent-removed"
  | "ownership-changed"
  | "relevant-node-changed"
  | "contract-changed"
  | "relationship-changed"
  | "resource-changed"
  | "milestone-changed"
  | "shared-plan-content-changed"
  | "assignment-content-changed";

export type AgentBriefStaleReason = Readonly<{
  code: AgentBriefStaleReasonCode;
  affectedNodeIds: readonly PlanNodeId[];
  affectedRelationshipIds: readonly string[];
  affectedContractRefs: readonly string[];
  previousFingerprint?: string;
  currentFingerprint?: string;
}>;

export type AgentBriefImpactEntry = Readonly<{
  scopeKey: AgentBriefScopeKey;
  briefId: AgentBriefId;
  disposition: "added" | "removed" | "stale" | "preserved";
  reasons: readonly AgentBriefStaleReason[];
}>;

export type AgentBriefImpact = Readonly<{
  affectedWorkstreamCount: number;
  entries: readonly AgentBriefImpactEntry[];
  staleBriefIds: readonly AgentBriefId[];
  preservedBriefIds: readonly AgentBriefId[];
  changedNodeIds: readonly PlanNodeId[];
  changedRelationshipIds: readonly string[];
  changedContractRefs: readonly string[];
  digest: string;
}>;

/**
 * Reserved exact-source history seam for SAP-3150. SAP-3149 persists and
 * validates these records but has no compiler/runtime producer.
 */
export type AgentBriefVersion = Readonly<{
  schemaVersion: typeof BUILD_PLAN_SCHEMA_VERSION;
  projectId: StudioProjectId;
  briefId: AgentBriefId;
  scopeKey: AgentBriefScopeKey;
  focusScope: AgentBriefFocusScope;
  versionId: AgentBriefVersionId;
  version: number;
  parentVersionId: AgentBriefVersionId | null;
  changeKind: ProjectVersionChangeKind;
  restoredFromVersionId: AgentBriefVersionId | null;
  assignmentId: PlanningAssignmentId;
  plannedAgentId: PlanNodeId;
  map: AgentMapVersionRef;
  plan: ProjectBuildPlanVersionRef;
  content: AgentBriefContent;
  compilerVersion: string;
  compilerInputFingerprint: string;
  semanticDigest: AgentBriefSemanticDigest;
  authoredBy: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
  recordDigest: RecordDigest;
}>;

export type AgentBriefVersionRecord = AgentBriefVersion;

export interface BuildPlanDiagnostic {
  code:
    | "missing-assignment"
    | "missing-brief"
    | "brief-source-stale"
    | "unknown-node-reference"
    | "invalid-repository-owner"
    | "invalid-milestone-dependency"
    | "invalid-dependency"
    | "duplicate-ordinal"
    | "unresolved-decision"
    | "source-mismatch"
    | "source-lineage-mismatch"
    | "ambiguous-focus-owner"
    | "missing-focus-node"
    | "brief-limit-exceeded"
    | "brief-compilation-failed"
    | "context-truncated";
  severity: "error" | "warning";
  path: string;
  relatedIds: readonly string[];
}

export interface BuildPlanIdMapping {
  kind: "plan" | "assignment" | "milestone" | "sequence-gate" | "repository-intent" |
    "dependency" | "decision" | "risk" | "brief";
  clientRef: string;
  id: string;
}

export interface ProjectMutationReceipt<TResult = unknown> {
  projectId: StudioProjectId;
  userId: string;
  sessionId: string;
  requestId: string;
  requestDigest: string;
  operation: "map" | "build_plan_apply" | "build_plan_rebase" | "map_restore" | "plan_restore" | "brief_append";
  result: TResult;
  createdAt: string;
}

export interface ProjectMutationTombstone {
  projectId: StudioProjectId;
  userId: string;
  sessionId: string;
  requestId: string;
  operation: ProjectMutationReceipt["operation"];
  createdAt: string;
}

export type BuildPlanReadSelector =
  | Readonly<{ kind: "current" }>
  | Readonly<{
      kind: "exact";
      planId: ProjectBuildPlanId;
      versionId: ProjectBuildPlanVersionId;
      semanticDigest: BuildPlanSemanticDigest;
    }>;

export type BuildPlanCurrentPointers = Readonly<{
  map: AgentMapVersionRef | null;
  buildPlan: ProjectBuildPlanVersionRef | null;
  briefsByScope: Readonly<Record<string, AgentBriefHistoryPointer>>;
}>;

export interface BuildPlanHistorySummary {
  ref: ProjectBuildPlanVersionRef;
  version: number;
  changeKind: ProjectVersionChangeKind;
  map: AgentMapVersionRef;
  createdAt: string;
}

export interface BuildPlanReadResult {
  current: BuildPlanCurrentPointers;
  plan: ProjectBuildPlanVersion | null;
  diagnostics: readonly BuildPlanDiagnostic[];
  history: readonly BuildPlanHistorySummary[];
}

export const emptyProjectBuildPlanContent = (): ProjectBuildPlanContent => ({
  outcome: "",
  nonGoals: [],
  milestones: [],
  sequenceGates: [],
  sharedConstraints: [],
  repositoryIntents: [],
  integrationCriteria: [],
  acceptanceCriteria: [],
  decisions: [],
  assignments: [],
  unresolvedDecisions: [],
  risks: [],
});

export const agentMapVersionRefsEqual = (
  left: AgentMapVersionRef,
  right: AgentMapVersionRef,
): boolean =>
  left.projectId === right.projectId &&
  left.versionId === right.versionId &&
  left.contentDigest === right.contentDigest;

export const projectBuildPlanVersionRefsEqual = (
  left: ProjectBuildPlanVersionRef,
  right: ProjectBuildPlanVersionRef,
): boolean =>
  left.projectId === right.projectId &&
  left.planId === right.planId &&
  left.versionId === right.versionId &&
  left.semanticDigest === right.semanticDigest;

/** Compatibility alias: final plans bind only to exact immutable map versions. */
export type ArchitectureSourceRef = AgentMapVersionRef;
export type AgentMapRevisionId = AgentMapVersionId;
