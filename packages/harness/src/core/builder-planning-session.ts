import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  PlanningSessionIdentity,
  StudioProjectId,
} from "../shared/agent-map.js";
import type {
  AgentBriefRef,
  ArchitectureSourceRef,
  BuilderBootstrapContext,
  BuilderKickoffId,
  BuilderPlanningSessionBinding,
  BuilderPlanningSubmission,
  BuildPlanRef,
  PlanningAssignmentId,
  PlanningFanoutApproval,
  PlanningFanoutPreview,
  PlanningSubmissionIdempotencyReceipt,
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
  computeCanonicalDigest,
  computePlanningSubmissionRecordDigest,
  computePlanningSubmissionSemanticDigest,
} from "./build-plan-canonicalization.js";
import {
  createBuilderBootstrapContext,
  serializeBuilderBootstrapContext,
} from "./builder-bootstrap-context.js";
import type { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import type { BuildPlanContractValidator } from "./build-plan-contract-validator.js";
import type { BuildPlanStore } from "./build-plan-store.js";
import type { SessionManager } from "./session-manager.js";
import { BUILDER_PLANNING_KICKOFF } from "../profiles/agent-map-builder-planning.js";

const opaque = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
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
    ordinal: z.number().int().positive(),
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
    implementationPlan: z.array(stepSchema).min(1).max(256),
    risks: z.array(riskSchema).max(256),
    questions: z.array(questionSchema).max(256),
    proposedMapOperationIds: z.array(refId("operation")).max(256),
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
  ) {
    super(code.replace(/_/gu, " "));
    this.name = "BuilderPlanningSessionError";
  }
}

export interface BuilderPlanningSessionServiceOptions {
  workspaceStore: AgentMapWorkspaceStore;
  buildPlanStore: BuildPlanStore;
  contractValidator: BuildPlanContractValidator;
  sessionManager: SessionManager;
  currentUserId: () => string;
  resolveProjectRoot: (projectId: StudioProjectId) => Promise<string>;
  defaultHarness: HarnessKind;
  now?: () => string;
  /** A crashed creator may be replaced only after this durable lease expires. */
  spawnClaimTtlMs?: number;
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
  if (binding.kickoff?.state === "delivered") return binding;
  const uncertain = outcome.accepted || outcome.ambiguous;
  return {
    ...binding,
    state: uncertain ? "delivery-uncertain" : "kickoff-pending",
    kickoff: {
      ...binding.kickoff!,
      state: uncertain ? "delivery-uncertain" : "pending",
    },
    updatedAt: outcome.updatedAt,
  };
}

export class BuilderPlanningSessionService {
  private readonly now: () => string;
  private readonly spawnClaimTtlMs: number;
  private readonly expectedKickoffs = new Map<
    string,
    { inputId: string; text: string }
  >();
  private readonly projectOpens = new Map<string, Promise<unknown>>();

  constructor(private readonly options: BuilderPlanningSessionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnClaimTtlMs = options.spawnClaimTtlMs ?? 120_000;
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

  private async exactPlanning(
    projectId: StudioProjectId,
    request: ApprovePlanningFanoutRequest,
  ) {
    const aggregate =
      await this.options.workspaceStore.readAggregate(projectId);
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
      !same(plan.source, request.source) ||
      !(await this.options.buildPlanStore.isCurrentProposalSource(
        projectId,
        request.source,
      ))
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
        !brief ||
        brief.assignmentId !== assignmentId ||
        brief.plan.planId !== request.plan.planId ||
        !same(brief.source, request.source)
      )
        throw new BuilderPlanningSessionError("plan_not_ready");
      return brief;
    });
    const status = await this.options.contractValidator.validate(plan, briefs);
    if (!status.eligibility.planningEligible)
      throw new BuilderPlanningSessionError("plan_not_ready");
    const proposal = aggregate.proposal;
    if (
      request.source.kind !== "proposal" ||
      !proposal ||
      proposal.id !== request.source.proposalId ||
      proposal.version !== request.source.version
    )
      throw new BuilderPlanningSessionError("plan_not_ready");
    return {
      aggregate,
      plan,
      briefs,
      graph: { nodes: proposal.nodes, relationships: proposal.relationships },
    };
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
    const exact = await this.exactPlanning(identity.projectId, request);
    const approval = exact.aggregate.buildPlanning.fanoutApprovals.find(
      (entry) => entry.approvalId === request.approvalId,
    );
    if (!approval) throw new BuilderPlanningSessionError("missing_consent");
    const approvalProjection = { ...approval };
    const claimedDigest = approvalProjection.approvalDigest;
    delete (approvalProjection as Partial<PlanningFanoutApproval>)
      .approvalDigest;
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

    const contexts = exact.briefs.map((brief) => {
      const briefRef: AgentBriefRef = {
        briefId: brief.briefId,
        version: brief.version,
        semanticDigest: brief.semanticDigest,
      };
      const prior =
        exact.aggregate.buildPlanning.builderBindingsByAssignmentId[
          brief.assignmentId
        ];
      const priorPlan = prior
        ? exact.aggregate.buildPlanning.planVersions.find((candidate) =>
            same(
              {
                planId: candidate.planId,
                version: candidate.version,
                semanticDigest: candidate.semanticDigest,
              },
              prior.plan,
            ),
          )
        : undefined;
      const priorBootstrap =
        prior &&
        priorPlan &&
        prior.plan.planId === request.plan.planId &&
        same(prior.source, request.source) &&
        same(prior.brief, briefRef)
          ? createBuilderBootstrapContext({
              plan: priorPlan,
              graph: exact.graph,
              brief,
            })
          : null;
      const reusePrior = Boolean(
        prior &&
          priorBootstrap &&
          priorBootstrap.contextDigest === prior.bootstrapDigest,
      );
      const bootstrap =
        reusePrior && priorBootstrap
          ? priorBootstrap
          : createBuilderBootstrapContext({
              plan: exact.plan,
              graph: exact.graph,
              brief,
            });
      return {
        brief,
        bootstrap,
        reuseBindingId: reusePrior ? prior?.bindingId : undefined,
      };
    });
    const timestamp = this.now();
    const claimed = await this.options.workspaceStore.transact(
      identity.projectId,
      async (aggregate) => {
        const bindings = {
          ...aggregate.buildPlanning.builderBindingsByAssignmentId,
        };
        const result: BuilderPlanningSessionBinding[] = [];
        const staleSessionIds: string[] = [];
        const transactionPlan = aggregate.buildPlanning.planVersions.find(
          (candidate) =>
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
          !transactionPlan ||
          aggregate.buildPlanning.currentPlanVersion !== request.plan.version ||
          !same(transactionPlan.source, request.source)
        )
          throw new BuilderPlanningSessionError("stale_consent");
        for (const { brief, bootstrap, reuseBindingId } of contexts) {
          const current = bindings[brief.assignmentId];
          const ref: AgentBriefRef = {
            briefId: brief.briefId,
            version: brief.version,
            semanticDigest: brief.semanticDigest,
          };
          if (
            current &&
            reuseBindingId !== undefined &&
            current.bindingId === reuseBindingId &&
            same(
              aggregate.buildPlanning.currentBriefByAgentId[
                brief.plannedAgentId
              ],
              ref,
            ) &&
            current.bootstrapDigest === bootstrap.contextDigest
          ) {
            result.push(current);
            continue;
          }
          if (current?.sessionId) {
            staleSessionIds.push(current.sessionId);
          }
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
          result.push(binding);
        }
        return {
          value: { bindings: result, staleSessionIds },
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
    for (const claim of claimed.bindings) {
      const context = contexts.find(
        ({ brief }) => brief.assignmentId === claim.assignmentId,
      )!;
      output.push(
        await this.ensureSession(identity, claim, context.bootstrap, request),
      );
    }
    return output;
  }

  private async updateBinding(
    binding: BuilderPlanningSessionBinding,
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
        if (!current || current.bindingId !== binding.bindingId)
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
          session.executionPolicy === "planning-readonly" &&
          same(session.builderPlanning.source, binding.source) &&
          same(session.builderPlanning.plan, binding.plan) &&
          same(session.builderPlanning.brief, binding.brief) &&
          session.builderPlanning.bootstrapDigest === binding.bootstrapDigest,
      );
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
      if (!current || current.bindingId !== binding.bindingId)
        throw new BuilderPlanningSessionError("binding_stale");
      if (current.sessionId) return { value: { won: false, binding: current } };
      const claimedAtMs = current.spawnClaimedAt
        ? Date.parse(current.spawnClaimedAt)
        : Number.NaN;
      const liveClaim =
        current.spawnClaimId !== null &&
        Number.isFinite(claimedAtMs) &&
        nowMs - claimedAtMs < this.spawnClaimTtlMs;
      if (liveClaim) return { value: { won: false, binding: current } };
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
    let session = current.sessionId
      ? this.options.sessionManager.get(current.sessionId)
      : undefined;
    session ??= this.matchingSession(current);
    if (session?.status === "exited" && current.state !== "submitted") {
      // The exited process remains in SessionManager as inspectable history,
      // but it cannot satisfy the live primary binding. Clear only the exact
      // current attachment, then compete for the same durable creation lease.
      if (session.builderPlanning)
        await this.options.sessionManager.setBuilderPlanningMetadata(
          session.id,
          { ...session.builderPlanning, state: "failed" },
        );
      const exitedId = session.id;
      current = await this.updateBinding(current, (value) =>
        value.sessionId !== exitedId
          ? value
          : {
              ...value,
              sessionId: null,
              state: "failed",
              spawnClaimId: null,
              spawnClaimedAt: null,
              kickoff: null,
              failureCode: "spawn_failed",
              updatedAt: this.now(),
            },
      );
      session = undefined;
    }
    if (session) {
      current = await this.updateBinding(current, (value) => ({
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
      }));
      if (session.ready) void this.deliverKickoff(current);
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
      current = await this.updateBinding(current, (value) => ({
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
      }));
      return current;
    }
    const claimId = claim.claimId;
    try {
      const root = await this.options.resolveProjectRoot(planner.projectId);
      const created = await this.options.sessionManager.create(
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
      const inputId = stableId("kickoff", {
        assignmentId: current.assignmentId,
        bootstrapDigest: current.bootstrapDigest,
        kind: "input",
      });
      current = await this.updateBinding(current, (value) => {
        if (value.spawnClaimId !== claimId)
          throw new BuilderPlanningSessionError("binding_stale");
        return {
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
            deliveredAt: null,
            acknowledgedBy: null,
          },
          updatedAt: this.now(),
        };
      });
      await this.options.sessionManager.setBuilderPlanningMetadata(
        created.id,
        sessionMetadata(current),
      );
      if (created.ready) void this.deliverKickoff(current);
      return current;
    } catch {
      return this.updateBinding(current, (value) =>
        value.spawnClaimId !== claimId
          ? value
          : {
              ...value,
              state: "failed",
              spawnClaimId: null,
              spawnClaimedAt: null,
              failureCode: "spawn_failed",
              updatedAt: this.now(),
            },
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
    const text = kickoffText(binding.kickoff.inputId);
    const delivering = await this.updateBinding(binding, (value) => ({
      ...value,
      state: "kickoff-pending",
      kickoff: {
        ...value.kickoff!,
        state: "delivering",
        attemptCount: value.kickoff!.attemptCount + 1,
      },
      updatedAt: this.now(),
    }));
    this.expectedKickoffs.set(binding.sessionId, {
      inputId: binding.kickoff.inputId,
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
            latest.kickoff?.state === "delivering"
          );
        },
      );
    } catch {
      // The adapter may have accepted bytes before surfacing an error. Preserve
      // uncertainty and require acknowledgement reconciliation before retry.
      ambiguous = true;
    }
    if (!accepted && !ambiguous)
      this.expectedKickoffs.delete(binding.sessionId);
    const uncertain = await this.updateBinding(delivering, (value) => {
      // A prompt hook can be persisted before submitInput returns. Delivered is
      // terminal for this kickoff epoch and must never be downgraded.
      return reconcileKickoffAttempt(value, {
        accepted,
        ambiguous,
        updatedAt: this.now(),
      });
    });
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
    const delivered = await this.updateBinding(binding, (value) => ({
      ...value,
      state: "planning",
      kickoff: {
        ...value.kickoff!,
        state: "delivered",
        deliveredAt: event.ts,
        acknowledgedBy: { source: "hook", observedAt: event.ts },
      },
      updatedAt: this.now(),
    }));
    this.expectedKickoffs.delete(session.id);
    await this.options.sessionManager
      .setBuilderPlanningMetadata(session.id, sessionMetadata(delivered))
      .catch(() => {});
  }

  async reconcile(): Promise<void> {
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
      if (session.ready && binding.kickoff.state === "pending")
        void this.deliverKickoff(binding);
    }
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
    let request: PlanningResultSubmitRequest;
    try {
      request = planningResultSubmitRequestSchema.parse(
        raw,
      ) as unknown as PlanningResultSubmitRequest;
    } catch {
      throw new BuilderPlanningSessionError("invalid_request");
    }
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
    const planning = await this.options.buildPlanStore.read(identity.projectId);
    const currentPlan = planning.planVersions.find(
      (candidate) => candidate.version === planning.currentPlanVersion,
    );
    const boundPlan = planning.planVersions.find((candidate) =>
      same(
        {
          planId: candidate.planId,
          version: candidate.version,
          semanticDigest: candidate.semanticDigest,
        },
        request.expected.plan,
      ),
    );
    const currentBrief =
      planning.currentBriefByAgentId[identity.assignment.agentId];
    if (
      !currentPlan ||
      !boundPlan ||
      currentPlan.planId !== boundPlan.planId ||
      !currentBrief ||
      !same(currentBrief, request.expected.brief) ||
      !(await this.options.buildPlanStore.isCurrentProposalSource(
        identity.projectId,
        request.expected.source,
      ))
    )
      throw new BuilderPlanningSessionError("binding_stale");
    const requestDigest = computeCanonicalDigest(
      "sapiom.planning-result-request.v1",
      request,
    );
    const submittedAt = this.now();
    const submissionId = stableId("submission", {
      sessionId: identity.sessionId,
      requestId: request.requestId,
    });
    const committed = await this.options.workspaceStore.transact(
      identity.projectId,
      async (aggregate) => {
        const receipt = aggregate.buildPlanning.planningSubmissionReceipts.find(
          (entry) =>
            entry.sessionId === identity.sessionId &&
            entry.requestId === request.requestId,
        );
        if (receipt) {
          if (receipt.requestDigest !== requestDigest)
            throw new BuilderPlanningSessionError("idempotency_key_reused");
          const replay = Object.values(
            aggregate.buildPlanning.submissionsByAssignmentId,
          )
            .flat()
            .find((entry) => entry.submissionId === receipt.submissionId);
          if (!replay)
            throw new BuilderPlanningSessionError("context_mismatch");
          return { value: replay };
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
        if (
          !latestPlan ||
          !bindingPlan ||
          latestPlan.planId !== bindingPlan.planId ||
          !bindingBrief ||
          bindingBrief.assignmentId !== binding.assignmentId ||
          bindingBrief.plannedAgentId !== binding.plannedAgentId ||
          !same(latestBrief, binding.brief) ||
          !same(bindingPlan.source, binding.source) ||
          !same(bindingBrief.source, binding.source) ||
          aggregate.proposal?.id !==
            (binding.source.kind === "proposal"
              ? binding.source.proposalId
              : null) ||
          aggregate.proposal?.version !==
            (binding.source.kind === "proposal"
              ? binding.source.version
              : -1) ||
          !proposalGraph ||
          createBuilderBootstrapContext({
            plan: bindingPlan,
            graph: proposalGraph,
            brief: bindingBrief,
          }).contextDigest !== binding.bootstrapDigest
        )
          throw new BuilderPlanningSessionError("binding_stale");
        if (request.status === "changes-proposed") {
          const allowed = new Set(
            (aggregate.proposal?.history ?? [])
              .filter((entry) => entry.actor.sessionId === identity.sessionId)
              .map((entry) => entry.id),
          );
          if (
            request.proposedMapOperationIds.some(
              (id) => !allowed.has(id as never),
            )
          )
            throw new BuilderPlanningSessionError(
              "invalid_proposal_operations",
            );
        } else if (request.proposedMapOperationIds.length > 0)
          throw new BuilderPlanningSessionError("invalid_proposal_operations");
        const history =
          aggregate.buildPlanning.submissionsByAssignmentId[
            binding.assignmentId
          ] ?? [];
        if (
          history.length >= 1_024 ||
          aggregate.buildPlanning.planningSubmissionReceipts.length >= 1_024
        )
          throw new BuilderPlanningSessionError("invalid_request");
        const draft = {
          schemaVersion: 1 as const,
          submissionId,
          projectId: identity.projectId,
          assignmentId: binding.assignmentId,
          sessionId: identity.sessionId,
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
          value: submission,
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
              ],
              builderBindingsByAssignmentId: {
                ...aggregate.buildPlanning.builderBindingsByAssignmentId,
                [binding.assignmentId]: nextBinding,
              },
            },
          },
        };
      },
    );
    await this.options.sessionManager.setBuilderPlanningMetadata(
      identity.sessionId,
      { ...session.builderPlanning, state: "submitted" },
    );
    return committed;
  }
}
