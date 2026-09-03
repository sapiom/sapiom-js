import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  PlanNodeId,
  PlanningSessionIdentity,
} from "../shared/agent-map.js";
import {
  architectureSourceRefsEqual,
  type AcceptanceCriterion,
  type AgentAssignmentIntent,
  type AgentBriefId,
  type AgentBriefVersionRecord,
  type ArchitectureSourceRef,
  type BriefStaleReason,
  type BuildMilestone,
  type BuildPlanId,
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
  | "result_too_large";

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
  plannedAgentId: string;
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

export interface BuildPlanIdFactory {
  allocateBuildPlanId(): BuildPlanId;
  allocateBriefId(): AgentBriefId;
  allocateAssignmentId(): PlanningAssignmentId;
}

export interface Clock {
  now(): Date;
}

export interface BuildPlanServiceDependencies {
  store: BuildPlanStore;
  sourceResolver: ExactArchitectureSourceResolver;
  contractValidator: BuildPlanContractValidator;
  briefCompiler: AgentBriefCompiler;
  impactEvaluator: BuildPlanImpactEvaluator;
  idFactory: BuildPlanIdFactory;
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

function replaceBy<T>(
  items: readonly T[],
  value: T,
  key: (item: T) => string,
): T[] {
  const id = key(value);
  return [...items.filter((item) => key(item) !== id), value];
}

/** Pure authoring reducer shared by validate and apply. */
export function applyBuildPlanOperations(
  base: ProjectBuildPlanVersion,
  operations: readonly BuildPlanOperation[],
): ProjectBuildPlanVersion {
  const next = structuredClone(base);
  for (const operation of operations) {
    switch (operation.op) {
      case "set-project-outcome":
        next.outcome = operation.outcome;
        break;
      case "upsert-milestone":
        next.milestones = replaceBy(
          next.milestones,
          operation.milestone as unknown as BuildMilestone,
          (item) => item.milestoneId,
        );
        break;
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
      case "set-integration-criteria":
        next.integrationCriteria =
          operation.criteria as unknown as readonly AcceptanceCriterion[];
        break;
      case "upsert-agent-assignment":
        next.assignments = replaceBy(
          next.assignments,
          operation.assignment as unknown as AgentAssignmentIntent,
          (item) => item.plannedAgentId,
        );
        break;
      case "remove-agent-assignment":
        next.assignments = next.assignments.filter(
          (item) => item.plannedAgentId !== operation.plannedAgentId,
        );
        break;
      case "upsert-decision":
        next.unresolvedDecisions = replaceBy(
          next.unresolvedDecisions,
          operation.decision as unknown as PlanDecision,
          (item) => item.decisionId,
        );
        break;
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
    const briefs = currentBriefs(planning);
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
      completeness: {
        ...status.completeness,
        issues: include.has("diagnostics")
          ? status.completeness.issues.slice(0, BUILD_PLAN_MAX_DIAGNOSTICS)
          : [],
      },
      eligibility: status.eligibility,
      ...(include.has("plan")
        ? {
            state: {
              ...plan,
              assignments: [],
            },
          }
        : {}),
      ...(include.has("assignment-intents")
        ? { assignmentIntents: plan.assignments }
        : {}),
      ...(include.has("brief-summaries")
        ? {
            briefs: briefs.slice(0, 128).map((brief) => ({
              plannedAgentId: brief.plannedAgentId,
              briefId: brief.briefId,
              version: brief.version,
              semanticDigest: brief.semanticDigest,
              freshness: architectureSourceRefsEqual(brief.source, plan.source)
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
    const prepared = await this.prepare(identity, input, false);
    return { ...prepared.result, wouldApply: true };
  }

  async apply(identity: PlanningSessionIdentity, value: unknown) {
    assertPlanner(identity);
    const input = this.parse(buildPlanApplyRequestSchema, value);
    const digest = requestDigest({ ...input, requestId: undefined });
    const replay = await this.findReplay(identity, input.requestId, digest);
    if (replay) return replay;
    const prepared = await this.prepare(identity, input, true);
    try {
      const committed = await this.dependencies.store.commitPlanVersion(
        prepared.plan,
        prepared.source.graph,
        {
          sessionId: identity.sessionId,
          requestId: input.requestId,
          requestDigest: digest,
        },
        {
          assignments: prepared.assignments,
          briefs: prepared.briefs,
        },
      );
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
    let assignments = structuredClone(current!.assignments);
    for (const resolution of input.resolutions) {
      if (resolution.kind === "remove-assignment")
        assignments = assignments.filter(
          (item) => item.plannedAgentId !== resolution.plannedAgentId,
        );
      else {
        const found = assignments.find(
          (item) => item.plannedAgentId === resolution.fromPlannedAgentId,
        );
        if (!found)
          throw new BuildPlanServiceError("rebase_conflict", [
            {
              path: "resolutions",
              message: "Resolution does not match an assignment",
              relatedIds: [resolution.fromPlannedAgentId],
            },
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
    if (unresolved.length)
      throw new BuildPlanServiceError(
        "rebase_conflict",
        [
          {
            path: "resolutions",
            message:
              "Explicit resolution is required for removed or reowned agents",
            relatedIds: unresolved
              .map((item) => item.plannedAgentId)
              .slice(0, 16),
          },
        ],
        planRef(current!),
      );
    const impacts = await this.dependencies.impactEvaluator.evaluate({
      previousSource: from.source,
      nextSource: to.source,
      briefs: currentBriefs(planning),
    });
    const draft = this.finalize({
      ...current!,
      source: to.source,
      assignments,
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
    const assignmentsForCompile = this.assignmentRefs(planning, draft, true);
    const compiled = await this.dependencies.briefCompiler.compile({
      plan: draft,
      graph: to.graph,
      currentBriefs: currentBriefs(planning),
      assignments: assignmentsForCompile,
    });
    const status = await this.dependencies.contractValidator.validate(
      draft,
      compiled.briefs,
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
        },
        { assignments: assignmentsForCompile, briefs: compiled.briefs },
      );
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
    allocate: boolean,
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
    const id =
      current?.planId ??
      (allocate
        ? this.dependencies.idFactory.allocateBuildPlanId()
        : ("build-plan_00000000-0000-7000-8000-000000000000" as BuildPlanId));
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
    const next = applyBuildPlanOperations(seed, input.operations);
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
    const assignmentsForCompile = this.assignmentRefs(
      planning,
      draft,
      allocate,
    );
    const compiled = await this.dependencies.briefCompiler.compile({
      plan: draft,
      graph: source.graph,
      currentBriefs: currentBriefs(planning),
      assignments: assignmentsForCompile,
    });
    const status = await this.dependencies.contractValidator.validate(
      draft,
      compiled.briefs,
    );
    this.assertNoInvalidDiagnostics(status.completeness);
    const result = {
      plan: draft,
      source,
      assignments: assignmentsForCompile,
      briefs: compiled.briefs,
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
    if (planId !== current.planId)
      throw new BuildPlanServiceError("cross_project_reference");
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
    const plan = planning.planVersions.find(
      (item) => item.recordDigest === receipt.resultRecordDigest,
    );
    if (!plan) throw new BuildPlanServiceError("plan_not_found");
    const status = await this.dependencies.contractValidator.validate(
      plan,
      currentBriefs(planning),
    );
    return {
      schemaVersion: 1 as const,
      plan: planRef(plan),
      source: plan.source,
      completeness: status.completeness,
      eligibility: status.eligibility,
      briefChanges: [],
      diagnostics: status.completeness.issues,
      replayed: true,
    };
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
        changes.set(plannedAgentId, { plannedAgentId, change: "staled" });
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
    allocate: boolean,
  ): PlanningAssignmentRef[] {
    return plan.assignments.map((assignment, index) => {
      const existing = planning.assignmentByAgentId[assignment.plannedAgentId];
      if (existing)
        return {
          assignmentId: existing.assignmentId,
          briefId: existing.briefId,
          plannedAgentId: assignment.plannedAgentId,
        };
      if (allocate)
        return {
          assignmentId: this.dependencies.idFactory.allocateAssignmentId(),
          briefId: this.dependencies.idFactory.allocateBriefId(),
          plannedAgentId: assignment.plannedAgentId,
        };
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return {
        assignmentId:
          `assignment_00000000-0000-7000-8000-${suffix}` as PlanningAssignmentId,
        briefId: `brief_00000000-0000-7000-8000-${suffix}` as AgentBriefId,
        plannedAgentId: assignment.plannedAgentId,
      };
    });
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
