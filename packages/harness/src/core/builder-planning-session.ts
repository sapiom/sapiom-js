import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  AgentMapGraph,
  MapOperation,
  PlanningSessionIdentity,
  ProposalOperationRecord,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  AgentBriefVersionRecord,
  AgentBriefRef,
  ArchitectureSourceRef,
  BuilderBootstrapContext,
  BuilderKickoffId,
  BuilderPlanningSessionBinding,
  BuilderPlanningSubmission,
  BriefStaleReason,
  BuildPlanRef,
  PlanningAssignmentId,
  PlanningFanoutApproval,
  PlanningFanoutPreview,
  PlanningSubmissionIdempotencyReceipt,
  PersistedAgentBriefVersionRecord,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import {
  AGENT_BRIEF_DIGEST_VERSION,
  AGENT_BRIEF_SCHEMA_VERSION,
} from "../shared/build-plan.js";
import type {
  AnalyticsEvent,
  BuilderPlanningSessionMetadata,
  HarnessKind,
  HarnessSession,
  UiTheme,
} from "../shared/types.js";
import {
  architectureSourceRefSchema,
  builderPlanningSubmissionSchema,
} from "../shared/build-plan-codec.js";
import {
  canonicalJson,
  computeArchitectureGraphDigest,
  computeCanonicalDigest,
  computePlanningSubmissionRecordDigest,
  computePlanningSubmissionSemanticDigest,
} from "./build-plan-canonicalization.js";
import {
  createBuilderBootstrapContext,
  serializeBuilderBootstrapContext,
} from "./builder-bootstrap-context.js";
import type {
  AgentMapProjectAggregate,
  AgentMapWorkspaceStore,
} from "./agent-map-workspace-store.js";
import type { ArchitectureSourceResolver } from "./architecture-source-resolver.js";
import type { BuildPlanContractValidator } from "./build-plan-contract-validator.js";
import type { BuildPlanStore } from "./build-plan-store.js";
import {
  SessionAlreadyLiveError,
  SessionInputGuardRejectedError,
  SessionNotReadyError,
  type SessionManager,
} from "./session-manager.js";
import { BUILDER_PLANNING_KICKOFF } from "../profiles/agent-map-builder-planning.js";

const PLANNING_SUBMISSION_RECEIPT_WINDOW = 256;

function isCurrentAgentBrief(
  brief: PersistedAgentBriefVersionRecord | undefined,
): brief is AgentBriefVersionRecord {
  return (
    brief?.schemaVersion === AGENT_BRIEF_SCHEMA_VERSION &&
    brief.digestVersion === AGENT_BRIEF_DIGEST_VERSION
  );
}

const opaque = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      value.trim().length > 0 &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      ![...value].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 0x1f || point === 0x7f;
      }),
  );
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const refId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f-]+$`, "u"));
const planRefSchema = z
  .object({
    planId: refId("build-plan"),
    version: z.number().int().positive(),
    semanticDigest: digest,
  })
  .strict();
const briefRefSchema = z
  .object({
    briefId: refId("brief"),
    version: z.number().int().positive(),
    semanticDigest: digest,
  })
  .strict();
const stepSchema = z
  .object({
    stepId: opaque,
    ordinal: z.number().int().safe().positive(),
    description: z.string().trim().min(1).max(2_000),
    verification: z.string().trim().min(1).max(2_000),
  })
  .strict();
const riskSchema = z
  .object({
    riskId: opaque,
    description: z.string().trim().min(1).max(2_000),
    mitigation: z.string().trim().min(1).max(2_000),
  })
  .strict();
const questionSchema = z
  .object({ questionId: opaque, question: z.string().trim().min(1).max(2_000) })
  .strict();

function rejectDuplicates<T>(
  values: readonly T[],
  key: (value: T) => string | number,
  path: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string | number>();
  values.forEach((value, index) => {
    const candidate = key(value);
    if (seen.has(candidate))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, path],
        message: `Duplicate ${path}`,
      });
    seen.add(candidate);
  });
}

const implementationPlanSchema = z
  .array(stepSchema)
  .min(1)
  .max(256)
  .superRefine((steps, context) => {
    rejectDuplicates(steps, (step) => step.stepId, "stepId", context);
    rejectDuplicates(steps, (step) => step.ordinal, "ordinal", context);
  });
const risksSchema = z
  .array(riskSchema)
  .max(256)
  .superRefine((risks, context) =>
    rejectDuplicates(risks, (risk) => risk.riskId, "riskId", context),
  );
const questionsSchema = z
  .array(questionSchema)
  .max(256)
  .superRefine((questions, context) =>
    rejectDuplicates(
      questions,
      (question) => question.questionId,
      "questionId",
      context,
    ),
  );
const proposalOperationIdsSchema = z
  .array(refId("operation"))
  .max(256)
  .superRefine((operationIds, context) =>
    rejectDuplicates(operationIds, (id) => id, "operationId", context),
  );

export const planningResultSubmitRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    expected: z
      .object({
        assignmentId: refId("assignment"),
        source: architectureSourceRefSchema,
        plan: planRefSchema,
        brief: briefRefSchema,
        bootstrapDigest: digest,
      })
      .strict(),
    requestId: opaque,
    status: z.enum(["ready", "blocked", "changes-proposed"]),
    implementationPlan: implementationPlanSchema,
    risks: risksSchema,
    questions: questionsSchema,
    proposedMapOperationIds: proposalOperationIdsSchema,
  })
  .strict();

export interface PlanningResultSubmitRequest {
  schemaVersion: 1;
  expected: {
    assignmentId: PlanningAssignmentId;
    source: ArchitectureSourceRef;
    plan: BuildPlanRef;
    brief: AgentBriefRef;
    bootstrapDigest: BuilderBootstrapContext["contextDigest"];
  };
  requestId: string;
  status: "ready" | "blocked" | "changes-proposed";
  implementationPlan: BuilderPlanningSubmission["implementationPlan"];
  risks: BuilderPlanningSubmission["risks"];
  questions: BuilderPlanningSubmission["questions"];
  proposedMapOperationIds: BuilderPlanningSubmission["proposedMapOperationIds"];
}

export class BuilderPlanningSessionError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "missing_consent"
      | "stale_consent"
      | "plan_not_ready"
      | "binding_stale"
      | "session_not_found"
      | "context_mismatch"
      | "idempotency_key_reused"
      | "invalid_proposal_operations"
      | "invalid_request",
    readonly issues: readonly Readonly<{
      path: string;
      message: string;
    }>[] = [],
  ) {
    super(code.replace(/_/gu, " "));
    this.name = "BuilderPlanningSessionError";
  }
}

export interface BuilderPlanningSessionServiceOptions {
  workspaceStore: AgentMapWorkspaceStore;
  buildPlanStore: BuildPlanStore;
  contractValidator: BuildPlanContractValidator;
  sourceResolver?: Pick<ArchitectureSourceResolver, "resolve">;
  sessionManager: SessionManager;
  currentUserId: () => string;
  resolveProjectRoot: (projectId: StudioProjectId) => Promise<string>;
  defaultHarness: HarnessKind;
  now?: () => string;
  /** A crashed creator may be replaced only after this durable lease expires. */
  spawnClaimTtlMs?: number;
  /** A live delivery claim only suppresses concurrent callers. Once stale, the
   * outcome is unknown and reconciliation must not write again. */
  deliveryClaimTtlMs?: number;
}

export interface ApprovePlanningFanoutRequest {
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  assignmentIds: readonly PlanningAssignmentId[];
}

export interface OpenPlanningFanoutRequest {
  approvalId: string;
  source: ArchitectureSourceRef;
  plan: BuildPlanRef;
  assignmentIds: readonly PlanningAssignmentId[];
  harness?: HarnessKind;
  theme?: UiTheme;
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/** The binding id is stable across replanning epochs, so lifecycle CAS must
 * also fence every immutable context field that defines one exact epoch. */
function sameBindingContext(
  left: BuilderPlanningSessionBinding,
  right: BuilderPlanningSessionBinding,
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.projectId === right.projectId &&
    left.assignmentId === right.assignmentId &&
    left.plannedAgentId === right.plannedAgentId &&
    left.purpose === right.purpose &&
    left.executionPolicy === right.executionPolicy &&
    same(left.source, right.source) &&
    same(left.plan, right.plan) &&
    same(left.brief, right.brief) &&
    left.bootstrapDigest === right.bootstrapDigest
  );
}

interface BindingMutationExpectation {
  sessionId?: string | null;
  spawnEpoch?: number;
  spawnClaimId?: string | null;
  state?:
    | BuilderPlanningSessionBinding["state"]
    | readonly BuilderPlanningSessionBinding["state"][];
  kickoffId?: string | null;
  kickoffInputId?: string | null;
  deliveryClaimId?: string | null;
}

function matchesBindingMutationExpectation(
  binding: BuilderPlanningSessionBinding,
  expected: BindingMutationExpectation,
): boolean {
  const has = (key: keyof BindingMutationExpectation) =>
    Object.prototype.hasOwnProperty.call(expected, key);
  const states = Array.isArray(expected.state)
    ? expected.state
    : expected.state
      ? [expected.state]
      : null;
  return (
    (!has("sessionId") || binding.sessionId === expected.sessionId) &&
    (!has("spawnEpoch") || binding.spawnEpoch === expected.spawnEpoch) &&
    (!has("spawnClaimId") || binding.spawnClaimId === expected.spawnClaimId) &&
    (!states || states.includes(binding.state)) &&
    (!has("kickoffId") ||
      (binding.kickoff?.kickoffId ?? null) === expected.kickoffId) &&
    (!has("kickoffInputId") ||
      (binding.kickoff?.inputId ?? null) === expected.kickoffInputId) &&
    (!has("deliveryClaimId") ||
      (binding.kickoff?.deliveryClaimId ?? null) === expected.deliveryClaimId)
  );
}

function exactLifecycleExpectation(
  binding: BuilderPlanningSessionBinding,
): BindingMutationExpectation {
  return {
    sessionId: binding.sessionId,
    spawnEpoch: binding.spawnEpoch,
    spawnClaimId: binding.spawnClaimId,
    state: binding.state,
    kickoffId: binding.kickoff?.kickoffId ?? null,
    kickoffInputId: binding.kickoff?.inputId ?? null,
    deliveryClaimId: binding.kickoff?.deliveryClaimId ?? null,
  };
}

function proposalStaleReasons(
  aggregate: AgentMapProjectAggregate,
  binding: BuilderPlanningSessionBinding,
  brief: AgentBriefVersionRecord,
): BriefStaleReason[] {
  if (binding.source.kind !== "proposal")
    return [
      {
        code: "source-changed",
        affectedNodeIds: [],
        affectedRelationshipIds: [],
        affectedContractIds: [],
      },
    ];
  const source = binding.source;
  const proposal = aggregate.proposal;
  if (
    aggregate.workspace.activeProposalId !== source.proposalId ||
    !proposal ||
    proposal.id !== source.proposalId ||
    proposal.version < source.version
  )
    return [
      {
        code: "source-changed",
        affectedNodeIds: [],
        affectedRelationshipIds: [],
        affectedContractIds: [],
      },
    ];
  if (proposal.version === source.version) {
    return computeArchitectureGraphDigest({
      nodes: proposal.nodes,
      relationships: proposal.relationships,
    }) === source.graphDigest
      ? []
      : [
          {
            code: "source-changed",
            affectedNodeIds: [],
            affectedRelationshipIds: [],
            affectedContractIds: [],
          },
        ];
  }
  const records = proposal.history.filter(
    (entry) => entry.acceptedVersion > source.version,
  );
  const direct = records.filter(
    (entry) => entry.acceptedVersion === source.version + 1,
  );
  const ownsDirectSuccessor =
    direct.length > 0 &&
    direct.every((entry) => entry.actor.sessionId === binding.sessionId);
  const relevant = records.filter(
    (entry) =>
      !(ownsDirectSuccessor && entry.acceptedVersion === source.version + 1),
  );
  const nodeIds = new Set(
    brief.dependencyFingerprints.flatMap((entry) => entry.nodeIds),
  );
  brief.ownedNodeIds.forEach((id) => nodeIds.add(id));
  brief.relevantNodeIds.forEach((id) => nodeIds.add(id));
  nodeIds.add(brief.plannedAgentId);
  const relationshipIds = new Set(
    brief.dependencyFingerprints.flatMap((entry) => entry.relationshipIds),
  );
  const contractIds = new Set(
    brief.dependencyFingerprints.flatMap((entry) => entry.contractIds),
  );
  const changedNodes = new Set<AgentBriefVersionRecord["plannedAgentId"]>();
  const changedRelationships = new Set<
    AgentBriefVersionRecord["inputs"][number]["relationshipIds"][number]
  >();
  const changedContracts = new Set<
    AgentBriefVersionRecord["inputs"][number]["contractId"]
  >();
  const touches = (operation: MapOperation): boolean => {
    switch (operation.kind) {
      case "add-node":
        if (
          operation.node.ownerAgentId &&
          nodeIds.has(operation.node.ownerAgentId)
        ) {
          changedNodes.add(operation.node.ownerAgentId);
          return true;
        }
        return false;
      case "update-node":
      case "remove-node":
        if (nodeIds.has(operation.nodeId)) {
          changedNodes.add(operation.nodeId);
          return true;
        }
        return false;
      case "add-relationship": {
        const related =
          nodeIds.has(operation.relationship.fromNodeId) ||
          nodeIds.has(operation.relationship.toNodeId);
        const contracted =
          operation.relationship.contractRef !== null &&
          contractIds.has(
            operation.relationship
              .contractRef as BriefStaleReason["affectedContractIds"][number],
          );
        if (related) {
          changedNodes.add(operation.relationship.fromNodeId);
          changedNodes.add(operation.relationship.toNodeId);
        }
        if (contracted)
          changedContracts.add(
            operation.relationship
              .contractRef as BriefStaleReason["affectedContractIds"][number],
          );
        return related || contracted;
      }
      case "update-relationship":
      case "remove-relationship":
        if (relationshipIds.has(operation.relationshipId)) {
          changedRelationships.add(operation.relationshipId);
          return true;
        }
        return false;
    }
  };
  if (!relevant.some((entry) => touches(entry.operation))) return [];
  return [
    {
      code:
        changedContracts.size > 0
          ? "contract-changed"
          : changedRelationships.size > 0
            ? "relationship-changed"
            : "relevant-node-changed",
      affectedNodeIds: [...changedNodes].sort(),
      affectedRelationshipIds: [...changedRelationships].sort(),
      affectedContractIds: [...changedContracts].sort(),
    },
  ];
}

function proposalOperationConflictKeys(operation: MapOperation): string[] {
  switch (operation.kind) {
    case "add-node":
      return [`node:${operation.node.id}`];
    case "update-node":
    case "remove-node":
      return [`node:${operation.nodeId}`];
    case "add-relationship":
      return [
        `relationship:${operation.relationship.id}`,
        `node:${operation.relationship.fromNodeId}`,
        `node:${operation.relationship.toNodeId}`,
      ];
    case "update-relationship":
    case "remove-relationship":
      return [`relationship:${operation.relationshipId}`];
  }
}

function stableId(prefix: string, seed: unknown): string {
  const hex = createHash("sha256")
    .update(prefix)
    .update("\0")
    .update(canonicalJson(seed))
    .digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sessionMetadata(
  binding: BuilderPlanningSessionBinding,
  primary = true,
): BuilderPlanningSessionMetadata {
  return {
    bindingId: binding.bindingId,
    purpose: binding.purpose,
    assignmentId: binding.assignmentId,
    plannedAgentId: binding.plannedAgentId,
    source: binding.source,
    plan: binding.plan,
    brief: binding.brief,
    bootstrapDigest: binding.bootstrapDigest,
    state: binding.state,
    primary,
  };
}

function exactContext(
  binding: BuilderPlanningSessionBinding,
  request: Pick<OpenPlanningFanoutRequest, "source" | "plan">,
  assignmentId: PlanningAssignmentId,
  brief: AgentBriefRef,
  bootstrapDigest: string,
): boolean {
  return (
    binding.assignmentId === assignmentId &&
    same(binding.source, request.source) &&
    same(binding.plan, request.plan) &&
    same(binding.brief, brief) &&
    binding.bootstrapDigest === bootstrapDigest
  );
}

function kickoffText(inputId: string): string {
  return `${BUILDER_PLANNING_KICKOFF}\n\nAgent Studio kickoff ID: ${inputId}`;
}

export function reconcileKickoffAttempt(
  binding: BuilderPlanningSessionBinding,
  outcome: { accepted: boolean; ambiguous: boolean; updatedAt: string },
): BuilderPlanningSessionBinding {
  if (!binding.kickoff || binding.kickoff.state === "delivered") return binding;
  const uncertain = outcome.accepted || outcome.ambiguous;
  return {
    ...binding,
    state: uncertain ? "delivery-uncertain" : "kickoff-pending",
    kickoff: {
      ...binding.kickoff!,
      state: uncertain ? "delivery-uncertain" : "pending",
      deliveryClaimId: null,
      deliveryClaimedAt: null,
    },
    updatedAt: outcome.updatedAt,
  };
}

export class BuilderPlanningSessionService {
  private readonly now: () => string;
  private readonly spawnClaimTtlMs: number;
  private readonly deliveryClaimTtlMs: number;
  private readonly expectedKickoffs = new Map<
    string,
    { inputId: string; text: string }
  >();
  private readonly projectOpens = new Map<string, Promise<unknown>>();

  constructor(private readonly options: BuilderPlanningSessionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnClaimTtlMs = options.spawnClaimTtlMs ?? 120_000;
    this.deliveryClaimTtlMs = options.deliveryClaimTtlMs ?? 120_000;
  }

  private assertPlanner(identity: PlanningSessionIdentity): void {
    if (
      identity.role !== "map-planner" ||
      identity.userId !== this.options.currentUserId() ||
      this.options.sessionManager.get(identity.sessionId)?.agentMapIdentity
        ?.role !== "map-planner"
    )
      throw new BuilderPlanningSessionError("forbidden");
  }

  async preview(projectId: StudioProjectId): Promise<PlanningFanoutPreview> {
    const planning = await this.options.buildPlanStore.read(projectId);
    const plan = planning.planVersions.find(
      (candidate) => candidate.version === planning.currentPlanVersion,
    );
    if (!plan)
      return { available: false, warnings: ["Complete a build plan first."] };
    const assignmentIds = Object.values(planning.assignmentByAgentId)
      .filter((assignment) => assignment.status === "active")
      .map((assignment) => assignment.assignmentId)
      .sort();
    try {
      const exact = await this.exactPlanning(projectId, {
        source: plan.source,
        plan: {
          planId: plan.planId,
          version: plan.version,
          semanticDigest: plan.semanticDigest,
        },
        assignmentIds,
      });
      const status = await this.options.contractValidator.validate(
        exact.plan,
        exact.briefs,
      );
      return {
        available: true,
        source: plan.source,
        plan: {
          planId: plan.planId,
          version: plan.version,
          semanticDigest: plan.semanticDigest,
        },
        assignmentIds,
        assignmentCount: assignmentIds.length,
        expectedSessionCount: assignmentIds.length,
        expectedModelTurnCount: assignmentIds.length,
        warnings: status.completeness.issues
          .filter((issue) => issue.severity === "warning")
          .slice(0, 16)
          .map((issue) => issue.code),
      };
    } catch (error) {
      if (error instanceof BuilderPlanningSessionError)
        return { available: false, warnings: [error.code] };
      throw error;
    }
  }

  private exactPlanningFromAggregate(
    aggregate: AgentMapProjectAggregate,
    request: ApprovePlanningFanoutRequest,
  ): {
    plan: ProjectBuildPlanVersion;
    briefs: AgentBriefVersionRecord[];
    graph: AgentMapGraph;
  } {
    const plan = aggregate.buildPlanning.planVersions.find((candidate) =>
      same(
        {
          planId: candidate.planId,
          version: candidate.version,
          semanticDigest: candidate.semanticDigest,
        },
        request.plan,
      ),
    );
    if (
      !plan ||
      aggregate.buildPlanning.currentPlanVersion !== request.plan.version ||
      !same(plan.source, request.source) ||
      request.source.kind !== "proposal" ||
      aggregate.workspace.activeProposalId !== request.source.proposalId ||
      aggregate.proposal?.id !== request.source.proposalId ||
      aggregate.proposal.version !== request.source.version ||
      computeArchitectureGraphDigest({
        nodes: aggregate.proposal.nodes,
        relationships: aggregate.proposal.relationships,
      }) !== request.source.graphDigest
    )
      throw new BuilderPlanningSessionError("stale_consent");
    const assignmentIds = [...request.assignmentIds].sort();
    const active = Object.values(aggregate.buildPlanning.assignmentByAgentId)
      .filter((entry) => entry.status === "active")
      .map((entry) => entry.assignmentId)
      .sort();
    if (!same(assignmentIds, active))
      throw new BuilderPlanningSessionError("stale_consent");
    const briefs = active.map((assignmentId) => {
      const assignment = Object.values(
        aggregate.buildPlanning.assignmentByAgentId,
      ).find((candidate) => candidate.assignmentId === assignmentId);
      const ref = assignment
        ? aggregate.buildPlanning.currentBriefByAgentId[
            assignment.plannedAgentId
          ]
        : undefined;
      const brief = ref
        ? aggregate.buildPlanning.briefVersionsById[ref.briefId]?.find(
            (candidate) => candidate.version === ref.version,
          )
        : undefined;
      if (
        !assignment ||
        !ref ||
        !isCurrentAgentBrief(brief) ||
        brief.assignmentId !== assignmentId ||
        brief.plan.planId !== request.plan.planId ||
        !same(brief.source, request.source)
      )
        throw new BuilderPlanningSessionError("plan_not_ready");
      return brief;
    });
    return {
      plan,
      briefs,
      graph: {
        nodes: aggregate.proposal.nodes,
        relationships: aggregate.proposal.relationships,
      },
    };
  }

  private async exactPlanning(
    projectId: StudioProjectId,
    request: ApprovePlanningFanoutRequest,
  ) {
    const aggregate =
      await this.options.workspaceStore.readAggregate(projectId);
    const exact = this.exactPlanningFromAggregate(aggregate, request);
    const status = await this.options.contractValidator.validate(
      exact.plan,
      exact.briefs,
    );
    if (!status.eligibility.planningEligible)
      throw new BuilderPlanningSessionError("plan_not_ready");
    return { aggregate, ...exact };
  }

  /**
   * Server-internal half of the approval bridge. The boot-token-authenticated
   * UI route is the only production caller and supplies the input id that it
   * observed while handling that exact human action. This method is not wired
   * to MCP or the generic session REST API.
   */
  async approveFromAuthenticatedUiAction(
    identity: PlanningSessionIdentity,
    request: ApprovePlanningFanoutRequest,
    observedUserInputId: string,
  ): Promise<PlanningFanoutApproval> {
    this.assertPlanner(identity);
    if (!/^user-action_[0-9a-f-]{36}$/u.test(observedUserInputId))
      throw new BuilderPlanningSessionError("missing_consent");
    await this.exactPlanning(identity.projectId, request);
    const userInputId = observedUserInputId;
    const approvedAt = this.now();
    const withoutDigest = {
      approvalId: stableId("fanout-approval", { ...request, userInputId }),
      projectId: identity.projectId,
      source: request.source,
      plan: request.plan,
      assignmentIds: [...request.assignmentIds].sort(),
      approvedByUserId: identity.userId,
      approvingSessionId: identity.sessionId,
      userInputId,
      approvedAt,
    };
    const approval = {
      ...withoutDigest,
      approvalDigest: computeCanonicalDigest(
        "sapiom.planning-fanout-approval.v1",
        withoutDigest,
      ),
    } as unknown as PlanningFanoutApproval;
    return this.options.workspaceStore.transact(
      identity.projectId,
      async (aggregate) => {
        // Approval is evidence for the exact state observed at this serialized
        // boundary, not for a preflight snapshot that may already be stale.
        this.exactPlanningFromAggregate(aggregate, request);
        const existing = aggregate.buildPlanning.fanoutApprovals.find(
          (entry) => entry.approvalId === approval.approvalId,
        );
        if (existing) return { value: existing };
        return {
          value: approval,
          next: {
            ...aggregate,
            buildPlanning: {
              ...aggregate.buildPlanning,
              fanoutApprovals: [
                ...aggregate.buildPlanning.fanoutApprovals,
                approval,
              ].slice(-256),
            },
          },
        };
      },
    );
  }

  openOrReuse(
    identity: PlanningSessionIdentity,
    request: OpenPlanningFanoutRequest,
  ): Promise<BuilderPlanningSessionBinding[]> {
    const prior =
      this.projectOpens.get(identity.projectId) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => this.openOrReuseOnce(identity, request));
    this.projectOpens.set(identity.projectId, next);
    const release = () => {
      if (this.projectOpens.get(identity.projectId) === next)
        this.projectOpens.delete(identity.projectId);
    };
    void next.then(release, release);
    return next;
  }

  private async openOrReuseOnce(
    identity: PlanningSessionIdentity,
    request: OpenPlanningFanoutRequest,
  ): Promise<BuilderPlanningSessionBinding[]> {
    this.assertPlanner(identity);
    // Expensive completeness validation is a preflight only. The serialized
    // transaction below repeats every mutable source/plan/brief/approval check
    // before it creates or reuses a binding claim.
    await this.exactPlanning(identity.projectId, request);
    const timestamp = this.now();
    const claimed = await this.options.workspaceStore.transact(
      identity.projectId,
      async (aggregate) => {
        const exact = this.exactPlanningFromAggregate(aggregate, request);
        const approval = aggregate.buildPlanning.fanoutApprovals.find(
          (entry) => entry.approvalId === request.approvalId,
        );
        if (!approval) throw new BuilderPlanningSessionError("missing_consent");
        const { approvalDigest: claimedDigest, ...approvalProjection } =
          approval;
        if (
          approval.approvedByUserId !== identity.userId ||
          approval.approvingSessionId !== identity.sessionId ||
          claimedDigest !==
            computeCanonicalDigest(
              "sapiom.planning-fanout-approval.v1",
              approvalProjection,
            ) ||
          !same(approval.source, request.source) ||
          !same(approval.plan, request.plan) ||
          !same(
            [...approval.assignmentIds].sort(),
            [...request.assignmentIds].sort(),
          )
        )
          throw new BuilderPlanningSessionError("stale_consent");
        const bindings = {
          ...aggregate.buildPlanning.builderBindingsByAssignmentId,
        };
        const result: Array<{
          binding: BuilderPlanningSessionBinding;
          bootstrap: BuilderBootstrapContext;
        }> = [];
        const staleSessionIds: string[] = [];
        for (const brief of exact.briefs) {
          const current = bindings[brief.assignmentId];
          const ref: AgentBriefRef = {
            briefId: brief.briefId,
            version: brief.version,
            semanticDigest: brief.semanticDigest,
          };
          const priorPlan = current
            ? aggregate.buildPlanning.planVersions.find((candidate) =>
                same(
                  {
                    planId: candidate.planId,
                    version: candidate.version,
                    semanticDigest: candidate.semanticDigest,
                  },
                  current.plan,
                ),
              )
            : undefined;
          const priorBootstrap =
            current &&
            priorPlan &&
            current.plan.planId === request.plan.planId &&
            same(current.source, request.source) &&
            same(current.brief, ref)
              ? createBuilderBootstrapContext({
                  plan: priorPlan,
                  graph: exact.graph,
                  brief,
                })
              : null;
          if (
            current &&
            priorBootstrap &&
            same(
              aggregate.buildPlanning.currentBriefByAgentId[
                brief.plannedAgentId
              ],
              ref,
            ) &&
            current.bootstrapDigest === priorBootstrap.contextDigest
          ) {
            result.push({ binding: current, bootstrap: priorBootstrap });
            continue;
          }
          if (current?.sessionId) {
            staleSessionIds.push(current.sessionId);
          }
          const bootstrap = createBuilderBootstrapContext({
            plan: exact.plan,
            graph: exact.graph,
            brief,
          });
          const binding: BuilderPlanningSessionBinding = {
            bindingId: (current?.bindingId ??
              stableId("builder-binding", {
                projectId: identity.projectId,
                assignmentId: brief.assignmentId,
                purpose: "implementation-planning",
              })) as BuilderPlanningSessionBinding["bindingId"],
            projectId: identity.projectId,
            assignmentId: brief.assignmentId,
            plannedAgentId: brief.plannedAgentId,
            purpose: "implementation-planning",
            source: request.source,
            plan: request.plan,
            brief: ref,
            bootstrapDigest: bootstrap.contextDigest,
            executionPolicy: "planning-readonly",
            spawnEpoch: current?.spawnEpoch ?? 0,
            spawnClaimId: null,
            spawnClaimedAt: null,
            sessionId: null,
            state: "pending",
            staleReasons: [],
            kickoff: null,
            failureCode: null,
            createdAt: current?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          bindings[brief.assignmentId] = binding;
          result.push({ binding, bootstrap });
        }
        return {
          value: { claims: result, staleSessionIds },
          next: {
            ...aggregate,
            buildPlanning: {
              ...aggregate.buildPlanning,
              builderBindingsByAssignmentId: bindings,
            },
          },
        };
      },
    );

    // Filesystem-backed session metadata is a projection of the committed
    // aggregate. Never perform this external write from inside a transaction
    // that can fail or retry.
    for (const sessionId of claimed.staleSessionIds) {
      const prior = this.options.sessionManager.get(sessionId);
      if (prior?.builderPlanning)
        await this.options.sessionManager.setBuilderPlanningMetadata(prior.id, {
          ...prior.builderPlanning,
          state: "stale",
        });
    }

    const output: BuilderPlanningSessionBinding[] = [];
    for (const claim of claimed.claims) {
      output.push(
        await this.ensureSession(
          identity,
          claim.binding,
          claim.bootstrap,
          request,
        ),
      );
    }
    return output;
  }

  private async updateBinding(
    binding: BuilderPlanningSessionBinding,
    expected: BindingMutationExpectation,
    update: (
      current: BuilderPlanningSessionBinding,
    ) => BuilderPlanningSessionBinding,
  ): Promise<BuilderPlanningSessionBinding> {
    return this.options.workspaceStore.transact(
      binding.projectId,
      async (aggregate) => {
        const current =
          aggregate.buildPlanning.builderBindingsByAssignmentId[
            binding.assignmentId
          ];
        if (
          !current ||
          !sameBindingContext(current, binding) ||
          !matchesBindingMutationExpectation(current, expected)
        )
          throw new BuilderPlanningSessionError("binding_stale");
        const next = update(structuredClone(current));
        return {
          value: next,
          next: {
            ...aggregate,
            buildPlanning: {
              ...aggregate.buildPlanning,
              builderBindingsByAssignmentId: {
                ...aggregate.buildPlanning.builderBindingsByAssignmentId,
                [binding.assignmentId]: next,
              },
            },
          },
        };
      },
    );
  }

  private matchingSession(
    binding: BuilderPlanningSessionBinding,
  ): HarnessSession | undefined {
    return this.options.sessionManager
      .list()
      .find(
        (session) =>
          session.status !== "exited" &&
          session.builderPlanning?.bindingId === binding.bindingId &&
          session.builderPlanning.primary !== false &&
          session.executionPolicy === "planning-readonly" &&
          same(session.builderPlanning.source, binding.source) &&
          same(session.builderPlanning.plan, binding.plan) &&
          same(session.builderPlanning.brief, binding.brief) &&
          session.builderPlanning.bootstrapDigest === binding.bootstrapDigest,
      );
  }

  private async readCompatibleBinding(
    binding: BuilderPlanningSessionBinding,
    options: Readonly<{
      requireSessionId?: string | null;
      allowStale?: boolean;
    }> = {},
  ): Promise<BuilderPlanningSessionBinding> {
    const aggregate = await this.options.workspaceStore.readAggregate(
      binding.projectId,
    );
    const current =
      aggregate.buildPlanning.builderBindingsByAssignmentId[
        binding.assignmentId
      ];
    if (
      !current ||
      !sameBindingContext(current, binding) ||
      (Object.prototype.hasOwnProperty.call(options, "requireSessionId") &&
        current.sessionId !== options.requireSessionId) ||
      (!options.allowStale && current.state === "stale")
    )
      throw new BuilderPlanningSessionError("binding_stale");
    return current;
  }

  private async claimSpawn(
    binding: BuilderPlanningSessionBinding,
  ): Promise<
    | { won: true; claimId: string; binding: BuilderPlanningSessionBinding }
    | { won: false; binding: BuilderPlanningSessionBinding }
  > {
    const claimId = `spawn-claim_${randomUUID()}`;
    const timestamp = this.now();
    const nowMs = Date.parse(timestamp);
    return this.options.workspaceStore.transact<
      | { won: true; claimId: string; binding: BuilderPlanningSessionBinding }
      | { won: false; binding: BuilderPlanningSessionBinding }
    >(binding.projectId, async (aggregate) => {
      const current =
        aggregate.buildPlanning.builderBindingsByAssignmentId[
          binding.assignmentId
        ];
      if (!current || !sameBindingContext(current, binding))
        throw new BuilderPlanningSessionError("binding_stale");
      if (current.sessionId) return { value: { won: false, binding: current } };
      if (!["pending", "failed", "spawning"].includes(current.state))
        throw new BuilderPlanningSessionError("binding_stale");
      const claimedAtMs = current.spawnClaimedAt
        ? Date.parse(current.spawnClaimedAt)
        : Number.NaN;
      const liveClaim =
        current.spawnClaimId !== null &&
        Number.isFinite(claimedAtMs) &&
        nowMs - claimedAtMs < this.spawnClaimTtlMs;
      if (liveClaim) return { value: { won: false, binding: current } };
      if (current.spawnEpoch !== binding.spawnEpoch)
        throw new BuilderPlanningSessionError("binding_stale");
      const next: BuilderPlanningSessionBinding = {
        ...current,
        state: "spawning",
        spawnEpoch: current.spawnEpoch + 1,
        spawnClaimId: claimId,
        spawnClaimedAt: timestamp,
        failureCode: null,
        updatedAt: timestamp,
      };
      return {
        value: { won: true, claimId, binding: next },
        next: {
          ...aggregate,
          buildPlanning: {
            ...aggregate.buildPlanning,
            builderBindingsByAssignmentId: {
              ...aggregate.buildPlanning.builderBindingsByAssignmentId,
              [binding.assignmentId]: next,
            },
          },
        },
      };
    });
  }

  private async ensureSession(
    planner: PlanningSessionIdentity,
    binding: BuilderPlanningSessionBinding,
    bootstrap: BuilderBootstrapContext,
    request: OpenPlanningFanoutRequest,
  ): Promise<BuilderPlanningSessionBinding> {
    let current = binding;
    let resumedByThisInvocation = false;
    let session = current.sessionId
      ? this.options.sessionManager.get(current.sessionId)
      : undefined;
    session ??= this.matchingSession(current);
    if (current.sessionId && !session) {
      // A process-local registry miss is not evidence that a session owned by
      // another Studio/coordinator is dead. Preserve the durable authority and
      // let the owning registry or an explicit scoped resume reconcile it.
      return current;
    }
    if (session?.status === "exited") {
      try {
        session = await this.options.sessionManager.resume(session.id, {
          builderPlanning: sessionMetadata(current),
          promptAppendix: serializeBuilderBootstrapContext(bootstrap),
        });
        resumedByThisInvocation = true;
      } catch (error) {
        const observed = this.options.sessionManager.get(session.id);
        if (
          error instanceof SessionAlreadyLiveError &&
          observed?.status === "running"
        ) {
          session = observed;
        } else {
          current = await this.updateBinding(
            current,
            exactLifecycleExpectation(current),
            (value) => ({
              ...value,
              state: "failed",
              failureCode: "resume_failed",
              updatedAt: this.now(),
            }),
          );
          if (session.builderPlanning)
            await this.options.sessionManager
              .setBuilderPlanningMetadata(session.id, sessionMetadata(current))
              .catch(() => {});
          return current;
        }
      }
    }
    if (session) {
      try {
        current = await this.updateBinding(
          current,
          exactLifecycleExpectation(current),
          (value) => ({
            ...value,
            sessionId: session!.id,
            state:
              value.state === "submitted"
                ? "submitted"
                : value.kickoff?.state === "delivered"
                  ? "planning"
                  : "kickoff-pending",
            failureCode: null,
            updatedAt: this.now(),
          }),
        );
      } catch (error) {
        try {
          return await this.readCompatibleBinding(current, {
            requireSessionId: session.id,
          });
        } catch {
          if (resumedByThisInvocation)
            await this.options.sessionManager
              .kill(session.id)
              .catch(() => false);
          throw error;
        }
      }
      if (session.ready) void this.deliverKickoff(current).catch(() => {});
      return current;
    }
    const claim = await this.claimSpawn(current);
    current = claim.binding;
    if (!claim.won) {
      // A different service instance owns the durable creation lease. It may
      // already have crossed create-before-attach, so inventory reconciliation
      // is safe; this loser must never call create itself while the lease lives.
      session = this.matchingSession(current);
      if (!session) return current;
      try {
        current = await this.updateBinding(
          current,
          exactLifecycleExpectation(current),
          (value) => ({
            ...value,
            sessionId: session!.id,
            state:
              value.kickoff?.state === "delivered"
                ? "planning"
                : session!.status === "exited"
                  ? "failed"
                  : "kickoff-pending",
            spawnClaimId: null,
            spawnClaimedAt: null,
            failureCode: session!.status === "exited" ? "spawn_failed" : null,
            updatedAt: this.now(),
          }),
        );
      } catch (error) {
        const reconciled = await this.readCompatibleBinding(current);
        if (reconciled.sessionId) return reconciled;
        throw error;
      }
      return current;
    }
    const claimId = claim.claimId;
    const claimed = current;
    let created: HarnessSession;
    try {
      const root = await this.options.resolveProjectRoot(planner.projectId);
      created = await this.options.sessionManager.create(
        {
          cwd: root,
          harness: request.harness ?? this.options.defaultHarness,
          ...(request.theme ? { theme: request.theme } : {}),
        },
        {
          executionPolicy: "planning-readonly",
          agentMapIdentity: (sessionId) => ({
            projectId: planner.projectId,
            sessionId,
            userId: planner.userId,
            role: "agent-builder",
            assignment: { kind: "planned", agentId: current.plannedAgentId },
          }),
          builderPlanning: () => sessionMetadata(current),
          promptAppendix: () => serializeBuilderBootstrapContext(bootstrap),
        },
      );
    } catch {
      return this.updateBinding(
        claimed,
        {
          sessionId: null,
          spawnEpoch: claimed.spawnEpoch,
          spawnClaimId: claimId,
          state: "spawning",
          kickoffId: null,
        },
        (value) => ({
          ...value,
          state: "failed",
          spawnClaimId: null,
          spawnClaimedAt: null,
          failureCode: "spawn_failed",
          updatedAt: this.now(),
        }),
      );
    }
    const inputId = stableId("kickoff", {
      assignmentId: claimed.assignmentId,
      bootstrapDigest: claimed.bootstrapDigest,
      kind: "input",
    });
    try {
      current = await this.updateBinding(
        claimed,
        {
          sessionId: null,
          spawnEpoch: claimed.spawnEpoch,
          spawnClaimId: claimId,
          state: "spawning",
          kickoffId: null,
        },
        (value) => ({
          ...value,
          sessionId: created.id,
          state: "kickoff-pending",
          spawnClaimId: null,
          spawnClaimedAt: null,
          kickoff: {
            kickoffId: stableId("kickoff", {
              assignmentId: value.assignmentId,
              bootstrapDigest: value.bootstrapDigest,
            }) as BuilderKickoffId,
            inputId,
            state: "pending",
            attemptCount: 0,
            deliveryClaimId: null,
            deliveryClaimedAt: null,
            deliveredAt: null,
            acknowledgedBy: null,
          },
          updatedAt: this.now(),
        }),
      );
    } catch (error) {
      await this.options.sessionManager.kill(created.id).catch(() => false);
      const reconciled = await this.readCompatibleBinding(claimed);
      if (reconciled.sessionId && reconciled.sessionId !== created.id)
        return reconciled;
      throw error;
    }
    try {
      await this.options.sessionManager.setBuilderPlanningMetadata(
        created.id,
        sessionMetadata(current),
      );
      if (created.ready) void this.deliverKickoff(current).catch(() => {});
      return current;
    } catch {
      await this.options.sessionManager.kill(created.id).catch(() => false);
      return this.updateBinding(
        current,
        exactLifecycleExpectation(current),
        (value) => ({
          ...value,
          state: "failed",
          failureCode: "spawn_failed",
          updatedAt: this.now(),
        }),
      );
    }
  }

  async onSessionStatus(session: HarnessSession): Promise<void> {
    if (
      !session.ready ||
      session.executionPolicy !== "planning-readonly" ||
      !session.builderPlanning
    )
      return;
    const aggregate = await this.options.workspaceStore.readAggregate(
      session.agentMapIdentity!.projectId,
    );
    const binding =
      aggregate.buildPlanning.builderBindingsByAssignmentId[
        session.builderPlanning.assignmentId
      ];
    if (binding?.sessionId === session.id) await this.deliverKickoff(binding);
  }

  private async claimKickoffDelivery(
    binding: BuilderPlanningSessionBinding,
  ): Promise<
    | { won: true; claimId: string; binding: BuilderPlanningSessionBinding }
    | { won: false; binding: BuilderPlanningSessionBinding }
  > {
    const claimId = `delivery-claim_${randomUUID()}`;
    const timestamp = this.now();
    const nowMs = Date.parse(timestamp);
    return this.options.workspaceStore.transact<
      | { won: true; claimId: string; binding: BuilderPlanningSessionBinding }
      | { won: false; binding: BuilderPlanningSessionBinding }
    >(binding.projectId, async (aggregate) => {
      const current =
        aggregate.buildPlanning.builderBindingsByAssignmentId[
          binding.assignmentId
        ];
      if (
        !current ||
        !sameBindingContext(current, binding) ||
        current.sessionId !== binding.sessionId ||
        current.spawnEpoch !== binding.spawnEpoch ||
        current.spawnClaimId !== binding.spawnClaimId ||
        current.kickoff?.kickoffId !== binding.kickoff?.kickoffId ||
        current.kickoff?.inputId !== binding.kickoff?.inputId ||
        !current.kickoff ||
        current.state === "stale"
      )
        throw new BuilderPlanningSessionError("binding_stale");
      if (
        current.kickoff.state === "delivered" ||
        current.kickoff.state === "delivery-uncertain"
      )
        return { value: { won: false as const, binding: current } };
      if (current.kickoff.state === "delivering") {
        const claimedAt = current.kickoff.deliveryClaimedAt
          ? Date.parse(current.kickoff.deliveryClaimedAt)
          : Number.NaN;
        const live =
          current.kickoff.deliveryClaimId !== null &&
          Number.isFinite(claimedAt) &&
          nowMs - claimedAt < this.deliveryClaimTtlMs;
        if (live) return { value: { won: false as const, binding: current } };
        const uncertain: BuilderPlanningSessionBinding = {
          ...current,
          state: "delivery-uncertain",
          kickoff: {
            ...current.kickoff,
            state: "delivery-uncertain",
            deliveryClaimId: null,
            deliveryClaimedAt: null,
          },
          updatedAt: timestamp,
        };
        return {
          value: { won: false as const, binding: uncertain },
          next: {
            ...aggregate,
            buildPlanning: {
              ...aggregate.buildPlanning,
              builderBindingsByAssignmentId: {
                ...aggregate.buildPlanning.builderBindingsByAssignmentId,
                [binding.assignmentId]: uncertain,
              },
            },
          },
        };
      }
      const delivering: BuilderPlanningSessionBinding = {
        ...current,
        state: "kickoff-pending",
        kickoff: {
          ...current.kickoff,
          state: "delivering",
          attemptCount: current.kickoff.attemptCount + 1,
          deliveryClaimId: claimId,
          deliveryClaimedAt: timestamp,
        },
        updatedAt: timestamp,
      };
      return {
        value: { won: true as const, claimId, binding: delivering },
        next: {
          ...aggregate,
          buildPlanning: {
            ...aggregate.buildPlanning,
            builderBindingsByAssignmentId: {
              ...aggregate.buildPlanning.builderBindingsByAssignmentId,
              [binding.assignmentId]: delivering,
            },
          },
        },
      };
    });
  }

  private async deliverKickoff(
    binding: BuilderPlanningSessionBinding,
  ): Promise<void> {
    if (
      !binding.sessionId ||
      !binding.kickoff ||
      binding.kickoff.state === "delivered" ||
      binding.kickoff.state === "delivery-uncertain" ||
      binding.state === "stale"
    )
      return;
    const claim = await this.claimKickoffDelivery(binding);
    if (!claim.won) {
      if (claim.binding.state === "delivery-uncertain" && binding.sessionId)
        await this.options.sessionManager
          .setBuilderPlanningMetadata(
            binding.sessionId,
            sessionMetadata(claim.binding),
          )
          .catch(() => {});
      return;
    }
    const delivering = claim.binding;
    const text = kickoffText(delivering.kickoff!.inputId);
    this.expectedKickoffs.set(binding.sessionId, {
      inputId: delivering.kickoff!.inputId,
      text,
    });
    let accepted = false;
    let ambiguous = false;
    try {
      accepted = await this.options.sessionManager.submitInput(
        binding.sessionId,
        text,
        true,
        async () => {
          const latest = (
            await this.options.workspaceStore.readAggregate(binding.projectId)
          ).buildPlanning.builderBindingsByAssignmentId[binding.assignmentId];
          return (
            latest?.sessionId === binding.sessionId &&
            latest.state !== "stale" &&
            latest.kickoff?.state === "delivering" &&
            latest.kickoff.deliveryClaimId === claim.claimId
          );
        },
      );
    } catch (error) {
      // The adapter may have accepted bytes before surfacing an error. Preserve
      // uncertainty and require acknowledgement reconciliation before retry.
      ambiguous = !(
        error instanceof SessionNotReadyError ||
        error instanceof SessionInputGuardRejectedError
      );
    }
    if (!accepted && !ambiguous)
      this.expectedKickoffs.delete(binding.sessionId);
    const uncertain = await this.updateBinding(
      delivering,
      {
        sessionId: delivering.sessionId,
        spawnEpoch: delivering.spawnEpoch,
        spawnClaimId: delivering.spawnClaimId,
        kickoffId: delivering.kickoff?.kickoffId ?? null,
        kickoffInputId: delivering.kickoff?.inputId ?? null,
      },
      (value) => {
        // A prompt hook can be persisted before submitInput returns. Delivered
        // is terminal for this kickoff epoch and must never be downgraded.
        if (value.kickoff?.state === "delivered") return value;
        if (value.kickoff?.deliveryClaimId !== claim.claimId) return value;
        return reconcileKickoffAttempt(value, {
          accepted,
          ambiguous,
          updatedAt: this.now(),
        });
      },
    );
    await this.options.sessionManager
      .setBuilderPlanningMetadata(binding.sessionId, sessionMetadata(uncertain))
      .catch(() => {});
  }

  decorateLocalEvent(event: AnalyticsEvent): AnalyticsEvent {
    if (event.type !== "prompt.submitted") return event;
    const expected = this.expectedKickoffs.get(event.harnessSessionId);
    if (!expected || event.payload.prompt !== expected.text) return event;
    return {
      ...event,
      payload: { ...event.payload, builderKickoffInputId: expected.inputId },
    };
  }

  async onEventPersisted(event: AnalyticsEvent): Promise<void> {
    if (
      event.type !== "prompt.submitted" ||
      typeof event.payload.builderKickoffInputId !== "string"
    )
      return;
    const session = this.options.sessionManager.get(event.harnessSessionId);
    if (
      !session?.builderPlanning ||
      session.executionPolicy !== "planning-readonly"
    )
      return;
    const aggregate = await this.options.workspaceStore.readAggregate(
      session.agentMapIdentity!.projectId,
    );
    const binding =
      aggregate.buildPlanning.builderBindingsByAssignmentId[
        session.builderPlanning.assignmentId
      ];
    if (
      !binding ||
      binding.sessionId !== session.id ||
      binding.kickoff?.inputId !== event.payload.builderKickoffInputId
    )
      return;
    const delivered = await this.updateBinding(
      binding,
      {
        sessionId: session.id,
        spawnEpoch: binding.spawnEpoch,
        spawnClaimId: binding.spawnClaimId,
        kickoffId: binding.kickoff.kickoffId,
        kickoffInputId: binding.kickoff.inputId,
        deliveryClaimId: binding.kickoff.deliveryClaimId,
      },
      (value) => {
        if (
          !value.kickoff ||
          value.kickoff.inputId !== event.payload.builderKickoffInputId ||
          !["delivering", "delivery-uncertain", "delivered"].includes(
            value.kickoff.state,
          )
        )
          throw new BuilderPlanningSessionError("binding_stale");
        return {
          ...value,
          // A late durable acknowledgement resolves delivery, but it must not
          // revive a context that reconciliation already staled or overwrite a
          // terminal submission/failure lifecycle.
          state: ["stale", "submitted", "failed"].includes(value.state)
            ? value.state
            : "planning",
          kickoff: {
            ...value.kickoff,
            state: "delivered",
            deliveryClaimId: null,
            deliveryClaimedAt: null,
            deliveredAt: event.ts,
            acknowledgedBy: { source: "hook", observedAt: event.ts },
          },
          updatedAt: this.now(),
        };
      },
    );
    this.expectedKickoffs.delete(session.id);
    await this.options.sessionManager
      .setBuilderPlanningMetadata(session.id, sessionMetadata(delivered))
      .catch(() => {});
  }

  async reconcileProject(projectId: StudioProjectId): Promise<void> {
    const changed = await this.options.workspaceStore.transact(
      projectId,
      async (aggregate) => {
        const bindings = {
          ...aggregate.buildPlanning.builderBindingsByAssignmentId,
        };
        const stale: BuilderPlanningSessionBinding[] = [];
        for (const [assignmentId, binding] of Object.entries(bindings)) {
          if (binding.state === "stale") continue;
          const assignment =
            aggregate.buildPlanning.assignmentByAgentId[binding.plannedAgentId];
          const currentBrief =
            aggregate.buildPlanning.currentBriefByAgentId[
              binding.plannedAgentId
            ];
          const brief = aggregate.buildPlanning.briefVersionsById[
            binding.brief.briefId
          ]?.find(
            (entry) =>
              entry.version === binding.brief.version &&
              entry.semanticDigest === binding.brief.semanticDigest,
          );
          const boundPlan = aggregate.buildPlanning.planVersions.find(
            (entry) =>
              entry.planId === binding.plan.planId &&
              entry.version === binding.plan.version &&
              entry.semanticDigest === binding.plan.semanticDigest,
          );
          const latestPlan = aggregate.buildPlanning.planVersions.find(
            (entry) =>
              entry.version === aggregate.buildPlanning.currentPlanVersion,
          );
          let reasons: BriefStaleReason[] = [];
          if (
            assignment?.status !== "active" ||
            !isCurrentAgentBrief(brief) ||
            !same(currentBrief, binding.brief)
          ) {
            reasons = [
              {
                code: "assignment-content-changed",
                affectedNodeIds: [binding.plannedAgentId],
                affectedRelationshipIds: [],
                affectedContractIds: [],
              },
            ];
          } else if (
            !boundPlan ||
            !latestPlan ||
            latestPlan.planId !== boundPlan.planId
          ) {
            reasons = [
              {
                code: "shared-plan-content-changed",
                affectedNodeIds: [],
                affectedRelationshipIds: [],
                affectedContractIds: [],
              },
            ];
          } else {
            reasons = proposalStaleReasons(aggregate, binding, brief);
          }
          if (reasons.length === 0) continue;
          const next: BuilderPlanningSessionBinding = {
            ...binding,
            state: "stale",
            staleReasons: reasons.slice(0, 9),
            updatedAt: this.now(),
          };
          bindings[assignmentId] = next;
          stale.push(next);
        }
        if (stale.length === 0) return { value: stale };
        return {
          value: stale,
          next: {
            ...aggregate,
            buildPlanning: {
              ...aggregate.buildPlanning,
              builderBindingsByAssignmentId: bindings,
            },
          },
        };
      },
    );
    for (const binding of changed) {
      const sessions = this.options.sessionManager
        .list()
        .filter(
          (session) =>
            session.agentMapIdentity?.projectId === projectId &&
            session.builderPlanning?.bindingId === binding.bindingId,
        );
      for (const session of sessions)
        await this.options.sessionManager
          .setBuilderPlanningMetadata(
            session.id,
            sessionMetadata(
              binding,
              session.builderPlanning?.primary !== false,
            ),
          )
          .catch(() => {});
    }
  }

  private async bootstrapForBinding(
    binding: BuilderPlanningSessionBinding,
  ): Promise<BuilderBootstrapContext> {
    const aggregate = await this.options.workspaceStore.readAggregate(
      binding.projectId,
    );
    const current =
      aggregate.buildPlanning.builderBindingsByAssignmentId[
        binding.assignmentId
      ];
    if (
      !current ||
      !sameBindingContext(current, binding) ||
      current.sessionId !== binding.sessionId ||
      current.state === "stale"
    )
      throw new BuilderPlanningSessionError("binding_stale");
    const plan = aggregate.buildPlanning.planVersions.find((entry) =>
      same(
        {
          planId: entry.planId,
          version: entry.version,
          semanticDigest: entry.semanticDigest,
        },
        binding.plan,
      ),
    );
    const brief = aggregate.buildPlanning.briefVersionsById[
      binding.brief.briefId
    ]?.find(
      (entry) =>
        entry.version === binding.brief.version &&
        entry.semanticDigest === binding.brief.semanticDigest,
    );
    if (!plan || !isCurrentAgentBrief(brief))
      throw new BuilderPlanningSessionError("binding_stale");
    let graph: AgentMapGraph;
    if (this.options.sourceResolver) {
      graph = (
        await this.options.sourceResolver.resolve(
          binding.projectId,
          binding.source,
        )
      ).graph;
    } else if (
      binding.source.kind === "proposal" &&
      aggregate.proposal?.id === binding.source.proposalId &&
      aggregate.proposal.version === binding.source.version
    ) {
      graph = {
        nodes: aggregate.proposal.nodes,
        relationships: aggregate.proposal.relationships,
      };
    } else {
      throw new BuilderPlanningSessionError("binding_stale");
    }
    const bootstrap = createBuilderBootstrapContext({ plan, graph, brief });
    if (bootstrap.contextDigest !== binding.bootstrapDigest)
      throw new BuilderPlanningSessionError("context_mismatch");
    return bootstrap;
  }

  async resume(
    projectId: StudioProjectId,
    sessionId: string,
  ): Promise<HarnessSession> {
    await this.reconcileProject(projectId);
    const session = this.options.sessionManager.get(sessionId);
    const identity = session?.agentMapIdentity;
    const metadata = session?.builderPlanning;
    if (
      !session ||
      session.executionPolicy !== "planning-readonly" ||
      !metadata ||
      !identity ||
      identity.projectId !== projectId ||
      identity.userId !== this.options.currentUserId() ||
      identity.role !== "agent-builder" ||
      identity.assignment.kind !== "planned"
    )
      throw new BuilderPlanningSessionError("forbidden");
    const aggregate =
      await this.options.workspaceStore.readAggregate(projectId);
    const binding =
      aggregate.buildPlanning.builderBindingsByAssignmentId[
        metadata.assignmentId
      ];
    const primary = metadata.primary !== false;
    if (
      !binding ||
      binding.projectId !== projectId ||
      !binding.sessionId ||
      (primary
        ? binding.sessionId !== sessionId
        : binding.sessionId === sessionId) ||
      binding.state === "stale" ||
      metadata.plannedAgentId !== binding.plannedAgentId ||
      identity.assignment.agentId !== binding.plannedAgentId ||
      !exactContext(
        binding,
        metadata,
        metadata.assignmentId,
        metadata.brief,
        metadata.bootstrapDigest,
      )
    )
      throw new BuilderPlanningSessionError("binding_stale");
    const bootstrap = await this.bootstrapForBinding(binding);
    let resumed: HarnessSession | undefined;
    try {
      resumed = await this.options.sessionManager.resume(sessionId, {
        builderPlanning: session.builderPlanning!,
        promptAppendix: serializeBuilderBootstrapContext(bootstrap),
      });
      if (!primary) {
        // Secondary tabs share the primary's exact trusted context but never
        // own or transition its durable binding. Resume only this secondary
        // logical session and refresh its read-only lifecycle projection.
        const confirmed = await this.readCompatibleBinding(binding, {
          requireSessionId: binding.sessionId,
        });
        if (
          confirmed.sessionId !== binding.sessionId ||
          confirmed.state === "stale"
        )
          throw new BuilderPlanningSessionError("binding_stale");
        await this.options.sessionManager.setBuilderPlanningMetadata(
          sessionId,
          sessionMetadata(confirmed, false),
        );
        return resumed;
      }
      const next = await this.updateBinding(
        binding,
        exactLifecycleExpectation(binding),
        (current) => ({
          ...current,
          state:
            current.state === "submitted"
              ? "submitted"
              : current.kickoff?.state === "delivered"
                ? "planning"
                : "kickoff-pending",
          failureCode: null,
          updatedAt: this.now(),
        }),
      );
      await this.options.sessionManager.setBuilderPlanningMetadata(
        sessionId,
        sessionMetadata(next),
      );
      return resumed;
    } catch (error) {
      if (error instanceof SessionAlreadyLiveError) throw error;
      if (error instanceof BuilderPlanningSessionError) {
        if (!resumed) throw error;
        try {
          const confirmed = await this.readCompatibleBinding(binding, {
            requireSessionId: binding.sessionId,
          });
          await this.options.sessionManager.setBuilderPlanningMetadata(
            sessionId,
            sessionMetadata(confirmed, primary),
          );
          return resumed;
        } catch {
          await this.options.sessionManager.kill(sessionId).catch(() => false);
          throw error;
        }
      }
      if (!primary) {
        if (resumed)
          await this.options.sessionManager.kill(sessionId).catch(() => false);
        throw error;
      }
      const failed = await this.updateBinding(
        binding,
        exactLifecycleExpectation(binding),
        (current) => ({
          ...current,
          state: "failed",
          failureCode: "resume_failed",
          updatedAt: this.now(),
        }),
      );
      await this.options.sessionManager
        .setBuilderPlanningMetadata(sessionId, sessionMetadata(failed))
        .catch(() => {});
      throw error;
    }
  }

  async openAdditionalSession(
    projectId: StudioProjectId,
    primarySessionId: string,
    options: { harness?: HarnessKind; theme?: UiTheme } = {},
  ): Promise<HarnessSession> {
    await this.reconcileProject(projectId);
    const primary = this.options.sessionManager.get(primarySessionId);
    const identity = primary?.agentMapIdentity;
    const metadata = primary?.builderPlanning;
    if (
      !primary ||
      primary.executionPolicy !== "planning-readonly" ||
      !metadata ||
      metadata.primary === false ||
      !identity ||
      identity.projectId !== projectId ||
      identity.userId !== this.options.currentUserId() ||
      identity.role !== "agent-builder" ||
      identity.assignment.kind !== "planned"
    )
      throw new BuilderPlanningSessionError("forbidden");
    const aggregate =
      await this.options.workspaceStore.readAggregate(projectId);
    const binding =
      aggregate.buildPlanning.builderBindingsByAssignmentId[
        metadata.assignmentId
      ];
    if (
      !binding ||
      binding.sessionId !== primarySessionId ||
      binding.state === "stale" ||
      binding.state === "failed"
    )
      throw new BuilderPlanningSessionError("binding_stale");
    const bootstrap = await this.bootstrapForBinding(binding);
    const root = await this.options.resolveProjectRoot(projectId);
    const plannedAgentId = identity.assignment.agentId;
    return this.options.sessionManager.create(
      {
        cwd: root,
        harness: options.harness ?? primary.harness,
        ...(options.theme ? { theme: options.theme } : {}),
      },
      {
        executionPolicy: "planning-readonly",
        agentMapCapability: false,
        agentMapIdentity: (sessionId) => ({
          projectId,
          sessionId,
          userId: identity.userId,
          role: "agent-builder",
          assignment: {
            kind: "planned",
            agentId: plannedAgentId,
          },
        }),
        builderPlanning: () => sessionMetadata(binding, false),
        promptAppendix: () => serializeBuilderBootstrapContext(bootstrap),
      },
    );
  }

  async reconcile(): Promise<void> {
    const projects = new Set<StudioProjectId>();
    for (const session of this.options.sessionManager.list()) {
      const projectId = session.agentMapIdentity?.projectId;
      if (session.builderPlanning && projectId) projects.add(projectId);
    }
    for (const projectId of projects)
      await this.reconcileProject(projectId).catch(() => {});
    for (const session of this.options.sessionManager.list()) {
      if (
        !session.builderPlanning ||
        session.executionPolicy !== "planning-readonly"
      )
        continue;
      const aggregate = await this.options.workspaceStore
        .readAggregate(session.agentMapIdentity!.projectId)
        .catch(() => null);
      const binding =
        aggregate?.buildPlanning.builderBindingsByAssignmentId[
          session.builderPlanning.assignmentId
        ];
      if (!binding || binding.sessionId !== session.id || !binding.kickoff)
        continue;
      if (
        ["delivering", "delivery-uncertain"].includes(binding.kickoff.state)
      ) {
        this.expectedKickoffs.set(session.id, {
          inputId: binding.kickoff.inputId,
          text: kickoffText(binding.kickoff.inputId),
        });
      }
      if (binding.kickoff.state === "delivering") {
        const claim = await this.claimKickoffDelivery(binding).catch(
          () => null,
        );
        if (claim && !claim.won && claim.binding.state === "delivery-uncertain")
          await this.options.sessionManager
            .setBuilderPlanningMetadata(
              session.id,
              sessionMetadata(claim.binding),
            )
            .catch(() => {});
      }
      if (session.ready && binding.kickoff.state === "pending")
        void this.deliverKickoff(binding).catch(() => {});
    }
  }

  /** Stable identity/scope check used before durable proposal receipt replay. */
  assertProposalIdentityAuthorized(
    identity: PlanningSessionIdentity,
    aggregate: AgentMapProjectAggregate,
  ): void {
    if (
      identity.role !== "agent-builder" ||
      identity.assignment.kind !== "planned"
    )
      return;
    const session = this.options.sessionManager.get(identity.sessionId);
    const metadata = session?.builderPlanning;
    if (
      identity.userId !== this.options.currentUserId() ||
      identity.projectId !== aggregate.workspace.projectId ||
      !session ||
      session.agentMapIdentity?.projectId !== identity.projectId ||
      session.agentMapIdentity.userId !== identity.userId ||
      session.agentMapIdentity.role !== "agent-builder" ||
      session.agentMapIdentity.assignment.kind !== "planned" ||
      session.agentMapIdentity.assignment.agentId !==
        identity.assignment.agentId ||
      session.executionPolicy !== "planning-readonly" ||
      !metadata ||
      metadata.primary === false ||
      metadata.plannedAgentId !== identity.assignment.agentId
    )
      throw new BuilderPlanningSessionError("forbidden");
  }

  /** First-commit freshness check under the proposal transaction. A planned
   * builder may author one direct successor only while its primary binding is
   * current and actively planning. */
  assertProposalMutationAuthorized(
    identity: PlanningSessionIdentity,
    aggregate: AgentMapProjectAggregate,
  ): void {
    if (
      identity.role !== "agent-builder" ||
      identity.assignment.kind !== "planned"
    )
      return;
    this.assertProposalIdentityAuthorized(identity, aggregate);
    const session = this.options.sessionManager.get(identity.sessionId)!;
    const metadata = session?.builderPlanning;
    const binding = metadata
      ? aggregate.buildPlanning.builderBindingsByAssignmentId[
          metadata.assignmentId
        ]
      : undefined;
    const currentBrief = binding
      ? aggregate.buildPlanning.currentBriefByAgentId[binding.plannedAgentId]
      : undefined;
    const proposal = aggregate.proposal;
    if (
      identity.userId !== this.options.currentUserId() ||
      !session ||
      session.executionPolicy !== "planning-readonly" ||
      !metadata ||
      metadata?.primary === false ||
      metadata.plannedAgentId !== identity.assignment.agentId ||
      !binding ||
      binding.sessionId !== identity.sessionId ||
      binding.state !== "planning" ||
      binding.kickoff?.state !== "delivered" ||
      !same(currentBrief, binding.brief) ||
      !exactContext(
        binding,
        binding,
        binding.assignmentId,
        binding.brief,
        binding.bootstrapDigest,
      ) ||
      binding.source.kind !== "proposal" ||
      aggregate.workspace.activeProposalId !== binding.source.proposalId ||
      proposal?.id !== binding.source.proposalId ||
      proposal.version !== binding.source.version ||
      computeArchitectureGraphDigest({
        nodes: proposal.nodes,
        relationships: proposal.relationships,
      }) !== binding.source.graphDigest
    )
      throw new BuilderPlanningSessionError("binding_stale");
  }

  private directSuccessorRecords(
    aggregate: AgentMapProjectAggregate,
    binding: BuilderPlanningSessionBinding,
    identity: Extract<
      PlanningSessionIdentity,
      { role: "agent-builder"; assignment: { kind: "planned" } }
    >,
  ): ProposalOperationRecord[] | null {
    if (
      binding.source.kind !== "proposal" ||
      aggregate.workspace.activeProposalId !== binding.source.proposalId ||
      aggregate.proposal?.id !== binding.source.proposalId ||
      aggregate.proposal.version < binding.source.version + 1
    )
      return null;
    const source = binding.source;
    const records = aggregate.proposal.history.filter(
      (entry) => entry.acceptedVersion === source.version + 1,
    );
    if (
      records.length === 0 ||
      records.some(
        (entry) =>
          entry.actor.sessionId !== identity.sessionId ||
          entry.actor.userId !== identity.userId ||
          entry.actor.role !== "agent-builder" ||
          entry.actor.assignment?.kind !== "planned" ||
          entry.actor.assignment.agentId !== identity.assignment.agentId,
      )
    )
      return null;
    const directKeys = new Set(
      records.flatMap((entry) =>
        proposalOperationConflictKeys(entry.operation),
      ),
    );
    const superseded = aggregate.proposal.history
      .filter((entry) => entry.acceptedVersion > source.version + 1)
      .some((entry) =>
        proposalOperationConflictKeys(entry.operation).some((key) =>
          directKeys.has(key),
        ),
      );
    if (superseded) return null;
    return records;
  }

  async submitResult(
    identity: PlanningSessionIdentity,
    raw: unknown,
  ): Promise<BuilderPlanningSubmission> {
    if (
      identity.role !== "agent-builder" ||
      identity.assignment.kind !== "planned" ||
      identity.userId !== this.options.currentUserId()
    )
      throw new BuilderPlanningSessionError("forbidden");
    const builderIdentity = identity as Extract<
      PlanningSessionIdentity,
      { role: "agent-builder"; assignment: { kind: "planned" } }
    >;
    const parsed = planningResultSubmitRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BuilderPlanningSessionError(
        "invalid_request",
        parsed.error.issues.slice(0, 64).map((issue) => ({
          path: issue.path.join("."),
          message: issue.code,
        })),
      );
    }
    const request = parsed.data as unknown as PlanningResultSubmitRequest;
    const session = this.options.sessionManager.get(identity.sessionId);
    if (
      !session?.builderPlanning ||
      session.executionPolicy !== "planning-readonly" ||
      session.builderPlanning.plannedAgentId !== identity.assignment.agentId
    )
      throw new BuilderPlanningSessionError("forbidden");
    if (
      !same(request.expected, {
        assignmentId: session.builderPlanning.assignmentId,
        source: session.builderPlanning.source,
        plan: session.builderPlanning.plan,
        brief: session.builderPlanning.brief,
        bootstrapDigest: session.builderPlanning.bootstrapDigest,
      })
    )
      throw new BuilderPlanningSessionError("context_mismatch");
    const requestDigest = computeCanonicalDigest(
      "sapiom.planning-result-request.v1",
      request,
    );
    const submittedAt = this.now();
    const submissionId = stableId("submission", {
      sessionId: identity.sessionId,
      requestId: request.requestId,
    });
    const committed = await this.options.workspaceStore.transact<{
      submission: BuilderPlanningSubmission;
      replayed: boolean;
    }>(identity.projectId, async (aggregate) => {
      const receipt = aggregate.buildPlanning.planningSubmissionReceipts.find(
        (entry) =>
          entry.sessionId === identity.sessionId &&
          entry.requestId === request.requestId,
      );
      const historical = Object.values(
        aggregate.buildPlanning.submissionsByAssignmentId,
      )
        .flat()
        .find(
          (entry) =>
            entry.sessionId === identity.sessionId &&
            entry.requestId === request.requestId,
        );
      if (receipt || historical) {
        const priorDigest = receipt?.requestDigest ?? historical?.requestDigest;
        if (priorDigest !== requestDigest)
          throw new BuilderPlanningSessionError("idempotency_key_reused");
        const replay =
          historical ??
          Object.values(aggregate.buildPlanning.submissionsByAssignmentId)
            .flat()
            .find((entry) => entry.submissionId === receipt?.submissionId);
        if (!replay) throw new BuilderPlanningSessionError("context_mismatch");
        return { value: { submission: replay, replayed: true as const } };
      }
      const binding =
        aggregate.buildPlanning.builderBindingsByAssignmentId[
          request.expected.assignmentId
        ];
      if (
        !binding ||
        binding.sessionId !== identity.sessionId ||
        binding.state === "stale" ||
        !exactContext(
          binding,
          request.expected,
          request.expected.assignmentId as PlanningAssignmentId,
          request.expected.brief as AgentBriefRef,
          request.expected.bootstrapDigest,
        )
      )
        throw new BuilderPlanningSessionError("binding_stale");
      const latestPlan = aggregate.buildPlanning.planVersions.find(
        (candidate) =>
          candidate.version === aggregate.buildPlanning.currentPlanVersion,
      );
      const bindingPlan = aggregate.buildPlanning.planVersions.find(
        (candidate) =>
          same(
            {
              planId: candidate.planId,
              version: candidate.version,
              semanticDigest: candidate.semanticDigest,
            },
            binding.plan,
          ),
      );
      const latestBrief =
        aggregate.buildPlanning.currentBriefByAgentId[binding.plannedAgentId];
      const bindingBrief = aggregate.buildPlanning.briefVersionsById[
        binding.brief.briefId
      ]?.find(
        (candidate) =>
          candidate.version === binding.brief.version &&
          candidate.semanticDigest === binding.brief.semanticDigest,
      );
      const proposalGraph = aggregate.proposal
        ? {
            nodes: aggregate.proposal.nodes,
            relationships: aggregate.proposal.relationships,
          }
        : null;
      const directSuccessor = this.directSuccessorRecords(
        aggregate,
        binding,
        builderIdentity,
      );
      const proposalIsBoundSource =
        binding.source.kind === "proposal" &&
        aggregate.workspace.activeProposalId === binding.source.proposalId &&
        aggregate.proposal?.id === binding.source.proposalId &&
        aggregate.proposal.version === binding.source.version &&
        proposalGraph !== null &&
        computeArchitectureGraphDigest(proposalGraph) ===
          binding.source.graphDigest;
      const proposalIsCompatible =
        isCurrentAgentBrief(bindingBrief) &&
        proposalStaleReasons(aggregate, binding, bindingBrief).length === 0;
      if (
        !latestPlan ||
        !bindingPlan ||
        latestPlan.planId !== bindingPlan.planId ||
        !isCurrentAgentBrief(bindingBrief) ||
        bindingBrief.assignmentId !== binding.assignmentId ||
        bindingBrief.plannedAgentId !== binding.plannedAgentId ||
        !same(latestBrief, binding.brief) ||
        !same(bindingPlan.source, binding.source) ||
        !same(bindingBrief.source, binding.source) ||
        !proposalIsCompatible ||
        (proposalIsBoundSource &&
          createBuilderBootstrapContext({
            plan: bindingPlan,
            graph: proposalGraph!,
            brief: bindingBrief,
          }).contextDigest !== binding.bootstrapDigest)
      )
        throw new BuilderPlanningSessionError("binding_stale");
      if (request.status === "changes-proposed") {
        const requested = [...request.proposedMapOperationIds].sort();
        const allowed = directSuccessor?.map((entry) => entry.id).sort();
        if (!allowed || !same(requested, allowed))
          throw new BuilderPlanningSessionError("invalid_proposal_operations");
      } else if (request.proposedMapOperationIds.length > 0 || directSuccessor)
        throw new BuilderPlanningSessionError("invalid_proposal_operations");
      const history =
        aggregate.buildPlanning.submissionsByAssignmentId[
          binding.assignmentId
        ] ?? [];
      if (history.length >= 1_024)
        throw new BuilderPlanningSessionError("invalid_request");
      const draft = {
        schemaVersion: 1 as const,
        submissionId,
        projectId: identity.projectId,
        assignmentId: binding.assignmentId,
        sessionId: identity.sessionId,
        requestId: request.requestId,
        requestDigest,
        source: binding.source,
        plan: binding.plan,
        brief: binding.brief,
        status: request.status,
        implementationPlan: request.implementationPlan,
        risks: request.risks,
        questions: request.questions,
        proposedMapOperationIds: request.proposedMapOperationIds,
        supersedesSubmissionId: history.at(-1)?.submissionId ?? null,
        semanticDigest: "sha256:" + "0".repeat(64),
        recordDigest: "sha256:" + "0".repeat(64),
        submittedAt,
      } as unknown as BuilderPlanningSubmission;
      draft.semanticDigest = computePlanningSubmissionSemanticDigest(draft);
      draft.recordDigest = computePlanningSubmissionRecordDigest(draft);
      const submission = builderPlanningSubmissionSchema.parse(
        draft,
      ) as unknown as BuilderPlanningSubmission;
      const nextBinding = {
        ...binding,
        state: "submitted" as const,
        updatedAt: submittedAt,
      };
      const nextReceipt: PlanningSubmissionIdempotencyReceipt = {
        sessionId: identity.sessionId,
        requestId: request.requestId,
        requestDigest,
        submissionId: submission.submissionId,
      };
      return {
        value: { submission, replayed: false as const },
        next: {
          ...aggregate,
          buildPlanning: {
            ...aggregate.buildPlanning,
            submissionsByAssignmentId: {
              ...aggregate.buildPlanning.submissionsByAssignmentId,
              [binding.assignmentId]: [...history, submission],
            },
            planningSubmissionReceipts: [
              ...aggregate.buildPlanning.planningSubmissionReceipts,
              nextReceipt,
            ].slice(-PLANNING_SUBMISSION_RECEIPT_WINDOW),
            builderBindingsByAssignmentId: {
              ...aggregate.buildPlanning.builderBindingsByAssignmentId,
              [binding.assignmentId]: nextBinding,
            },
          },
        },
      };
    });
    if (!committed.replayed)
      await this.options.sessionManager.setBuilderPlanningMetadata(
        identity.sessionId,
        { ...session.builderPlanning, state: "submitted" },
      );
    return committed.submission;
  }
}
