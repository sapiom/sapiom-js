import { v7 as uuidv7 } from "uuid";

import type {
  AgentMapGraph,
  PlanNodeId,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  AgentBriefId,
  AgentBriefRef,
  AgentBriefVersionRecord,
  BuildPlanIdempotencyReceipt,
  BuildPlanId,
  BuildPlanRef,
  BuilderPlanningSubmission,
  PlanningAssignmentId,
  PlanningAssignmentRef,
  PlanningAssignmentRecord,
  ProjectBuildPlanVersion,
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
  computePlanningSubmissionSemanticDigest,
} from "./build-plan-canonicalization.js";

export class BuildPlanStoreConflictError extends Error {
  constructor(readonly code: "version_conflict" | "request_id_reused") {
    super(
      code === "version_conflict"
        ? "Build planning version changed"
        : "Build planning request ID was reused",
    );
    this.name = "BuildPlanStoreConflictError";
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

const sameSource = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Persistence primitives over the same crash-atomic E2 project aggregate. */
export class BuildPlanStore {
  private readonly allocator: BuildPlanIdentityAllocator;
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentMapWorkspaceStore,
    options: { allocator?: BuildPlanIdentityAllocator; now?: () => Date } = {},
  ) {
    this.allocator =
      options.allocator ?? new UuidV7BuildPlanIdentityAllocator();
    this.now = options.now ?? (() => new Date());
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
          assignmentByAgentId[agentId] = {
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
          };
          delete currentBriefByAgentId[agentId];
        }
      }
      for (const agentId of topLevelAgentIds) {
        const existing = assignmentByAgentId[agentId];
        assignmentByAgentId[agentId] = existing
          ? existing.status === "retired"
            ? {
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
              }
            : existing
          : {
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
            };
      }
      const receipt: BuildPlanIdempotencyReceipt = {
        ...request,
        resultRecordDigest: plan.recordDigest,
        createdAt: timestamp,
      };
      const nextPlanning = {
        ...planning,
        planId: plan.planId,
        currentPlanVersion: plan.version,
        planVersions: [...planning.planVersions, plan],
        currentBriefByAgentId,
        assignmentByAgentId,
        idempotencyReceipts: [...planning.idempotencyReceipts, receipt].slice(
          -256,
        ),
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
      const histories = { ...planning.briefVersionsById };
      const current = { ...planning.currentBriefByAgentId };
      for (const brief of briefs) {
        const assignment = planning.assignmentByAgentId[brief.plannedAgentId];
        const history = histories[brief.briefId] ?? [];
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
          !sameSource(plan.source, brief.source)
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
      submission.semanticDigest
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
        !sameSource(plan.source, submission.source) ||
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
