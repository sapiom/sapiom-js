import { v7 as uuidv7 } from "uuid";

import type {
  AgentMapGraph,
  PlanNodeId,
  StudioProjectId,
} from "../shared/agent-map.js";
import {
  AGENT_BRIEF_VERSION_HISTORY_LIMIT,
  architectureSourceRefsEqual,
  BUILD_PLAN_VERSION_HISTORY_LIMIT,
  PLANNING_SUBMISSION_HISTORY_LIMIT,
  type AgentBriefId,
  type AgentBriefRef,
  type AgentBriefVersionRecord,
  type BuildPlanIdempotencyReceipt,
  type BuildPlanId,
  type BuildPlanRef,
  type BuilderPlanningSubmission,
  type PlanningAssignmentId,
  type PlanningAssignmentRef,
  type PlanningAssignmentRecord,
  type ProjectBuildPlanVersion,
  type RecordDigest,
} from "../shared/build-plan.js";
import {
  parseAgentBriefVersionRecord,
  parseBuilderPlanningSubmission,
  parseProjectBuildPlanVersion,
} from "../shared/build-plan-codec.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
  computeArchitectureGraphDigest,
  computePlanningAssignmentRecordDigest,
  computePlanningSubmissionRecordDigest,
  computePlanningSubmissionSemanticDigest,
} from "./build-plan-canonicalization.js";

export class BuildPlanStoreConflictError extends Error {
  constructor(
    readonly code:
      | "version_conflict"
      | "request_id_reused"
      | "request_id_expired",
  ) {
    super(
      code === "version_conflict"
        ? "Build planning version changed"
        : code === "request_id_reused"
          ? "Build planning request ID was reused"
          : "Build planning request replay has expired",
    );
    this.name = "BuildPlanStoreConflictError";
  }
}

export type BuildPlanHistoryKind =
  | "plan-versions"
  | "brief-versions"
  | "planning-submissions";

export class BuildPlanStoreLimitError extends Error {
  readonly code = "history_limit_exceeded" as const;

  constructor(
    readonly historyKind: BuildPlanHistoryKind,
    readonly limit: number,
  ) {
    super(`Build planning ${historyKind} history limit was reached`);
    this.name = "BuildPlanStoreLimitError";
  }
}

export interface BuildPlanIdentityAllocator {
  allocateBuildPlanId(): BuildPlanId;
  allocateBriefId(): AgentBriefId;
  allocateAssignmentId(): PlanningAssignmentId;
}

export class UuidV7BuildPlanIdentityAllocator implements BuildPlanIdentityAllocator {
  allocateBuildPlanId = () => `build-plan_${uuidv7()}` as BuildPlanId;
  allocateBriefId = () => `brief_${uuidv7()}` as AgentBriefId;
  allocateAssignmentId = () => `assignment_${uuidv7()}` as PlanningAssignmentId;
}

export interface BuildPlanCommitIdentity {
  sessionId: string;
  requestId: string;
  requestDigest: string;
}

export interface BuildPlanStoreOptions {
  allocator?: BuildPlanIdentityAllocator;
  now?: () => Date;
  receiptRetentionLimit?: number;
  historyLimits?: Partial<
    Readonly<{
      planVersions: number;
      briefVersions: number;
      planningSubmissions: number;
    }>
  >;
}

const ZERO_RECORD_DIGEST = `sha256:${"0".repeat(64)}` as RecordDigest;
const sealAssignment = (
  assignment: PlanningAssignmentRecord,
): PlanningAssignmentRecord => ({
  ...assignment,
  recordDigest: computePlanningAssignmentRecordDigest(assignment),
});
const samePlanRef = (left: BuildPlanRef, right: BuildPlanRef) =>
  left.planId === right.planId &&
  left.version === right.version &&
  left.semanticDigest === right.semanticDigest;

/** Persistence primitives over the same crash-atomic E2 project aggregate. */
export class BuildPlanStore {
  private readonly allocator: BuildPlanIdentityAllocator;
  private readonly now: () => Date;
  private readonly receiptRetentionLimit: number;
  private readonly historyLimits: {
    planVersions: number;
    briefVersions: number;
    planningSubmissions: number;
  };

  constructor(
    private readonly store: AgentMapWorkspaceStore,
    options: BuildPlanStoreOptions = {},
  ) {
    this.allocator =
      options.allocator ?? new UuidV7BuildPlanIdentityAllocator();
    this.now = options.now ?? (() => new Date());
    const requestedReceiptLimit = options.receiptRetentionLimit ?? 256;
    if (
      !Number.isSafeInteger(requestedReceiptLimit) ||
      requestedReceiptLimit < 1
    )
      throw new RangeError("receiptRetentionLimit must be a positive integer");
    this.receiptRetentionLimit = Math.min(requestedReceiptLimit, 256);
    this.historyLimits = {
      planVersions:
        options.historyLimits?.planVersions ?? BUILD_PLAN_VERSION_HISTORY_LIMIT,
      briefVersions:
        options.historyLimits?.briefVersions ??
        AGENT_BRIEF_VERSION_HISTORY_LIMIT,
      planningSubmissions:
        options.historyLimits?.planningSubmissions ??
        PLANNING_SUBMISSION_HISTORY_LIMIT,
    };
    for (const [name, limit, maximum] of [
      [
        "planVersions",
        this.historyLimits.planVersions,
        BUILD_PLAN_VERSION_HISTORY_LIMIT,
      ],
      [
        "briefVersions",
        this.historyLimits.briefVersions,
        AGENT_BRIEF_VERSION_HISTORY_LIMIT,
      ],
      [
        "planningSubmissions",
        this.historyLimits.planningSubmissions,
        PLANNING_SUBMISSION_HISTORY_LIMIT,
      ],
    ] as const)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
        throw new RangeError(`${name} history limit is invalid`);
  }

  async read(projectId: StudioProjectId) {
    return (await this.store.readAggregate(projectId)).buildPlanning;
  }

  allocateBuildPlanId(): BuildPlanId {
    return this.allocator.allocateBuildPlanId();
  }

  async readPlanForProject(projectId: StudioProjectId, ref: BuildPlanRef) {
    const planning = await this.read(projectId);
    const plan = planning.planVersions.find(
      (entry) => entry.planId === ref.planId && entry.version === ref.version,
    );
    return plan?.semanticDigest === ref.semanticDigest ? plan : null;
  }

  async readBriefForProject(projectId: StudioProjectId, ref: AgentBriefRef) {
    const planning = await this.read(projectId);
    const brief = planning.briefVersionsById[ref.briefId]?.find(
      (entry) => entry.version === ref.version,
    );
    return brief?.semanticDigest === ref.semanticDigest ? brief : null;
  }

  async readSubmission(
    projectId: StudioProjectId,
    assignmentId: PlanningAssignmentId,
    submissionId: string,
  ) {
    return (
      (await this.read(projectId)).submissionsByAssignmentId[
        assignmentId
      ]?.find((entry) => entry.submissionId === submissionId) ?? null
    );
  }

  async commitPlanVersion(
    input: ProjectBuildPlanVersion,
    graph: AgentMapGraph,
    request: BuildPlanCommitIdentity,
  ): Promise<{
    plan: BuildPlanRef;
    assignments: PlanningAssignmentRef[];
    replayed: boolean;
  }> {
    const plan = parseProjectBuildPlanVersion(input);
    if (
      computeBuildPlanSemanticDigest(plan) !== plan.semanticDigest ||
      computeBuildPlanRecordDigest(plan) !== plan.recordDigest ||
      computeArchitectureGraphDigest(graph) !== plan.source.graphDigest
    )
      throw new Error("invalid build plan digest");
    const topLevelAgentIds = graph.nodes
      .filter((node) => node.kind === "agent" && node.ownerAgentId === null)
      .map((node) => node.id)
      .sort();
    const authoredAgentIds = plan.assignments
      .map((entry) => entry.plannedAgentId)
      .sort();
    if (JSON.stringify(topLevelAgentIds) !== JSON.stringify(authoredAgentIds))
      throw new Error(
        "build plan assignments must exactly match top-level agents",
      );
    return this.store.transact<{
      plan: BuildPlanRef;
      assignments: PlanningAssignmentRef[];
      replayed: boolean;
    }>(plan.projectId, async (aggregate) => {
      const planning = aggregate.buildPlanning;
      const priorReceipt = planning.idempotencyReceipts.find(
        (entry) =>
          entry.sessionId === request.sessionId &&
          entry.requestId === request.requestId,
      );
      if (priorReceipt) {
        if (
          priorReceipt.requestDigest !== request.requestDigest ||
          priorReceipt.resultRecordDigest !== plan.recordDigest
        )
          throw new BuildPlanStoreConflictError("request_id_reused");
        const assignments = plan.assignments.map((entry) =>
          this.assignmentRef(
            planning.assignmentByAgentId[entry.plannedAgentId]!,
          ),
        );
        return {
          value: { plan: this.planRef(plan), assignments, replayed: true },
        };
      }
      if (
        planning.idempotencyTombstones.some(
          (entry) =>
            entry.sessionId === request.sessionId &&
            entry.requestId === request.requestId,
        )
      )
        throw new BuildPlanStoreConflictError("request_id_expired");
      if (planning.planVersions.length >= this.historyLimits.planVersions)
        throw new BuildPlanStoreLimitError(
          "plan-versions",
          this.historyLimits.planVersions,
        );
      if (
        (planning.planId !== null && planning.planId !== plan.planId) ||
        plan.version !== planning.planVersions.length + 1 ||
        plan.parentVersion !== planning.currentPlanVersion
      )
        throw new BuildPlanStoreConflictError("version_conflict");
      const timestamp = this.now().toISOString();
      const active = new Set(topLevelAgentIds);
      const assignmentByAgentId = { ...planning.assignmentByAgentId };
      const currentBriefByAgentId = { ...planning.currentBriefByAgentId };
      for (const [agentId, existing] of Object.entries(assignmentByAgentId)) {
        if (
          !active.has(agentId as PlanNodeId) &&
          existing.status === "active"
        ) {
          assignmentByAgentId[agentId] = sealAssignment({
            ...existing,
            status: "retired",
            retiredAt: timestamp,
            transitions: [
              ...existing.transitions,
              {
                status: "retired",
                at: timestamp,
                planVersion: plan.version,
              },
            ],
          });
          delete currentBriefByAgentId[agentId];
        }
      }
      for (const agentId of topLevelAgentIds) {
        const existing = assignmentByAgentId[agentId];
        assignmentByAgentId[agentId] = existing
          ? existing.status === "retired"
            ? sealAssignment({
                ...existing,
                status: "active",
                retiredAt: null,
                transitions: [
                  ...existing.transitions,
                  {
                    status: "active",
                    at: timestamp,
                    planVersion: plan.version,
                  },
                ],
              })
            : existing
          : sealAssignment({
              schemaVersion: 1,
              projectId: plan.projectId,
              assignmentId: this.allocator.allocateAssignmentId(),
              briefId: this.allocator.allocateBriefId(),
              plannedAgentId: agentId,
              status: "active",
              createdAt: timestamp,
              retiredAt: null,
              transitions: [
                { status: "active", at: timestamp, planVersion: plan.version },
              ],
              recordDigest: ZERO_RECORD_DIGEST,
            });
      }
      const receipt: BuildPlanIdempotencyReceipt = {
        ...request,
        resultRecordDigest: plan.recordDigest,
        createdAt: timestamp,
      };
      const retainedReceipts = [...planning.idempotencyReceipts, receipt];
      const expiredReceipts = retainedReceipts.slice(
        0,
        -this.receiptRetentionLimit,
      );
      const nextPlanning = {
        ...planning,
        planId: plan.planId,
        currentPlanVersion: plan.version,
        planVersions: [...planning.planVersions, plan],
        currentBriefByAgentId,
        assignmentByAgentId,
        idempotencyReceipts: retainedReceipts.slice(
          -this.receiptRetentionLimit,
        ),
        idempotencyTombstones: [
          ...planning.idempotencyTombstones,
          ...expiredReceipts.map(({ sessionId, requestId }) => ({
            sessionId,
            requestId,
          })),
        ],
      };
      const next = {
        ...aggregate,
        workspace: {
          ...aggregate.workspace,
          projectBuildPlanId: plan.planId,
          recordVersion: aggregate.workspace.recordVersion + 1,
          updatedAt: timestamp,
        },
        buildPlanning: nextPlanning,
      };
      return {
        value: {
          plan: this.planRef(plan),
          assignments: topLevelAgentIds.map((id) =>
            this.assignmentRef(assignmentByAgentId[id]!),
          ),
          replayed: false,
        },
        next,
      };
    });
  }

  async commitBriefVersions(
    projectId: StudioProjectId,
    expectedPlan: BuildPlanRef,
    input: readonly AgentBriefVersionRecord[],
  ): Promise<AgentBriefRef[]> {
    const briefs = input.map(parseAgentBriefVersionRecord);
    for (const brief of briefs) {
      if (
        brief.projectId !== projectId ||
        computeAgentBriefSemanticDigest(brief) !== brief.semanticDigest ||
        computeAgentBriefRecordDigest(brief) !== brief.recordDigest
      )
        throw new Error("invalid agent brief digest");
    }
    return this.store.transact(projectId, async (aggregate) => {
      const planning = aggregate.buildPlanning;
      const currentPlan = planning.planVersions.at(-1);
      if (!currentPlan || !samePlanRef(this.planRef(currentPlan), expectedPlan))
        throw new BuildPlanStoreConflictError("version_conflict");
      const histories = { ...planning.briefVersionsById };
      const current = { ...planning.currentBriefByAgentId };
      for (const brief of briefs) {
        const assignment = planning.assignmentByAgentId[brief.plannedAgentId];
        const history = histories[brief.briefId] ?? [];
        if (history.length >= this.historyLimits.briefVersions)
          throw new BuildPlanStoreLimitError(
            "brief-versions",
            this.historyLimits.briefVersions,
          );
        const plan = planning.planVersions.find(
          (entry) =>
            entry.planId === brief.plan.planId &&
            entry.version === brief.plan.version,
        );
        if (
          !assignment ||
          assignment.status !== "active" ||
          assignment.assignmentId !== brief.assignmentId ||
          assignment.briefId !== brief.briefId ||
          brief.version !== history.length + 1 ||
          brief.parentVersion !== (history.at(-1)?.version ?? null) ||
          !plan ||
          plan.semanticDigest !== brief.plan.semanticDigest ||
          !samePlanRef(brief.plan, expectedPlan) ||
          !architectureSourceRefsEqual(currentPlan.source, brief.source)
        )
          throw new BuildPlanStoreConflictError("version_conflict");
        histories[brief.briefId] = [...history, brief];
        current[brief.plannedAgentId] = this.briefRef(brief);
      }
      const timestamp = this.now().toISOString();
      return {
        value: briefs.map((brief) => this.briefRef(brief)),
        next: {
          ...aggregate,
          workspace: {
            ...aggregate.workspace,
            recordVersion: aggregate.workspace.recordVersion + 1,
            updatedAt: timestamp,
          },
          buildPlanning: {
            ...planning,
            briefVersionsById: histories,
            currentBriefByAgentId: current,
          },
        },
      };
    });
  }

  async commitSubmission(input: BuilderPlanningSubmission): Promise<void> {
    const submission = parseBuilderPlanningSubmission(input);
    if (
      computePlanningSubmissionSemanticDigest(submission) !==
        submission.semanticDigest ||
      computePlanningSubmissionRecordDigest(submission) !==
        submission.recordDigest
    )
      throw new Error("invalid planning submission digest");
    await this.store.transact(submission.projectId, async (aggregate) => {
      const planning = aggregate.buildPlanning;
      const assignment =
        planning.assignmentByAgentId[
          Object.keys(planning.assignmentByAgentId).find(
            (agentId) =>
              planning.assignmentByAgentId[agentId]?.assignmentId ===
              submission.assignmentId,
          ) ?? ""
        ];
      const history =
        planning.submissionsByAssignmentId[submission.assignmentId] ?? [];
      if (history.length >= this.historyLimits.planningSubmissions)
        throw new BuildPlanStoreLimitError(
          "planning-submissions",
          this.historyLimits.planningSubmissions,
        );
      const plan = planning.planVersions.find(
        (entry) =>
          entry.planId === submission.plan.planId &&
          entry.version === submission.plan.version,
      );
      const brief = planning.briefVersionsById[submission.brief.briefId]?.find(
        (entry) => entry.version === submission.brief.version,
      );
      if (
        !assignment ||
        !plan ||
        plan.semanticDigest !== submission.plan.semanticDigest ||
        !architectureSourceRefsEqual(plan.source, submission.source) ||
        !brief ||
        brief.semanticDigest !== submission.brief.semanticDigest ||
        brief.assignmentId !== submission.assignmentId ||
        (history.length === 0
          ? submission.supersedesSubmissionId !== null
          : submission.supersedesSubmissionId !== history.at(-1)?.submissionId)
      )
        throw new BuildPlanStoreConflictError("version_conflict");
      return {
        value: undefined,
        next: {
          ...aggregate,
          workspace: {
            ...aggregate.workspace,
            recordVersion: aggregate.workspace.recordVersion + 1,
            updatedAt: submission.submittedAt,
          },
          buildPlanning: {
            ...planning,
            submissionsByAssignmentId: {
              ...planning.submissionsByAssignmentId,
              [submission.assignmentId]: [...history, submission],
            },
          },
        },
      };
    });
  }

  private planRef(plan: ProjectBuildPlanVersion): BuildPlanRef {
    return {
      planId: plan.planId,
      version: plan.version,
      semanticDigest: plan.semanticDigest,
    };
  }

  private briefRef(brief: AgentBriefVersionRecord): AgentBriefRef {
    return {
      briefId: brief.briefId,
      version: brief.version,
      semanticDigest: brief.semanticDigest,
    };
  }

  private assignmentRef(
    assignment: PlanningAssignmentRecord,
  ): PlanningAssignmentRef {
    return {
      assignmentId: assignment.assignmentId,
      briefId: assignment.briefId,
      plannedAgentId: assignment.plannedAgentId,
    };
  }
}
