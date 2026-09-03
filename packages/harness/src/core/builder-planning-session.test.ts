import { describe, expect, it, vi } from "vitest";

import type {
  BuildPlanningAggregateV1,
  BuilderPlanningSessionBinding,
} from "../shared/build-plan.js";
import { emptyBuildPlanningAggregate } from "../shared/build-plan.js";
import { BuilderPlanningSessionService } from "./builder-planning-session.js";
import { computeCanonicalDigest } from "./build-plan-canonicalization.js";
import {
  AGENT_ID,
  ASSIGNMENT_ID,
  BRIEF_ID,
  PLAN_ID,
  PROJECT_ID,
  proposalSource,
  graph,
  makeBrief,
  makePlan,
} from "./build-plan.test-support.js";
import type { AgentMapProjectAggregate } from "./agent-map-workspace-store.js";
import type { HarnessSession } from "../shared/types.js";

describe("BuilderPlanningSessionService durable spawn claim", () => {
  it("has one CAS winner across service instances and recovers only an expired claim", async () => {
    const digest = `sha256:${"1".repeat(64)}`;
    const binding: BuilderPlanningSessionBinding = {
      bindingId:
        "builder-binding_00000000-0000-7000-8000-000000000010" as BuilderPlanningSessionBinding["bindingId"],
      projectId: PROJECT_ID,
      assignmentId: ASSIGNMENT_ID,
      plannedAgentId: AGENT_ID,
      purpose: "implementation-planning",
      source: proposalSource(),
      plan: {
        planId: PLAN_ID,
        version: 1 as never,
        semanticDigest: digest as never,
      },
      brief: {
        briefId: BRIEF_ID,
        version: 1 as never,
        semanticDigest: digest as never,
      },
      bootstrapDigest: digest as never,
      executionPolicy: "planning-readonly",
      spawnEpoch: 0,
      spawnClaimId: null,
      spawnClaimedAt: null,
      sessionId: null,
      state: "pending",
      staleReasons: [],
      kickoff: null,
      failureCode: null,
      createdAt: "2026-09-03T11:00:00.000Z",
      updatedAt: "2026-09-03T11:00:00.000Z",
    };
    let planning: BuildPlanningAggregateV1 = {
      ...emptyBuildPlanningAggregate(),
      builderBindingsByAssignmentId: { [ASSIGNMENT_ID]: binding },
    };
    let transaction = Promise.resolve();
    const workspaceStore = {
      transact: <T>(
        _projectId: string,
        operation: (aggregate: {
          buildPlanning: BuildPlanningAggregateV1;
        }) => Promise<{
          value: T;
          next?: { buildPlanning: BuildPlanningAggregateV1 };
        }>,
      ): Promise<T> => {
        let value!: T;
        transaction = transaction.then(async () => {
          const outcome = await operation({
            buildPlanning: structuredClone(planning),
          });
          if (outcome.next) planning = outcome.next.buildPlanning;
          value = outcome.value;
        });
        return transaction.then(() => value);
      },
    };
    let now = "2026-09-03T11:00:01.000Z";
    const service = () =>
      new BuilderPlanningSessionService({
        workspaceStore: workspaceStore as never,
        buildPlanStore: {} as never,
        contractValidator: {} as never,
        sessionManager: {} as never,
        currentUserId: () => "user-test",
        resolveProjectRoot: async () => "/tmp/project",
        defaultHarness: "codex",
        now: () => now,
        spawnClaimTtlMs: 1_000,
      });
    type Claim = (binding: BuilderPlanningSessionBinding) => Promise<{
      won: boolean;
      binding: BuilderPlanningSessionBinding;
    }>;
    const firstService = service() as unknown as { claimSpawn: Claim };
    const secondService = service() as unknown as { claimSpawn: Claim };
    const [first, second] = await Promise.all([
      firstService.claimSpawn(binding),
      secondService.claimSpawn(binding),
    ]);
    expect([first.won, second.won].sort()).toEqual([false, true]);
    expect(first.binding.spawnEpoch).toBe(1);
    expect(second.binding.spawnEpoch).toBe(1);

    now = "2026-09-03T11:00:03.000Z";
    const current = planning.builderBindingsByAssignmentId[ASSIGNMENT_ID]!;
    const recovered = await (
      service() as unknown as { claimSpawn: Claim }
    ).claimSpawn(current);
    expect(recovered.won).toBe(true);
    expect(recovered.binding.spawnEpoch).toBe(2);
  });
});

function publicFixture(includeApproval: boolean) {
  const plan = makePlan();
  const brief = makeBrief(plan);
  const planRef = {
    planId: plan.planId,
    version: plan.version,
    semanticDigest: plan.semanticDigest,
  };
  const briefRef = {
    briefId: brief.briefId,
    version: brief.version,
    semanticDigest: brief.semanticDigest,
  };
  const identity = {
    projectId: PROJECT_ID,
    sessionId: "planner-session",
    userId: "user-test",
    role: "map-planner" as const,
  };
  const approvalCore = {
    approvalId: "fanout-approval_00000000-0000-7000-8000-000000000020",
    projectId: PROJECT_ID,
    source: plan.source,
    plan: planRef,
    assignmentIds: [ASSIGNMENT_ID],
    approvedByUserId: identity.userId,
    approvingSessionId: identity.sessionId,
    userInputId: "user-action_00000000-0000-4000-8000-000000000021",
    approvedAt: "2026-09-03T11:00:00.000Z",
  };
  const approval = {
    ...approvalCore,
    approvalDigest: computeCanonicalDigest(
      "sapiom.planning-fanout-approval.v1",
      approvalCore,
    ),
  };
  let aggregate = {
    storageSchemaVersion: 2,
    workspace: {
      projectId: PROJECT_ID,
      schemaVersion: 1,
      recordVersion: 1,
      confirmedRevisionId: null,
      activeProposalId:
        plan.source.kind === "proposal" ? plan.source.proposalId : null,
      projectBuildPlanId: plan.planId,
      createdAt: "2026-09-03T10:00:00.000Z",
      updatedAt: "2026-09-03T10:00:00.000Z",
    },
    proposal: {
      schemaVersion: 1,
      id: plan.source.kind === "proposal" ? plan.source.proposalId : "",
      projectId: PROJECT_ID,
      baseRevisionId: null,
      version: 1,
      nodes: graph.nodes,
      relationships: graph.relationships,
      history: [],
      createdAt: "2026-09-03T10:00:00.000Z",
      updatedAt: "2026-09-03T10:00:00.000Z",
    },
    receipts: [],
    buildPlanning: {
      ...emptyBuildPlanningAggregate(),
      planId: plan.planId,
      currentPlanVersion: plan.version,
      planVersions: [plan],
      currentBriefByAgentId: { [AGENT_ID]: briefRef },
      briefVersionsById: { [BRIEF_ID]: [brief] },
      assignmentByAgentId: {
        [AGENT_ID]: {
          schemaVersion: 1,
          projectId: PROJECT_ID,
          assignmentId: ASSIGNMENT_ID,
          briefId: BRIEF_ID,
          plannedAgentId: AGENT_ID,
          status: "active",
          createdAt: "2026-09-03T10:00:00.000Z",
          retiredAt: null,
          transitions: [
            {
              status: "active",
              at: "2026-09-03T10:00:00.000Z",
              planVersion: plan.version,
            },
          ],
          recordDigest: `sha256:${"3".repeat(64)}`,
        },
      },
      fanoutApprovals: includeApproval ? [approval] : [],
    },
  } as unknown as AgentMapProjectAggregate;
  let transaction = Promise.resolve();
  const workspaceStore = {
    readAggregate: vi.fn(async () => structuredClone(aggregate)),
    transact: <T>(
      _projectId: string,
      operation: (
        current: AgentMapProjectAggregate,
      ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>,
    ): Promise<T> => {
      let value!: T;
      transaction = transaction.then(async () => {
        const outcome = await operation(structuredClone(aggregate));
        if (outcome.next) aggregate = outcome.next;
        value = outcome.value;
      });
      return transaction.then(() => value);
    },
  };
  const sessions: HarnessSession[] = [
    {
      id: identity.sessionId,
      agentSessionId: "planner-agent",
      harness: "codex",
      cwd: "/tmp/project",
      title: "Planner",
      status: "running",
      ready: true,
      createdAt: "2026-09-03T10:00:00.000Z",
      lastActiveAt: "2026-09-03T10:00:00.000Z",
      boundWorkflowPath: null,
      agentMapIdentity: identity,
    },
  ];
  const create = vi.fn(async (_request, trusted) => {
    const id = sessions.some((session) => session.id === "builder-session")
      ? "builder-session-2"
      : "builder-session";
    const session = {
      id,
      agentSessionId: "builder-agent",
      harness: "codex",
      cwd: "/tmp/project",
      title: "Builder",
      status: "running",
      ready: false,
      createdAt: "2026-09-03T11:00:00.000Z",
      lastActiveAt: "2026-09-03T11:00:00.000Z",
      boundWorkflowPath: null,
      executionPolicy: "planning-readonly",
      agentMapIdentity: trusted.agentMapIdentity(id),
      builderPlanning: trusted.builderPlanning(id),
    } as HarnessSession;
    sessions.push(session);
    return session;
  });
  const manager = {
    get: (id: string) => sessions.find((session) => session.id === id),
    list: () => sessions,
    create,
    setBuilderPlanningMetadata: vi.fn(
      async (id: string, metadata: HarnessSession["builderPlanning"]) => {
        const session = sessions.find((candidate) => candidate.id === id);
        if (session) session.builderPlanning = metadata;
      },
    ),
    submitInput: vi.fn(async () => false),
  };
  const service = () =>
    new BuilderPlanningSessionService({
      workspaceStore: workspaceStore as never,
      buildPlanStore: {
        read: async () => aggregate.buildPlanning,
        isCurrentProposalSource: async () => true,
      } as never,
      contractValidator: {
        validate: async () => ({
          completeness: { status: "complete", issues: [] },
          eligibility: {
            planningEligible: true,
            implementationEligible: false,
          },
        }),
      } as never,
      sessionManager: manager as never,
      currentUserId: () => identity.userId,
      resolveProjectRoot: async () => "/tmp/project",
      defaultHarness: "codex",
      now: () => "2026-09-03T11:00:00.000Z",
    });
  return {
    service,
    identity,
    request: {
      approvalId: approval.approvalId,
      source: plan.source,
      plan: planRef,
      assignmentIds: [ASSIGNMENT_ID],
    },
    create,
    aggregate: () => aggregate,
    sessions,
    briefRef,
  };
}

describe("BuilderPlanningSessionService public authorization", () => {
  it("rejects missing approval before any process side effect", async () => {
    const fixture = publicFixture(false);
    await expect(
      fixture.service().openOrReuse(fixture.identity, fixture.request),
    ).rejects.toMatchObject({ code: "missing_consent" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("concurrent services create one primary and a retry reuses it", async () => {
    const fixture = publicFixture(true);
    await Promise.all([
      fixture.service().openOrReuse(fixture.identity, fixture.request),
      fixture.service().openOrReuse(fixture.identity, fixture.request),
    ]);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    const replay = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.sessionId).toBe("builder-session");
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it("keeps an exited primary as history and creates one replacement", async () => {
    const fixture = publicFixture(true);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!.status = "exited";
    const replacement = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(replacement[0]?.sessionId).toBe("builder-session-2");
    expect(
      fixture.sessions.find((session) => session.id === "builder-session")
        ?.builderPlanning?.state,
    ).toBe("failed");
  });

  it("submits only for the exact effective brief and enforces request replay", async () => {
    const fixture = publicFixture(true);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    const session = fixture.sessions.find(
      (candidate) => candidate.id === "builder-session",
    )!;
    const metadata = session.builderPlanning!;
    const builder = session.agentMapIdentity!;
    const request = {
      schemaVersion: 1 as const,
      expected: {
        assignmentId: metadata.assignmentId,
        source: metadata.source,
        plan: metadata.plan,
        brief: metadata.brief,
        bootstrapDigest: metadata.bootstrapDigest,
      },
      requestId: "submit-once",
      status: "ready" as const,
      implementationPlan: [
        {
          stepId: "step-one",
          ordinal: 1,
          description: "Implement the bounded change",
          verification: "Run the focused suite",
        },
      ],
      risks: [],
      questions: [],
      proposedMapOperationIds: [],
    };
    const service = fixture.service();
    const first = await service.submitResult(builder, request);
    const replay = await service.submitResult(builder, request);
    expect(replay).toEqual(first);
    await expect(
      service.submitResult(builder, {
        ...request,
        implementationPlan: [
          { ...request.implementationPlan[0]!, description: "Changed payload" },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });

    const aggregate = fixture.aggregate();
    aggregate.buildPlanning = {
      ...aggregate.buildPlanning,
      currentBriefByAgentId: {},
    };
    await expect(
      service.submitResult(builder, { ...request, requestId: "submit-stale" }),
    ).rejects.toMatchObject({ code: "binding_stale" });
  });
});
