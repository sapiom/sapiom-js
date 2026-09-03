import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  PlanNodeId,
  PlanningSessionIdentity,
} from "../shared/agent-map.js";
import {
  architectureSourceRefsEqual,
  BUILD_PLAN_ID_MAPPING_LIMIT,
  type AcceptanceCriterion,
  type AgentAssignmentIntent,
  type AgentBriefId,
  type AgentBriefVersionRecord,
  type ArchitectureSourceRef,
  type BriefStaleReason,
  type BuildMilestone,
  type BuildPlanId,
  type BuildPlanIdempotencyReceipt,
  type BuildPlanIdMapping,
  type BuildPlanImpactEvaluator,
  type BuildPlanRef,
  type PlanDecision,
  type PlanningAssignmentId,
  type PlanningAssignmentRef,
  type ProjectBuildPlanVersion,
  type RepositoryIntent,
} from "../shared/build-plan.js";
import { parseProjectBuildPlanVersion } from "../shared/build-plan-codec.js";
import {
  ArchitectureSourceResolutionError,
  type ResolvedArchitectureSource,
} from "./architecture-source-resolver.js";
import {
  canonicalJson,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";
import type { ExactArchitectureSourceResolver } from "./build-plan-contract-validator.js";
import { BuildPlanContractValidator } from "./build-plan-contract-validator.js";
import {
  BuildPlanStore,
  BuildPlanStoreConflictError,
  BuildPlanStoreLimitError,
} from "./build-plan-store.js";
import {
  BUILD_PLAN_MAX_DIAGNOSTICS,
  buildPlanApplyRequestSchema,
  buildPlanReadInputSchema,
  buildPlanRebaseRequestSchema,
  buildPlanValidateRequestSchema,
  type BuildPlanApplyRequest,
  type BuildPlanOperation,
  type BuildPlanValidateRequest,
} from "./build-plan-schema.js";

export type BuildPlanServiceErrorCode =
  | "plan_not_found"
  | "plan_version_conflict"
  | "source_not_found"
  | "source_mismatch"
  | "source_digest_mismatch"
  | "cross_project_reference"
  | "invalid_operation"
  | "invalid_reference"
  | "incomplete_plan"
  | "rebase_conflict"
  | "idempotency_key_reused"
  | "forbidden_role"
  | "result_too_large"
  | "authoring_unavailable"
  | "revision_source_unavailable";

export interface BuildPlanSafeIssue {
  path?: string;
  message: string;
  relatedIds?: readonly string[];
}

export class BuildPlanServiceError extends Error {
  constructor(
    readonly code: BuildPlanServiceErrorCode,
    readonly issues: readonly BuildPlanSafeIssue[] = [],
    readonly currentPlan?: BuildPlanRef,
  ) {
    super(code.replace(/_/gu, " "));
    this.name = "BuildPlanServiceError";
  }
}

export interface BriefChangeSummary {
  plannedAgentId: PlanNodeId;
  change: "created" | "changed" | "staled" | "preserved";
}

export interface AgentBriefCompileResult {
  briefs: readonly AgentBriefVersionRecord[];
  changes: readonly BriefChangeSummary[];
}

/** SAP-3070 implements this boundary; this ticket only orchestrates it. */
export interface AgentBriefCompiler {
  compile(input: {
    plan: ProjectBuildPlanVersion;
    graph: AgentMapGraph;
    currentBriefs: readonly AgentBriefVersionRecord[];
    assignments: readonly PlanningAssignmentRef[];
  }): Promise<AgentBriefCompileResult>;
}

export class BuildPlanDependencyUnavailableError extends Error {
  constructor(readonly dependency: "brief-compiler" | "impact-evaluator") {
    super(`Build plan ${dependency} is unavailable`);
    this.name = "BuildPlanDependencyUnavailableError";
  }
}

/** Fail-closed production seam until SAP-3070 supplies the real compiler. */
export const unavailableAgentBriefCompiler: AgentBriefCompiler = {
  compile: async () => {
    throw new BuildPlanDependencyUnavailableError("brief-compiler");
  },
};

/** Fail-closed production seam until SAP-3070 supplies the real evaluator. */
export const unavailableBuildPlanImpactEvaluator: BuildPlanImpactEvaluator = {
  evaluate: async () => {
    throw new BuildPlanDependencyUnavailableError("impact-evaluator");
  },
};

export interface Clock {
  now(): Date;
}

export interface BuildPlanServiceDependencies {
  store: BuildPlanStore;
  sourceResolver: ExactArchitectureSourceResolver;
  contractValidator: BuildPlanContractValidator;
  briefCompiler: AgentBriefCompiler;
  impactEvaluator: BuildPlanImpactEvaluator;
  clock: Clock;
}

const BUILD_PLAN_MAX_RESULT_BYTES = 512_000;
const requestDigest = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update("sapiom.build-plan.request.v1\0")
    .update(canonicalJson(value))
    .digest("hex")}`;
const planRef = (plan: ProjectBuildPlanVersion): BuildPlanRef => ({
  planId: plan.planId,
  version: plan.version,
  semanticDigest: plan.semanticDigest,
});
const deterministicId = (prefix: string, seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

function assertPlanner(identity: PlanningSessionIdentity): void {
  if (identity.role !== "map-planner")
    throw new BuildPlanServiceError("forbidden_role");
}

function currentBriefs(
  planning: Awaited<ReturnType<BuildPlanStore["read"]>>,
): AgentBriefVersionRecord[] {
  return Object.values(planning.currentBriefByAgentId)
    .map((ref) =>
      planning.briefVersionsById[ref.briefId]?.find(
        (brief) => brief.version === ref.version,
      ),
    )
    .filter((brief): brief is AgentBriefVersionRecord => Boolean(brief));
}

function briefsForPlan(
  planning: Awaited<ReturnType<BuildPlanStore["read"]>>,
  plan: ProjectBuildPlanVersion,
): AgentBriefVersionRecord[] {
  return Object.values(planning.briefVersionsById)
    .flat()
    .filter(
      (brief) =>
        brief.plan.planId === plan.planId &&
        brief.plan.version === plan.version &&
        brief.plan.semanticDigest === plan.semanticDigest,
    );
}

function replaceBy<T>(
  items: readonly T[],
  value: T,
  key: (item: T) => string,
): T[] {
  const id = key(value);
  return [...items.filter((item) => key(item) !== id), value];
}

function seedIdentityValues(
  plan: ProjectBuildPlanVersion | undefined,
): string[] {
  if (!plan) return [];
  return [
    ...plan.milestones.map((item) => item.milestoneId),
    ...plan.integrationCriteria.map((item) => item.criterionId),
    ...plan.unresolvedDecisions.map((item) => item.decisionId),
    ...plan.assignments.flatMap((assignment) => [
      ...assignment.deliverables.map((item) => item.deliverableId),
      ...assignment.acceptanceCriteria.map((item) => item.criterionId),
      ...assignment.unresolvedDecisions.map((item) => item.decisionId),
    ]),
  ];
}

type AuthoredIdentity = string | Readonly<{ clientRef: string }>;

interface BuildPlanClientIdResolver {
  declare(kind: BuildPlanIdMapping["kind"], clientRef: string): string;
  resolve(kind: BuildPlanIdMapping["kind"], clientRef: string): string;
}

function resolveExistingIdentity(
  value: AuthoredIdentity,
  kind: BuildPlanIdMapping["kind"],
  existingAtStart: ReadonlySet<string>,
  existingProspective: ReadonlySet<string>,
  resolver: BuildPlanClientIdResolver,
  path: string,
): string {
  const id =
    typeof value === "string" ? value : resolver.resolve(kind, value.clientRef);
  const exists =
    typeof value === "string"
      ? existingAtStart.has(id) && existingProspective.has(id)
      : existingProspective.has(id);
  if (!exists)
    throw new BuildPlanServiceError("invalid_operation", [
      {
        path,
        message:
          typeof value === "string"
            ? "Canonical IDs in update operations must already exist at this scope"
            : "Client references in update operations must name a record created earlier in this batch at this scope",
      },
    ]);
  return id;
}

function assertCreateTargetAbsent(exists: boolean, path: string): void {
  if (exists)
    throw new BuildPlanServiceError("invalid_operation", [
      {
        path,
        message:
          "Create operations cannot replace an existing or prospectively created record; use its update operation",
      },
    ]);
}

/** Pure authoring reducer shared by validate and apply. */
export function applyBuildPlanOperations(
  base: ProjectBuildPlanVersion,
  operations: readonly BuildPlanOperation[],
  clientIds: BuildPlanClientIdResolver,
): ProjectBuildPlanVersion {
  const next = structuredClone(base);
  const baseMilestoneIds = new Set<string>(
    base.milestones.map((item) => item.milestoneId),
  );
  for (const operation of operations) {
    const prospectiveMilestoneIds = () =>
      new Set<string>(next.milestones.map((item) => item.milestoneId));
    switch (operation.op) {
      case "set-project-outcome":
        next.outcome = operation.outcome;
        break;
      case "upsert-milestone": {
        const milestoneId = resolveExistingIdentity(
          operation.milestone.milestoneId,
          "milestone",
          baseMilestoneIds,
          prospectiveMilestoneIds(),
          clientIds,
          "operations.milestone.milestoneId",
        );
        const dependsOn = operation.milestone.dependsOn.map((reference) =>
          resolveExistingIdentity(
            reference,
            "milestone",
            baseMilestoneIds,
            prospectiveMilestoneIds(),
            clientIds,
            "operations.milestone.dependsOn",
          ),
        );
        next.milestones = replaceBy(
          next.milestones,
          {
            ...operation.milestone,
            milestoneId,
            dependsOn,
          } as unknown as BuildMilestone,
          (item) => item.milestoneId,
        );
        break;
      }
      case "create-milestone": {
        const milestoneId = clientIds.declare("milestone", operation.clientRef);
        assertCreateTargetAbsent(
          prospectiveMilestoneIds().has(milestoneId),
          "operations.clientRef",
        );
        const dependsOn = operation.milestone.dependsOn.map((reference) =>
          resolveExistingIdentity(
            reference,
            "milestone",
            baseMilestoneIds,
            prospectiveMilestoneIds(),
            clientIds,
            "operations.milestone.dependsOn",
          ),
        );
        next.milestones = replaceBy(
          next.milestones,
          {
            ...operation.milestone,
            milestoneId,
            dependsOn,
          } as unknown as BuildMilestone,
          (item) => item.milestoneId,
        );
        break;
      }
      case "remove-milestone":
        next.milestones = next.milestones.filter(
          (item) => item.milestoneId !== operation.milestoneId,
        );
        break;
      case "set-shared-constraints":
        next.sharedConstraints = operation.constraints;
        break;
      case "set-repository-intents":
        next.repositoryIntents =
          operation.repositories as unknown as readonly RepositoryIntent[];
        break;
      case "set-integration-criteria": {
        const baseIds = new Set(
          base.integrationCriteria.map((item) => item.criterionId),
        );
        const prospectiveIds = new Set(
          next.integrationCriteria.map((item) => item.criterionId),
        );
        next.integrationCriteria = operation.criteria.map((criterion) => ({
          ...criterion,
          criterionId: resolveExistingIdentity(
            criterion.criterionId,
            "criterion",
            baseIds,
            prospectiveIds,
            clientIds,
            "operations.criteria.criterionId",
          ),
        })) as unknown as readonly AcceptanceCriterion[];
        break;
      }
      case "create-integration-criterion": {
        const criterionId = clientIds.declare(
          "criterion",
          operation.criterion.clientRef,
        );
        assertCreateTargetAbsent(
          next.integrationCriteria.some(
            (item) => item.criterionId === criterionId,
          ),
          "operations.criterion.clientRef",
        );
        next.integrationCriteria = replaceBy(
          next.integrationCriteria,
          {
            criterionId,
            ordinal: operation.criterion.ordinal,
            description: operation.criterion.description,
            verification: operation.criterion.verification,
          } as AcceptanceCriterion,
          (item) => item.criterionId,
        );
        break;
      }
      case "upsert-agent-assignment": {
        const baseAssignment = base.assignments.find(
          (item) => item.plannedAgentId === operation.assignment.plannedAgentId,
        );
        const prospectiveAssignment = next.assignments.find(
          (item) => item.plannedAgentId === operation.assignment.plannedAgentId,
        );
        const resolveScoped = (
          value: AuthoredIdentity,
          kind: BuildPlanIdMapping["kind"],
          fromBase: readonly string[],
          fromProspective: readonly string[],
          path: string,
        ) =>
          resolveExistingIdentity(
            value,
            kind,
            new Set(fromBase),
            new Set(fromProspective),
            clientIds,
            path,
          );
        const baseCriterionIds =
          baseAssignment?.acceptanceCriteria.map((item) => item.criterionId) ??
          [];
        const prospectiveCriterionIds =
          prospectiveAssignment?.acceptanceCriteria.map(
            (item) => item.criterionId,
          ) ?? [];
        const acceptanceCriteria = operation.assignment.acceptanceCriteria.map(
          (criterion) => ({
            ...criterion,
            criterionId: resolveScoped(
              criterion.criterionId,
              "criterion",
              baseCriterionIds,
              prospectiveCriterionIds,
              "operations.assignment.acceptanceCriteria.criterionId",
            ),
          }),
        );
        const deliverables = operation.assignment.deliverables.map(
          (deliverable) => ({
            ...deliverable,
            deliverableId: resolveScoped(
              deliverable.deliverableId,
              "deliverable",
              baseAssignment?.deliverables.map((item) => item.deliverableId) ??
                [],
              prospectiveAssignment?.deliverables.map(
                (item) => item.deliverableId,
              ) ?? [],
              "operations.assignment.deliverables.deliverableId",
            ),
            acceptanceCriterionIds: deliverable.acceptanceCriterionIds.map(
              (reference) =>
                resolveScoped(
                  reference,
                  "criterion",
                  baseCriterionIds,
                  prospectiveCriterionIds,
                  "operations.assignment.deliverables.acceptanceCriterionIds",
                ),
            ),
          }),
        );
        const unresolvedDecisions =
          operation.assignment.unresolvedDecisions.map((decision) => ({
            ...decision,
            decisionId: resolveScoped(
              decision.decisionId,
              "decision",
              baseAssignment?.unresolvedDecisions.map(
                (item) => item.decisionId,
              ) ?? [],
              prospectiveAssignment?.unresolvedDecisions.map(
                (item) => item.decisionId,
              ) ?? [],
              "operations.assignment.unresolvedDecisions.decisionId",
            ),
          }));
        next.assignments = replaceBy(
          next.assignments,
          {
            ...operation.assignment,
            acceptanceCriteria,
            deliverables,
            milestoneIds: operation.assignment.milestoneIds.map((reference) =>
              resolveExistingIdentity(
                reference,
                "milestone",
                baseMilestoneIds,
                prospectiveMilestoneIds(),
                clientIds,
                "operations.assignment.milestoneIds",
              ),
            ),
            unresolvedDecisions,
          } as unknown as AgentAssignmentIntent,
          (item) => item.plannedAgentId,
        );
        break;
      }
      case "create-agent-assignment": {
        assertCreateTargetAbsent(
          next.assignments.some(
            (item) =>
              item.plannedAgentId === operation.assignment.plannedAgentId,
          ),
          "operations.assignment.plannedAgentId",
        );
        const criteria = operation.assignment.acceptanceCriteria.map(
          (criterion) => ({
            criterionId: clientIds.declare("criterion", criterion.clientRef),
            ordinal: criterion.ordinal,
            description: criterion.description,
            verification: criterion.verification,
          }),
        );
        const decisions = operation.assignment.unresolvedDecisions.map(
          (decision) => ({
            decisionId: clientIds.declare("decision", decision.clientRef),
            question: decision.question,
            required: decision.required,
            status: decision.status,
            resolution: decision.resolution,
          }),
        );
        const deliverables = operation.assignment.deliverables.map(
          (deliverable) => ({
            deliverableId: clientIds.declare(
              "deliverable",
              deliverable.clientRef,
            ),
            description: deliverable.description,
            artifactNodeIds: deliverable.artifactNodeIds,
            acceptanceCriterionIds: deliverable.acceptanceCriterionRefs.map(
              (reference) =>
                resolveExistingIdentity(
                  reference,
                  "criterion",
                  new Set(
                    base.assignments
                      .find(
                        (item) =>
                          item.plannedAgentId ===
                          operation.assignment.plannedAgentId,
                      )
                      ?.acceptanceCriteria.map((item) => item.criterionId) ??
                      [],
                  ),
                  new Set(criteria.map((item) => item.criterionId)),
                  clientIds,
                  "operations.assignment.deliverables.acceptanceCriterionRefs",
                ),
            ),
          }),
        );
        next.assignments = replaceBy(
          next.assignments,
          {
            plannedAgentId: operation.assignment.plannedAgentId,
            mission: operation.assignment.mission,
            scope: operation.assignment.scope,
            constraints: operation.assignment.constraints,
            acceptanceCriteria: criteria,
            deliverables,
            milestoneIds: operation.assignment.milestoneRefs.map((reference) =>
              resolveExistingIdentity(
                reference,
                "milestone",
                baseMilestoneIds,
                prospectiveMilestoneIds(),
                clientIds,
                "operations.assignment.milestoneRefs",
              ),
            ),
            unresolvedDecisions: decisions,
          } as unknown as AgentAssignmentIntent,
          (item) => item.plannedAgentId,
        );
        break;
      }
      case "remove-agent-assignment":
        next.assignments = next.assignments.filter(
          (item) => item.plannedAgentId !== operation.plannedAgentId,
        );
        break;
      case "upsert-decision": {
        const decisionId = resolveExistingIdentity(
          operation.decision.decisionId,
          "decision",
          new Set(base.unresolvedDecisions.map((item) => item.decisionId)),
          new Set(next.unresolvedDecisions.map((item) => item.decisionId)),
          clientIds,
          "operations.decision.decisionId",
        );
        next.unresolvedDecisions = replaceBy(
          next.unresolvedDecisions,
          { ...operation.decision, decisionId } as unknown as PlanDecision,
          (item) => item.decisionId,
        );
        break;
      }
      case "create-decision": {
        const decisionId = clientIds.declare(
          "decision",
          operation.decision.clientRef,
        );
        assertCreateTargetAbsent(
          next.unresolvedDecisions.some(
            (item) => item.decisionId === decisionId,
          ),
          "operations.decision.clientRef",
        );
        next.unresolvedDecisions = replaceBy(
          next.unresolvedDecisions,
          {
            decisionId,
            question: operation.decision.question,
            required: operation.decision.required,
            status: operation.decision.status,
            resolution: operation.decision.resolution,
          } as PlanDecision,
          (item) => item.decisionId,
        );
        break;
      }
      case "remove-decision":
        next.unresolvedDecisions = next.unresolvedDecisions.filter(
          (item) => item.decisionId !== operation.decisionId,
        );
        break;
    }
  }
  return next;
}

export class BuildPlanService {
  constructor(private readonly dependencies: BuildPlanServiceDependencies) {}

  async read(identity: PlanningSessionIdentity, value: unknown) {
    assertPlanner(identity);
    const input = this.parse(buildPlanReadInputSchema, value);
    const planning = await this.dependencies.store.read(identity.projectId);
    const plan = input.plan
      ? planning.planVersions.find(
          (candidate) =>
            candidate.planId === input.plan!.planId &&
            candidate.version === input.plan!.version,
        )
      : planning.planVersions.at(-1);
    if (!plan) throw new BuildPlanServiceError("plan_not_found");
    if (plan.projectId !== identity.projectId)
      throw new BuildPlanServiceError("cross_project_reference");
    const briefs = briefsForPlan(planning, plan);
    const summaryBriefs =
      plan.version === planning.currentPlanVersion
        ? [
            ...new Map(
              [...briefs, ...currentBriefs(planning)].map((brief) => [
                `${brief.briefId}\0${brief.version}`,
                brief,
              ]),
            ).values(),
          ]
        : briefs;
    const status = await this.dependencies.contractValidator.validate(
      plan,
      briefs,
    );
    const include = new Set(
      input.include ?? [
        "plan",
        "assignment-intents",
        "brief-summaries",
        "diagnostics",
        "history-summary",
      ],
    );
    return this.bounded({
      schemaVersion: 1 as const,
      source: plan.source,
      plan: planRef(plan),
      current: plan.version === planning.currentPlanVersion,
      completeness: {
        ...status.completeness,
        issues: include.has("diagnostics")
          ? status.completeness.issues.slice(0, BUILD_PLAN_MAX_DIAGNOSTICS)
          : [],
      },
      eligibility: status.eligibility,
      ...(include.has("plan") ? { state: plan } : {}),
      ...(include.has("assignment-intents")
        ? { assignmentIntents: plan.assignments }
        : {}),
      ...(include.has("brief-summaries")
        ? {
            briefs: summaryBriefs.slice(0, 128).map((brief) => ({
              plannedAgentId: brief.plannedAgentId,
              briefId: brief.briefId,
              version: brief.version,
              semanticDigest: brief.semanticDigest,
              current:
                planning.currentBriefByAgentId[brief.plannedAgentId]
                  ?.briefId === brief.briefId &&
                planning.currentBriefByAgentId[brief.plannedAgentId]
                  ?.version === brief.version,
              freshness:
                brief.plan.planId === plan.planId &&
                brief.plan.version === plan.version &&
                brief.plan.semanticDigest === plan.semanticDigest &&
                architectureSourceRefsEqual(brief.source, plan.source)
                  ? "current"
                  : "stale",
            })),
          }
        : {}),
      ...(include.has("history-summary")
        ? {
            history: {
              versionCount: planning.planVersions.length,
              firstVersion: planning.planVersions[0]?.version ?? null,
              currentVersion: plan.version,
            },
          }
        : {}),
    });
  }

  async validate(identity: PlanningSessionIdentity, value: unknown) {
    assertPlanner(identity);
    const input = this.parse(buildPlanValidateRequestSchema, value);
    const prepared = await this.prepare(identity, input);
    return { ...prepared.result, wouldApply: true };
  }

  async apply(identity: PlanningSessionIdentity, value: unknown) {
    assertPlanner(identity);
    const input = this.parse(buildPlanApplyRequestSchema, value);
    const digest = requestDigest({ ...input, requestId: undefined });
    const replay = await this.findReplay(identity, input.requestId, digest);
    if (replay) return replay;
    const prepared = await this.prepare(identity, input);
    try {
      const committed = await this.dependencies.store.commitPlanVersion(
        prepared.plan,
        prepared.source.graph,
        {
          sessionId: identity.sessionId,
          requestId: input.requestId,
          requestDigest: digest,
          enforceCurrentProposalSource: true,
          result: {
            operation: "apply",
            briefChanges: prepared.result.briefChanges,
            idMappings: prepared.result.idMappings,
            completeness: prepared.result.completeness,
            eligibility: prepared.result.eligibility,
            diagnostics: prepared.result.diagnostics,
          },
        },
        {
          assignments: prepared.assignments,
          briefs: prepared.briefs,
        },
      );
      if (committed.replayed)
        return (await this.findReplay(identity, input.requestId, digest))!;
      return {
        ...prepared.result,
        plan: committed.plan,
        replayed: committed.replayed,
      };
    } catch (error) {
      if (error instanceof BuildPlanStoreLimitError)
        throw new BuildPlanServiceError("result_too_large");
      if (error instanceof BuildPlanStoreConflictError)
        throw new BuildPlanServiceError(
          error.code === "request_id_reused" ||
            error.code === "request_id_expired"
            ? "idempotency_key_reused"
            : "plan_version_conflict",
          [],
          await this.currentRef(identity.projectId),
        );
      throw error;
    }
  }

  async rebase(identity: PlanningSessionIdentity, value: unknown) {
    assertPlanner(identity);
    const input = this.parse(buildPlanRebaseRequestSchema, value);
    const digest = requestDigest({ ...input, requestId: undefined });
    const replay = await this.findReplay(identity, input.requestId, digest);
    if (replay) return replay;
    const planning = await this.dependencies.store.read(identity.projectId);
    const current = planning.planVersions.at(-1);
    const fromSource = input.fromSource as unknown as ArchitectureSourceRef;
    const toSource = input.toSource as unknown as ArchitectureSourceRef;
    this.assertCurrent(
      current,
      input.planId,
      input.expectedPlanVersion,
      fromSource,
    );
    const from = await this.resolve(identity.projectId, fromSource);
    const to = await this.resolve(identity.projectId, toSource);
    await this.assertCurrentProposalSource(identity.projectId, to.source);
    let assignments = structuredClone(current!.assignments);
    let repositoryIntents: RepositoryIntent[] = [
      ...structuredClone(current!.repositoryIntents),
    ];
    const resolutionConflict = (
      message: string,
      relatedIds: readonly string[],
    ): never => {
      throw new BuildPlanServiceError(
        "rebase_conflict",
        [{ path: "resolutions", message, relatedIds }],
        planRef(current!),
      );
    };
    for (const resolution of input.resolutions) {
      if (resolution.kind === "remove-assignment") {
        if (
          !assignments.some(
            (item) => item.plannedAgentId === resolution.plannedAgentId,
          )
        )
          resolutionConflict("Resolution does not match an assignment", [
            resolution.plannedAgentId,
          ]);
        assignments = assignments.filter(
          (item) => item.plannedAgentId !== resolution.plannedAgentId,
        );
      } else if (resolution.kind === "remap-agent") {
        const found =
          assignments.find(
            (item) => item.plannedAgentId === resolution.fromPlannedAgentId,
          ) ??
          resolutionConflict("Resolution does not match an assignment", [
            resolution.fromPlannedAgentId,
          ]);
        assignments = [
          ...assignments.filter(
            (item) => item.plannedAgentId !== resolution.fromPlannedAgentId,
          ),
          {
            ...found,
            plannedAgentId: resolution.toPlannedAgentId as PlanNodeId,
          },
        ];
      } else if (resolution.kind === "remove-repository-intent") {
        if (
          !repositoryIntents.some(
            (item) => item.repositoryIntentId === resolution.repositoryIntentId,
          )
        )
          resolutionConflict("Resolution does not match a repository intent", [
            resolution.repositoryIntentId,
          ]);
        repositoryIntents = repositoryIntents.filter(
          (item) => item.repositoryIntentId !== resolution.repositoryIntentId,
        );
      } else if (resolution.kind === "remap-repository-intent") {
        const index = repositoryIntents.findIndex(
          (item) => item.repositoryIntentId === resolution.repositoryIntentId,
        );
        if (index < 0)
          resolutionConflict("Resolution does not match a repository intent", [
            resolution.repositoryIntentId,
          ]);
        repositoryIntents[index] = {
          ...repositoryIntents[index]!,
          plannedAgentId: resolution.toPlannedAgentId as PlanNodeId,
        };
      } else {
        const assignment = assignments.find(
          (item) => item.plannedAgentId === resolution.plannedAgentId,
        );
        const deliverable = assignment?.deliverables.find(
          (item) => item.deliverableId === resolution.deliverableId,
        );
        const nodeId = (
          resolution.kind === "remap-artifact-reference"
            ? resolution.fromNodeId
            : resolution.nodeId
        ) as PlanNodeId;
        const matchedDeliverable =
          deliverable ??
          resolutionConflict(
            "Resolution does not match a deliverable artifact reference",
            [resolution.plannedAgentId, resolution.deliverableId, nodeId],
          );
        if (!matchedDeliverable.artifactNodeIds.includes(nodeId))
          resolutionConflict(
            "Resolution does not match a deliverable artifact reference",
            [resolution.plannedAgentId, resolution.deliverableId, nodeId],
          );
        const artifactNodeIds = matchedDeliverable.artifactNodeIds.flatMap(
          (id) =>
            id !== nodeId
              ? [id]
              : resolution.kind === "remap-artifact-reference"
                ? [resolution.toNodeId as PlanNodeId]
                : [],
        );
        assignments = assignments.map((item) =>
          item.plannedAgentId !== resolution.plannedAgentId
            ? item
            : {
                ...item,
                deliverables: item.deliverables.map((candidate) =>
                  candidate.deliverableId !== resolution.deliverableId
                    ? candidate
                    : { ...candidate, artifactNodeIds },
                ),
              },
        );
      }
    }
    const targetAgents = new Set(
      to.graph.nodes
        .filter((node) => node.kind === "agent" && node.ownerAgentId === null)
        .map((node) => node.id),
    );
    const unresolved = assignments.filter(
      (item) => !targetAgents.has(item.plannedAgentId),
    );
    const targetNodes = new Set(to.graph.nodes.map((node) => node.id));
    const unresolvedRepositories = repositoryIntents.filter(
      (item) => !targetAgents.has(item.plannedAgentId),
    );
    const unresolvedArtifacts = assignments.flatMap((assignment) =>
      assignment.deliverables.flatMap((deliverable) =>
        deliverable.artifactNodeIds
          .filter((nodeId) => !targetNodes.has(nodeId))
          .map((nodeId) => ({ assignment, deliverable, nodeId })),
      ),
    );
    if (
      unresolved.length ||
      unresolvedRepositories.length ||
      unresolvedArtifacts.length
    )
      throw new BuildPlanServiceError(
        "rebase_conflict",
        [
          ...(unresolved.length
            ? [
                {
                  path: "resolutions",
                  message:
                    "Explicit resolution is required for removed or reowned agents",
                  relatedIds: unresolved
                    .map((item) => item.plannedAgentId)
                    .slice(0, 16),
                },
              ]
            : []),
          ...(unresolvedRepositories.length
            ? [
                {
                  path: "resolutions",
                  message:
                    "Explicit resolution is required for repository intents whose agent changed",
                  relatedIds: unresolvedRepositories
                    .map((item) => item.repositoryIntentId)
                    .slice(0, 16),
                },
              ]
            : []),
          ...(unresolvedArtifacts.length
            ? [
                {
                  path: "resolutions",
                  message:
                    "Explicit resolution is required for removed deliverable artifact references",
                  relatedIds: unresolvedArtifacts
                    .flatMap(({ deliverable, nodeId }) => [
                      deliverable.deliverableId,
                      nodeId,
                    ])
                    .slice(0, 16),
                },
              ]
            : []),
        ],
        planRef(current!),
      );
    const impacts = await this.evaluateImpact({
      previousSource: from.source,
      nextSource: to.source,
      briefs: currentBriefs(planning),
    });
    const draft = this.finalize({
      ...current!,
      source: to.source,
      assignments,
      repositoryIntents,
      version: (current!.version + 1) as ProjectBuildPlanVersion["version"],
      parentVersion: current!.version,
      changeKind: architectureSourceRefsEqual(from.source, to.source)
        ? "recompiled"
        : "source-rebound",
      authoredBy: {
        userId: identity.userId,
        sessionId: identity.sessionId,
        role: "map-planner",
      },
      createdAt: this.dependencies.clock.now().toISOString(),
    });
    this.assertPlanReferences(draft, to.graph);
    const assignmentsForCompile = this.assignmentRefs(planning, draft);
    const compiled = await this.compileBriefs({
      plan: draft,
      graph: to.graph,
      currentBriefs: currentBriefs(planning),
      assignments: assignmentsForCompile,
    });
    const committableBriefs = this.committableBriefs(draft, compiled.briefs);
    const status = await this.dependencies.contractValidator.validate(
      draft,
      committableBriefs,
    );
    this.assertNoInvalidDiagnostics(status.completeness);
    const briefChanges = this.impactChanges(impacts, compiled.changes);
    const result = this.bounded({
      schemaVersion: 1 as const,
      plan: planRef(draft),
      source: draft.source,
      completeness: status.completeness,
      eligibility: status.eligibility,
      briefChanges,
      idMappings: [],
      diagnostics: status.completeness.issues,
      replayed: false,
    });
    try {
      const committed = await this.dependencies.store.commitPlanVersion(
        draft,
        to.graph,
        {
          sessionId: identity.sessionId,
          requestId: input.requestId,
          requestDigest: digest,
          enforceCurrentProposalSource: true,
          result: {
            operation: "rebase",
            briefChanges,
            idMappings: [],
            completeness: status.completeness,
            eligibility: status.eligibility,
            diagnostics: status.completeness.issues,
          },
        },
        { assignments: assignmentsForCompile, briefs: committableBriefs },
      );
      if (committed.replayed)
        return (await this.findReplay(identity, input.requestId, digest))!;
      return { ...result, plan: committed.plan };
    } catch (error) {
      if (error instanceof BuildPlanStoreLimitError)
        throw new BuildPlanServiceError("result_too_large");
      if (error instanceof BuildPlanStoreConflictError)
        throw new BuildPlanServiceError(
          error.code === "request_id_reused" ||
            error.code === "request_id_expired"
            ? "idempotency_key_reused"
            : "plan_version_conflict",
          [],
          await this.currentRef(identity.projectId),
        );
      throw error;
    }
  }

  private async prepare(
    identity: PlanningSessionIdentity,
    input: BuildPlanValidateRequest | BuildPlanApplyRequest,
  ) {
    const planning = await this.dependencies.store.read(identity.projectId);
    const current = planning.planVersions.at(-1);
    if (
      !current &&
      !input.operations.some(
        (operation) => operation.op === "set-project-outcome",
      )
    )
      throw new BuildPlanServiceError("incomplete_plan", [
        {
          path: "operations",
          message: "Initial creation requires a project outcome",
        },
      ]);
    const expectedSource =
      input.expectedSource as unknown as ArchitectureSourceRef;
    this.assertCurrent(
      current,
      input.planId,
      input.expectedPlanVersion,
      expectedSource,
    );
    const source = await this.resolve(identity.projectId, expectedSource);
    await this.assertCurrentProposalSource(identity.projectId, source.source);
    const allocationSeed = canonicalJson({
      projectId: identity.projectId,
      expectedSource: input.expectedSource,
      operations: input.operations,
    });
    const id =
      current?.planId ??
      (deterministicId("build-plan", allocationSeed) as BuildPlanId);
    const idMappings: BuildPlanIdMapping[] = [];
    const mapped = new Map<string, BuildPlanIdMapping>();
    const mappedIds = new Set<string>();
    const existingCanonicalIds = new Set([...seedIdentityValues(current)]);
    const declareClientId = (
      kind: BuildPlanIdMapping["kind"],
      clientRef: string,
    ): string => {
      if (mapped.has(clientRef))
        throw new BuildPlanServiceError("invalid_operation", [
          {
            path: "operations.clientRef",
            message:
              "Each client reference may declare exactly one identity in a request",
          },
        ]);
      if (idMappings.length >= BUILD_PLAN_ID_MAPPING_LIMIT)
        throw new BuildPlanServiceError("result_too_large", [
          {
            path: "operations",
            message: `A build-plan version can create at most ${BUILD_PLAN_ID_MAPPING_LIMIT} client-correlated identities; split the authoring work across plan versions`,
          },
        ]);
      const prefix =
        kind === "milestone"
          ? "milestone"
          : kind === "criterion"
            ? "criterion"
            : kind === "deliverable"
              ? "deliverable"
              : "decision";
      const allocated = deterministicId(prefix, `${id}\0${kind}\0${clientRef}`);
      if (existingCanonicalIds.has(allocated) || mappedIds.has(allocated))
        throw new BuildPlanServiceError("invalid_operation", [
          {
            path: "operations.clientRef",
            message:
              "A client reference cannot alias an existing canonical identity; use its canonical ID in an update operation",
          },
        ]);
      const mapping = { kind, clientRef, id: allocated };
      mapped.set(clientRef, mapping);
      mappedIds.add(allocated);
      idMappings.push(mapping);
      return allocated;
    };
    const resolveClientId = (
      kind: BuildPlanIdMapping["kind"],
      clientRef: string,
    ): string => {
      const mapping = mapped.get(clientRef);
      if (!mapping || mapping.kind !== kind)
        throw new BuildPlanServiceError("invalid_operation", [
          {
            path: "operations.clientRef",
            message:
              "A client reference must match an identity created earlier in the same request",
          },
        ]);
      return mapping.id;
    };
    const seed =
      current ??
      ({
        schemaVersion: 1,
        projectId: identity.projectId,
        planId: id,
        version: 0,
        parentVersion: null,
        changeKind: "created",
        source: source.source,
        outcome: { summary: "Incomplete plan" },
        milestones: [],
        sharedConstraints: [],
        repositoryIntents: [],
        integrationCriteria: [],
        assignments: [],
        unresolvedDecisions: [],
        semanticDigest: "",
        recordDigest: "",
        authoredBy: {
          userId: identity.userId,
          sessionId: identity.sessionId,
          role: "map-planner",
        },
        createdAt: this.dependencies.clock.now().toISOString(),
      } as unknown as ProjectBuildPlanVersion);
    const next = applyBuildPlanOperations(seed, input.operations, {
      declare: declareClientId,
      resolve: resolveClientId,
    });
    const draft = this.finalize({
      ...next,
      planId: id,
      version: ((current?.version ?? 0) +
        1) as ProjectBuildPlanVersion["version"],
      parentVersion: current?.version ?? null,
      changeKind: current ? "edited" : "created",
      source: source.source,
      authoredBy: {
        userId: identity.userId,
        sessionId: identity.sessionId,
        role: "map-planner",
      },
      createdAt: this.dependencies.clock.now().toISOString(),
    });
    this.assertPlanReferences(draft, source.graph);
    const assignmentsForCompile = this.assignmentRefs(planning, draft);
    const compiled = await this.compileBriefs({
      plan: draft,
      graph: source.graph,
      currentBriefs: currentBriefs(planning),
      assignments: assignmentsForCompile,
    });
    const committableBriefs = this.committableBriefs(draft, compiled.briefs);
    const status = await this.dependencies.contractValidator.validate(
      draft,
      committableBriefs,
    );
    this.assertNoInvalidDiagnostics(status.completeness);
    const result = {
      plan: draft,
      source,
      assignments: assignmentsForCompile,
      briefs: committableBriefs,
      result: {
        schemaVersion: 1 as const,
        plan: planRef(draft),
        source: draft.source,
        preview: draft,
        semanticDigest: draft.semanticDigest,
        impactedAssignments: draft.assignments
          .slice(0, 128)
          .map((item) => item.plannedAgentId),
        briefChanges: compiled.changes.slice(0, 128),
        idMappings,
        completeness: status.completeness,
        eligibility: status.eligibility,
        diagnostics: status.completeness.issues.slice(
          0,
          BUILD_PLAN_MAX_DIAGNOSTICS,
        ),
        replayed: false,
      },
    };
    this.bounded(result.result);
    return result;
  }

  private finalize(value: ProjectBuildPlanVersion): ProjectBuildPlanVersion {
    try {
      const semanticDigest = computeBuildPlanSemanticDigest(value);
      const withSemantic = { ...value, semanticDigest };
      return parseProjectBuildPlanVersion({
        ...withSemantic,
        recordDigest: computeBuildPlanRecordDigest(withSemantic),
      });
    } catch (error) {
      const issues =
        error && typeof error === "object" && "issues" in error
          ? (
              error as {
                issues: Array<{ path: PropertyKey[]; message: string }>;
              }
            ).issues
              .slice(0, BUILD_PLAN_MAX_DIAGNOSTICS)
              .map((issue) => ({
                path: issue.path.join("."),
                message: issue.message.slice(0, 256),
              }))
          : [];
      throw new BuildPlanServiceError("invalid_operation", issues);
    }
  }

  private assertCurrent(
    current: ProjectBuildPlanVersion | undefined,
    planId: string | null,
    expectedVersion: number | null,
    source: ArchitectureSourceRef,
  ): void {
    if (!current) {
      if (planId !== null || expectedVersion !== null)
        throw new BuildPlanServiceError("plan_not_found");
      return;
    }
    if (planId === null)
      throw new BuildPlanServiceError(
        "plan_version_conflict",
        [],
        planRef(current),
      );
    if (planId !== current.planId)
      throw new BuildPlanServiceError("plan_not_found");
    if (expectedVersion !== current.version)
      throw new BuildPlanServiceError(
        "plan_version_conflict",
        [],
        planRef(current),
      );
    if (!architectureSourceRefsEqual(source, current.source))
      throw new BuildPlanServiceError("source_mismatch", [], planRef(current));
  }

  private async resolve(
    projectId: string,
    source: ArchitectureSourceRef,
  ): Promise<ResolvedArchitectureSource> {
    try {
      return await this.dependencies.sourceResolver.resolve(projectId, source);
    } catch (error) {
      if (error instanceof ArchitectureSourceResolutionError)
        throw new BuildPlanServiceError(
          error.code === "cross_project"
            ? "cross_project_reference"
            : error.code,
        );
      throw error;
    }
  }

  private parse<T>(
    schema: {
      safeParse(value: unknown):
        | { success: true; data: T }
        | {
            success: false;
            error: { issues: Array<{ path: PropertyKey[]; message: string }> };
          };
    },
    value: unknown,
  ): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BuildPlanServiceError(
      "invalid_operation",
      parsed.error.issues.slice(0, BUILD_PLAN_MAX_DIAGNOSTICS).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message.slice(0, 256),
      })),
    );
  }

  private async currentRef(
    projectId: string,
  ): Promise<BuildPlanRef | undefined> {
    const current = (
      await this.dependencies.store.read(projectId)
    ).planVersions.at(-1);
    return current ? planRef(current) : undefined;
  }

  private async assertCurrentProposalSource(
    projectId: string,
    source: ArchitectureSourceRef,
  ): Promise<void> {
    if (
      source.kind === "proposal" &&
      !(await this.dependencies.store.isCurrentProposalSource(
        projectId,
        source,
      ))
    )
      throw new BuildPlanServiceError(
        "source_mismatch",
        [],
        await this.currentRef(projectId),
      );
  }

  private async findReplay(
    identity: PlanningSessionIdentity,
    requestId: string,
    digest: string,
  ) {
    const planning = await this.dependencies.store.read(identity.projectId);
    const receipt = planning.idempotencyReceipts.find(
      (item) =>
        item.sessionId === identity.sessionId && item.requestId === requestId,
    );
    if (!receipt) return null;
    if (receipt.requestDigest !== digest)
      throw new BuildPlanServiceError("idempotency_key_reused");
    return this.replayResult(identity, receipt);
  }

  private async replayResult(
    identity: PlanningSessionIdentity,
    receipt: BuildPlanIdempotencyReceipt,
  ) {
    const planning = await this.dependencies.store.read(identity.projectId);
    const plan = planning.planVersions.find(
      (item) => item.recordDigest === receipt.resultRecordDigest,
    );
    if (!plan) throw new BuildPlanServiceError("plan_not_found");
    const status = receipt.result
      ? {
          completeness: receipt.result.completeness,
          eligibility: receipt.result.eligibility,
        }
      : await this.dependencies.contractValidator.validate(
          plan,
          briefsForPlan(planning, plan),
        );
    const result = {
      schemaVersion: 1 as const,
      plan: planRef(plan),
      source: plan.source,
      completeness: status.completeness,
      eligibility: status.eligibility,
      briefChanges: receipt.result?.briefChanges ?? [],
      idMappings: receipt.result?.idMappings ?? [],
      diagnostics: receipt.result?.diagnostics ?? status.completeness.issues,
      replayed: true,
    };
    return receipt.result?.operation === "apply"
      ? {
          ...result,
          preview: plan,
          semanticDigest: plan.semanticDigest,
          impactedAssignments: plan.assignments.map(
            (assignment) => assignment.plannedAgentId,
          ),
        }
      : result;
  }

  private impactChanges(
    impacts: Readonly<Record<string, readonly BriefStaleReason[]>>,
    compiled: readonly BriefChangeSummary[],
  ): BriefChangeSummary[] {
    const changes = new Map(
      compiled.map((item) => [item.plannedAgentId, item]),
    );
    for (const [plannedAgentId, reasons] of Object.entries(impacts))
      if (reasons.length)
        changes.set(plannedAgentId as PlanNodeId, {
          plannedAgentId: plannedAgentId as PlanNodeId,
          change: "staled",
        });
    return [...changes.values()].slice(0, 128);
  }

  private assertPlanReferences(
    plan: ProjectBuildPlanVersion,
    graph: AgentMapGraph,
  ): void {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const topLevelAgents = new Set(
      graph.nodes
        .filter((node) => node.kind === "agent" && node.ownerAgentId === null)
        .map((node) => node.id),
    );
    const issues: BuildPlanSafeIssue[] = [];
    plan.assignments.forEach((assignment, assignmentIndex) => {
      if (!topLevelAgents.has(assignment.plannedAgentId))
        issues.push({
          path: `assignments[${assignmentIndex}].plannedAgentId`,
          message: "Assignment target must be a top-level architecture agent",
          relatedIds: [assignment.plannedAgentId],
        });
      assignment.deliverables.forEach((deliverable, deliverableIndex) => {
        const missing = deliverable.artifactNodeIds.filter(
          (nodeId) => !nodes.has(nodeId),
        );
        if (missing.length)
          issues.push({
            path: `assignments[${assignmentIndex}].deliverables[${deliverableIndex}].artifactNodeIds`,
            message: "Deliverable references an unknown architecture node",
            relatedIds: missing.slice(0, 16),
          });
      });
    });
    plan.repositoryIntents.forEach((intent, index) => {
      if (!topLevelAgents.has(intent.plannedAgentId))
        issues.push({
          path: `repositoryIntents[${index}].plannedAgentId`,
          message:
            "Repository intent target must be a top-level architecture agent",
          relatedIds: [intent.plannedAgentId],
        });
    });
    if (issues.length)
      throw new BuildPlanServiceError(
        "invalid_reference",
        issues.slice(0, BUILD_PLAN_MAX_DIAGNOSTICS),
      );
  }

  private assertNoInvalidDiagnostics(completeness: {
    issues: readonly {
      code: string;
      severity: string;
      path: string;
      message: string;
      relatedIds: readonly string[];
    }[];
  }): void {
    const incompleteCodes = new Set([
      "missing-agent-assignment",
      "missing-brief",
      "unresolved-required-decision",
    ]);
    const invalid = completeness.issues.filter(
      (issue) =>
        issue.severity !== "warning" && !incompleteCodes.has(issue.code),
    );
    if (invalid.length)
      throw new BuildPlanServiceError(
        "invalid_reference",
        invalid.slice(0, BUILD_PLAN_MAX_DIAGNOSTICS).map((issue) => ({
          path: issue.path,
          message: issue.message,
          relatedIds: issue.relatedIds,
        })),
      );
  }

  private assignmentRefs(
    planning: Awaited<ReturnType<BuildPlanStore["read"]>>,
    plan: ProjectBuildPlanVersion,
  ): PlanningAssignmentRef[] {
    return plan.assignments.map((assignment) => {
      const existing = planning.assignmentByAgentId[assignment.plannedAgentId];
      if (existing)
        return {
          assignmentId: existing.assignmentId,
          briefId: existing.briefId,
          plannedAgentId: assignment.plannedAgentId,
        };
      return {
        assignmentId: deterministicId(
          "assignment",
          `${plan.planId}\0${assignment.plannedAgentId}`,
        ) as PlanningAssignmentId,
        briefId: deterministicId(
          "brief",
          `${plan.planId}\0${assignment.plannedAgentId}`,
        ) as AgentBriefId,
        plannedAgentId: assignment.plannedAgentId,
      };
    });
  }

  private async compileBriefs(
    input: Parameters<AgentBriefCompiler["compile"]>[0],
  ): Promise<AgentBriefCompileResult> {
    try {
      return await this.dependencies.briefCompiler.compile(input);
    } catch (error) {
      if (error instanceof BuildPlanDependencyUnavailableError)
        throw new BuildPlanServiceError("authoring_unavailable", [
          {
            path: error.dependency,
            message:
              "Build plan mutation is unavailable until its production planning dependency is installed",
          },
        ]);
      throw error;
    }
  }

  private async evaluateImpact(
    input: Parameters<BuildPlanImpactEvaluator["evaluate"]>[0],
  ) {
    try {
      return await this.dependencies.impactEvaluator.evaluate(input);
    } catch (error) {
      if (error instanceof BuildPlanDependencyUnavailableError)
        throw new BuildPlanServiceError("authoring_unavailable", [
          {
            path: error.dependency,
            message:
              "Build plan rebase is unavailable until its production impact dependency is installed",
          },
        ]);
      throw error;
    }
  }

  private committableBriefs(
    plan: ProjectBuildPlanVersion,
    briefs: readonly AgentBriefVersionRecord[],
  ): AgentBriefVersionRecord[] {
    return briefs.filter(
      (brief) =>
        brief.plan.planId === plan.planId &&
        brief.plan.version === plan.version &&
        brief.plan.semanticDigest === plan.semanticDigest &&
        architectureSourceRefsEqual(brief.source, plan.source),
    );
  }

  private bounded<T>(value: T): T {
    if (
      Buffer.byteLength(canonicalJson(value), "utf8") >
      BUILD_PLAN_MAX_RESULT_BYTES
    )
      throw new BuildPlanServiceError("result_too_large");
    return value;
  }
}
