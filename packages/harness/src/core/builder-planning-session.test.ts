import { describe, expect, it, vi } from "vitest";

import type {
  BuildPlanningAggregateV1,
  BuilderPlanningSessionBinding,
} from "../shared/build-plan.js";
import { emptyBuildPlanningAggregate } from "../shared/build-plan.js";
import {
  BuilderPlanningSessionService,
  planningResultSubmitRequestSchema,
  reconcileKickoffAttempt,
} from "./builder-planning-session.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";
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
import type { AnalyticsEvent, HarnessSession } from "../shared/types.js";
import {
  SessionAlreadyLiveError,
  SessionNotReadyError,
} from "./session-manager.js";

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

    planning = {
      ...planning,
      builderBindingsByAssignmentId: {
        ...planning.builderBindingsByAssignmentId,
        [ASSIGNMENT_ID]: {
          ...recovered.binding,
          bootstrapDigest: `sha256:${"f".repeat(64)}` as never,
          sessionId: null,
          spawnClaimId: null,
          spawnClaimedAt: null,
          state: "pending",
        },
      },
    };
    await expect(
      (service() as unknown as { claimSpawn: Claim }).claimSpawn(
        recovered.binding,
      ),
    ).rejects.toMatchObject({ code: "binding_stale" });
  });
});

describe("planning result request boundary", () => {
  const base = {
    schemaVersion: 1,
    expected: {
      assignmentId: ASSIGNMENT_ID,
      source: proposalSource(),
      plan: {
        planId: PLAN_ID,
        version: 1,
        semanticDigest: `sha256:${"1".repeat(64)}`,
      },
      brief: {
        briefId: BRIEF_ID,
        version: 1,
        semanticDigest: `sha256:${"2".repeat(64)}`,
      },
      bootstrapDigest: `sha256:${"3".repeat(64)}`,
    },
    requestId: "submit-request",
    status: "changes-proposed",
    implementationPlan: [
      {
        stepId: "step-one",
        ordinal: 1,
        description: "Implement",
        verification: "Verify",
      },
    ],
    risks: [
      { riskId: "risk-one", description: "Risk", mitigation: "Mitigate" },
    ],
    questions: [{ questionId: "question-one", question: "Question?" }],
    proposedMapOperationIds: ["operation_00000000-0000-7000-8000-000000000001"],
  };

  it.each([
    [
      "duplicate step ids",
      {
        implementationPlan: [
          base.implementationPlan[0],
          { ...base.implementationPlan[0], ordinal: 2 },
        ],
      },
    ],
    [
      "duplicate ordinals",
      {
        implementationPlan: [
          base.implementationPlan[0],
          { ...base.implementationPlan[0], stepId: "step-two" },
        ],
      },
    ],
    ["duplicate risk ids", { risks: [base.risks[0], base.risks[0]] }],
    [
      "duplicate question ids",
      { questions: [base.questions[0], base.questions[0]] },
    ],
    [
      "duplicate proposal operation ids",
      {
        proposedMapOperationIds: [
          base.proposedMapOperationIds[0],
          base.proposedMapOperationIds[0],
        ],
      },
    ],
    ["whitespace request id", { requestId: "   " }],
    ["leading whitespace request id", { requestId: " submit-request" }],
    ["trailing whitespace request id", { requestId: "submit-request " }],
    [
      "whitespace step id",
      {
        implementationPlan: [{ ...base.implementationPlan[0], stepId: "   " }],
      },
    ],
    [
      "surrounding whitespace step id",
      {
        implementationPlan: [
          { ...base.implementationPlan[0], stepId: "step-one " },
        ],
      },
    ],
    [
      "unsafe integer ordinal",
      {
        implementationPlan: [
          {
            ...base.implementationPlan[0],
            ordinal: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      },
    ],
  ])("rejects %s", (_name, changes) => {
    expect(
      planningResultSubmitRequestSchema.safeParse({ ...base, ...changes })
        .success,
    ).toBe(false);
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
      history: [
        ...graph.nodes.map((node, index) => ({
          id: `operation_00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
          requestId: "initial-map",
          acceptedVersion: 1,
          operation: { kind: "add-node" as const, node },
          actor: {
            userId: identity.userId,
            sessionId: identity.sessionId,
            role: "map-planner" as const,
            assignment: null,
          },
          acceptedAt: "2026-09-03T10:00:00.000Z",
        })),
        ...graph.relationships.map((relationship, index) => ({
          id: `operation_00000000-0000-7000-8001-${String(index + 1).padStart(12, "0")}`,
          requestId: "initial-map",
          acceptedVersion: 1,
          operation: { kind: "add-relationship" as const, relationship },
          actor: {
            userId: identity.userId,
            sessionId: identity.sessionId,
            role: "map-planner" as const,
            assignment: null,
          },
          acceptedAt: "2026-09-03T10:00:00.000Z",
        })),
      ],
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
  let beforeNextTransaction: (() => void | Promise<void>) | null = null;
  const workspaceStore = {
    readAggregate: vi.fn(async () => structuredClone(aggregate)),
    transact: <T>(
      _projectId: string,
      operation: (
        current: AgentMapProjectAggregate,
      ) => Promise<{ value: T; next?: AgentMapProjectAggregate }>,
    ): Promise<T> => {
      let value!: T;
      const run = transaction.then(async () => {
        const before = beforeNextTransaction;
        beforeNextTransaction = null;
        await before?.();
        const outcome = await operation(structuredClone(aggregate));
        if (outcome.next) aggregate = outcome.next;
        value = outcome.value;
      });
      transaction = run.then(
        () => undefined,
        () => undefined,
      );
      return run.then(() => value);
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
  const resume = vi.fn(async (id: string) => {
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error("missing session");
    session.status = "running";
    session.ready = false;
    return session;
  });
  const manager = {
    get: (id: string) => sessions.find((session) => session.id === id),
    list: () => sessions,
    create,
    resume,
    kill: vi.fn(async (id: string) => {
      const session = sessions.find((candidate) => candidate.id === id);
      if (!session) return false;
      session.status = "exited";
      session.ready = false;
      return true;
    }),
    setBuilderPlanningMetadata: vi.fn(
      async (id: string, metadata: HarnessSession["builderPlanning"]) => {
        const session = sessions.find((candidate) => candidate.id === id);
        if (session) session.builderPlanning = metadata;
      },
    ),
    submitInput: vi.fn(async () => false),
  };
  const service = (
    validate?: () => Promise<{
      completeness: { status: "complete"; issues: never[] };
      eligibility: {
        planningEligible: true;
        implementationEligible: false;
      };
    }>,
    sessionManager: typeof manager = manager,
  ) =>
    new BuilderPlanningSessionService({
      workspaceStore: workspaceStore as never,
      buildPlanStore: {
        read: async () => aggregate.buildPlanning,
        isCurrentProposalSource: async () => true,
      } as never,
      contractValidator: {
        validate:
          validate ??
          (async () => ({
            completeness: { status: "complete" as const, issues: [] },
            eligibility: {
              planningEligible: true as const,
              implementationEligible: false as const,
            },
          })),
      } as never,
      sessionManager: sessionManager as never,
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
    resume,
    aggregate: () => aggregate,
    sessions,
    briefRef,
    workspaceStore,
    manager,
    beforeNextTransaction: (action: () => void | Promise<void>) => {
      beforeNextTransaction = action;
    },
  };
}

function markBuilderPlanning(fixture: ReturnType<typeof publicFixture>) {
  const session = fixture.sessions.find(
    (candidate) => candidate.id === "builder-session",
  )!;
  const binding =
    fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
      ASSIGNMENT_ID
    ]!;
  binding.state = "planning";
  binding.kickoff = {
    kickoffId: "kickoff_00000000-0000-7000-8000-000000000030" as never,
    inputId: "input_00000000-0000-7000-8000-000000000031",
    state: "delivered",
    attemptCount: 1,
    deliveryClaimId: null,
    deliveryClaimedAt: null,
    deliveredAt: "2026-09-03T11:00:01.000Z",
    acknowledgedBy: {
      source: "hook",
      observedAt: "2026-09-03T11:00:01.000Z",
    },
  };
  session.builderPlanning = {
    ...session.builderPlanning!,
    state: "planning",
    primary: true,
  };
  return { session, binding, builder: session.agentMapIdentity! };
}

describe("BuilderPlanningSessionService public authorization", () => {
  it("rejects missing approval before any process side effect", async () => {
    const fixture = publicFixture(false);
    await expect(
      fixture.service().openOrReuse(fixture.identity, fixture.request),
    ).rejects.toMatchObject({ code: "missing_consent" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("fails closed when the effective brief is a legacy persisted record", async () => {
    const fixture = publicFixture(true);
    const brief =
      fixture.aggregate().buildPlanning.briefVersionsById[BRIEF_ID]![0]!;
    Object.assign(brief, { schemaVersion: 1 });
    delete (brief as { digestVersion?: number }).digestVersion;

    await expect(
      fixture.service().openOrReuse(fixture.identity, fixture.request),
    ).rejects.toMatchObject({ code: "plan_not_ready" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rechecks the exact proposal source under the binding transaction lock", async () => {
    const fixture = publicFixture(true);
    fixture.beforeNextTransaction(() => {
      fixture.aggregate().proposal!.version = 2;
    });
    await expect(
      fixture.service().openOrReuse(fixture.identity, fixture.request),
    ).rejects.toMatchObject({ code: "stale_consent" });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toBeUndefined();
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

  it("does not clobber a live primary owned by another process-local registry", async () => {
    const fixture = publicFixture(true);
    const first = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    const foreignCreate = vi.fn();
    const foreignPlanner = fixture.sessions.find(
      (session) => session.id === "planner-session",
    )!;
    const foreignManager = {
      get: (id: string) =>
        id === foreignPlanner.id ? foreignPlanner : undefined,
      list: () => [foreignPlanner],
      create: foreignCreate,
      resume: vi.fn(),
      kill: vi.fn(),
      setBuilderPlanningMetadata: vi.fn(),
      submitInput: vi.fn(),
    };

    const replay = await fixture
      .service(undefined, foreignManager as never)
      .openOrReuse(fixture.identity, fixture.request);

    expect(foreignCreate).not.toHaveBeenCalled();
    expect(replay[0]).toMatchObject({
      bindingId: first[0]?.bindingId,
      sessionId: "builder-session",
      state: first[0]?.state,
    });
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({ sessionId: "builder-session" });
  });

  it("decides reuse from transactional state after a delayed opener pre-read", async () => {
    const fixture = publicFixture(true);
    let announcePreflight!: () => void;
    const preflightRead = new Promise<void>((resolve) => {
      announcePreflight = resolve;
    });
    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const delayed = fixture.service(async () => {
      announcePreflight();
      await preflightGate;
      return {
        completeness: { status: "complete", issues: [] },
        eligibility: {
          planningEligible: true,
          implementationEligible: false,
        },
      };
    });
    const delayedOpen = delayed.openOrReuse(fixture.identity, fixture.request);
    await preflightRead;
    const first = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    releasePreflight();
    const second = await delayedOpen;
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(first[0]?.bindingId).toBe(second[0]?.bindingId);
    expect(first[0]?.sessionId).toBe("builder-session");
    expect(second[0]?.sessionId).toBe("builder-session");
  });

  it("stops a just-created orphan when another owner wins before attach", async () => {
    const fixture = publicFixture(true);
    const create = fixture.create.getMockImplementation()!;
    fixture.create.mockImplementationOnce(async (...args) => {
      const orphan = await create(...args);
      fixture.beforeNextTransaction(() => {
        const binding =
          fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
            ASSIGNMENT_ID
          ]!;
        binding.sessionId = "winner-session";
        binding.state = "kickoff-pending";
        binding.spawnClaimId = null;
        binding.spawnClaimedAt = null;
        binding.kickoff = {
          kickoffId: "kickoff_00000000-0000-7000-8000-000000000090" as never,
          inputId: "input_00000000-0000-7000-8000-000000000091",
          state: "pending",
          attemptCount: 0,
          deliveryClaimId: null,
          deliveryClaimedAt: null,
          deliveredAt: null,
          acknowledgedBy: null,
        };
        fixture.sessions.push({
          ...structuredClone(orphan),
          id: "winner-session",
          agentSessionId: "winner-agent",
          status: "running",
          builderPlanning: {
            ...orphan.builderPlanning!,
            state: "kickoff-pending",
          },
          agentMapIdentity: {
            ...orphan.agentMapIdentity!,
            sessionId: "winner-session",
          },
        });
      });
      return orphan;
    });

    const [binding] = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);

    expect(binding?.sessionId).toBe("winner-session");
    expect(fixture.manager.kill).toHaveBeenCalledWith("builder-session");
    expect(
      fixture.sessions.find((session) => session.id === "builder-session")
        ?.status,
    ).toBe("exited");
    expect(
      fixture.sessions.find((session) => session.id === "winner-session")
        ?.status,
    ).toBe("running");
  });

  it("resumes an exited primary with the same durable session id", async () => {
    const fixture = publicFixture(true);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!.status = "exited";
    const resumed = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.resume).toHaveBeenCalledWith(
      "builder-session",
      expect.objectContaining({
        builderPlanning: expect.objectContaining({
          bindingId: resumed[0]?.bindingId,
        }),
        promptAppendix: expect.stringContaining("builder-assignment-data"),
      }),
    );
    expect(resumed[0]?.sessionId).toBe("builder-session");
  });

  it("reconstructs trusted context for scoped same-id resume", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!.status = "exited";
    const resumed = await service.resume(PROJECT_ID, "builder-session");
    expect(resumed.id).toBe("builder-session");
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(fixture.resume).toHaveBeenCalledWith(
      "builder-session",
      expect.objectContaining({
        promptAppendix: expect.stringContaining("builder-assignment-data"),
      }),
    );
  });

  it("does not poison a primary binding on a benign double-resume", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    const [opened] = await service.openOrReuse(
      fixture.identity,
      fixture.request,
    );
    fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!.status = "exited";
    fixture.resume.mockRejectedValueOnce(
      new SessionAlreadyLiveError("builder-session"),
    );

    await expect(
      service.resume(PROJECT_ID, "builder-session"),
    ).rejects.toBeInstanceOf(SessionAlreadyLiveError);
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      sessionId: "builder-session",
      state: opened?.state,
      failureCode: null,
    });
  });

  it("kills an externally resumed process when its exact context is replaced", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!.status = "exited";
    const resume = fixture.resume.getMockImplementation()!;
    fixture.resume.mockImplementationOnce(async (...args) => {
      const resumed = await resume(...args);
      fixture.beforeNextTransaction(() => {
        const replacement =
          fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
            ASSIGNMENT_ID
          ]!;
        replacement.bootstrapDigest = `sha256:${"f".repeat(64)}` as never;
        replacement.sessionId = null;
        replacement.state = "pending";
        replacement.kickoff = null;
      });
      return resumed;
    });

    await expect(
      service.resume(PROJECT_ID, "builder-session"),
    ).rejects.toMatchObject({ code: "binding_stale" });
    expect(fixture.manager.kill).toHaveBeenCalledWith("builder-session");
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      bootstrapDigest: `sha256:${"f".repeat(64)}`,
      sessionId: null,
      state: "pending",
    });
  });

  it("opens an additional read-only session without replacing the primary binding", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);

    const additional = await service.openAdditionalSession(
      PROJECT_ID,
      "builder-session",
      { harness: "claude-code" },
    );

    expect(additional.id).toBe("builder-session-2");
    expect(additional.executionPolicy).toBe("planning-readonly");
    expect(additional.builderPlanning?.primary).toBe(false);
    expect(fixture.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ agentMapCapability: false }),
    );
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]?.sessionId,
    ).toBe("builder-session");
  });

  it("resumes an exited secondary by exact context without transferring primary authority", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const primary = fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!;
    const additional = await service.openAdditionalSession(
      PROJECT_ID,
      primary.id,
      { harness: "claude-code" },
    );
    additional.status = "exited";

    const resumed = await service.resume(PROJECT_ID, additional.id);

    expect(resumed.id).toBe("builder-session-2");
    expect(fixture.resume).toHaveBeenCalledWith(
      "builder-session-2",
      expect.objectContaining({
        builderPlanning: expect.objectContaining({ primary: false }),
        promptAppendix: expect.stringContaining("builder-assignment-data"),
      }),
    );
    expect(additional.builderPlanning?.primary).toBe(false);
    expect(primary.builderPlanning?.primary).toBe(true);
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]?.sessionId,
    ).toBe(primary.id);
  });

  it("rejects a secondary resume whose trusted context differs from the primary binding", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const additional = await service.openAdditionalSession(
      PROJECT_ID,
      "builder-session",
    );
    additional.status = "exited";
    additional.builderPlanning = {
      ...additional.builderPlanning!,
      bootstrapDigest: `sha256:${"f".repeat(64)}` as never,
    };

    await expect(
      service.resume(PROJECT_ID, additional.id),
    ).rejects.toMatchObject({ code: "binding_stale" });
    expect(fixture.resume).not.toHaveBeenCalled();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]?.sessionId,
    ).toBe("builder-session");
  });

  it("does not mutate primary authority when a secondary resume fails", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    const [opened] = await service.openOrReuse(
      fixture.identity,
      fixture.request,
    );
    const additional = await service.openAdditionalSession(
      PROJECT_ID,
      "builder-session",
    );
    additional.status = "exited";
    fixture.resume.mockRejectedValueOnce(new Error("secondary unavailable"));

    await expect(service.resume(PROJECT_ID, additional.id)).rejects.toThrow(
      "secondary unavailable",
    );
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      sessionId: "builder-session",
      state: opened?.state,
      failureCode: null,
    });
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
    const aggregate = fixture.aggregate();
    aggregate.buildPlanning = {
      ...aggregate.buildPlanning,
      planningSubmissionReceipts: Array.from({ length: 1_024 }, (_, index) => ({
        sessionId: `old-session-${index}`,
        requestId: `old-request-${index}`,
        requestDigest: `sha256:${"a".repeat(64)}` as never,
        submissionId:
          `submission_00000000-0000-7000-8000-${String(index).padStart(12, "0")}` as never,
      })),
    };
    await service.submitResult(builder, {
      ...request,
      requestId: "submit-after-receipt-window",
    });
    expect(
      fixture.aggregate().buildPlanning.planningSubmissionReceipts,
    ).toHaveLength(256);
    expect(await service.submitResult(builder, request)).toEqual(first);
    const afterWindow = fixture.aggregate();
    afterWindow.buildPlanning = {
      ...afterWindow.buildPlanning,
      currentBriefByAgentId: {},
    };
    expect(await service.submitResult(builder, request)).toEqual(first);
    await expect(
      service.submitResult(builder, {
        ...request,
        implementationPlan: [
          { ...request.implementationPlan[0]!, description: "Changed payload" },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(
      service.submitResult(builder, { ...request, requestId: "submit-stale" }),
    ).rejects.toMatchObject({ code: "binding_stale" });
  });

  it.each(["ready", "blocked"] as const)(
    "accepts %s when the builder has not authored a proposal successor",
    async (status) => {
      const fixture = publicFixture(true);
      const service = fixture.service();
      await service.openOrReuse(fixture.identity, fixture.request);
      const { session, builder } = markBuilderPlanning(fixture);
      const metadata = session.builderPlanning!;

      await expect(
        service.submitResult(builder, {
          schemaVersion: 1,
          expected: {
            assignmentId: metadata.assignmentId,
            source: metadata.source,
            plan: metadata.plan,
            brief: metadata.brief,
            bootstrapDigest: metadata.bootstrapDigest,
          },
          requestId: `submit-${status}`,
          status,
          implementationPlan: [
            {
              stepId: "step-one",
              ordinal: 1,
              description: "Implement the assignment",
              verification: "Run the focused suite",
            },
          ],
          risks: [],
          questions: [],
          proposedMapOperationIds: [],
        }),
      ).resolves.toMatchObject({ status });
    },
  );

  it("accepts only the exact operation ids authored by this builder in the current direct successor", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const { session, builder } = markBuilderPlanning(fixture);
    const proposal = new AgentMapProposalService(
      fixture.workspaceStore as never,
      {
        authorizeIdentity: (identity, aggregate) =>
          service.assertProposalIdentityAuthorized(identity, aggregate),
        authorizeMutation: (identity, aggregate) =>
          service.assertProposalMutationAuthorized(identity, aggregate),
      },
    );
    const proposalRequest = {
      schemaVersion: 1,
      proposalId:
        fixture.request.source.kind === "proposal"
          ? fixture.request.source.proposalId
          : null,
      expectedVersion: 1,
      requestId: "builder-proposal",
      operations: [
        {
          kind: "update-node",
          nodeId: AGENT_ID,
          changes: { purpose: "Clarify the implementation boundary" },
        },
      ],
    };
    const accepted = await proposal.propose(builder, proposalRequest);
    expect(await proposal.propose(builder, proposalRequest)).toEqual(accepted);
    await expect(
      proposal.propose(builder, {
        ...proposalRequest,
        operations: [
          {
            kind: "update-node",
            nodeId: AGENT_ID,
            changes: { purpose: "A conflicting retry" },
          },
        ],
      }),
    ).rejects.toMatchObject({ conflict: { code: "request_id_reused" } });
    const metadata = session.builderPlanning!;
    const resultRequest = {
      schemaVersion: 1,
      expected: {
        assignmentId: metadata.assignmentId,
        source: metadata.source,
        plan: metadata.plan,
        brief: metadata.brief,
        bootstrapDigest: metadata.bootstrapDigest,
      },
      requestId: "submit-builder-proposal",
      status: "changes-proposed",
      implementationPlan: [
        {
          stepId: "step-one",
          ordinal: 1,
          description: "Implement after the map revision is accepted",
          verification: "Run the focused suite",
        },
      ],
      risks: [],
      questions: [],
      proposedMapOperationIds: accepted.operationIds,
    };
    for (const status of ["ready", "blocked"] as const) {
      await expect(
        service.submitResult(builder, {
          ...resultRequest,
          requestId: `submit-after-proposal-${status}`,
          status,
          proposedMapOperationIds: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_proposal_operations" });
    }

    // An unrelated later descendant does not erase the exact provenance of
    // this builder's compatible direct successor.
    const currentProposal = fixture.aggregate().proposal!;
    const unrelatedNode = {
      ...structuredClone(graph.nodes[0]!),
      id: "node_00000000-0000-7000-8000-000000000099" as never,
      name: "Unrelated notes",
      ownerAgentId: null,
    };
    currentProposal.version = 3;
    currentProposal.nodes.push(unrelatedNode);
    currentProposal.history.push({
      id: "operation_00000000-0000-7000-8000-000000000098" as never,
      requestId: "unrelated-later-proposal",
      acceptedVersion: 3,
      operation: { kind: "add-node", node: unrelatedNode },
      actor: {
        userId: "user-test",
        sessionId: "planner-session",
        role: "map-planner",
        assignment: null,
      },
      acceptedAt: "2026-09-03T11:00:03.000Z",
    });

    const submission = await service.submitResult(builder, resultRequest);
    expect(submission.proposedMapOperationIds).toEqual(accepted.operationIds);

    const conflictingProposal = fixture.aggregate().proposal!;
    conflictingProposal.version = 4;
    conflictingProposal.history.push({
      id: "operation_00000000-0000-7000-8000-000000000097" as never,
      requestId: "conflicting-later-proposal",
      acceptedVersion: 4,
      operation: {
        kind: "update-node",
        nodeId: AGENT_ID,
        changes: { purpose: "Supersede the builder proposal" },
      },
      actor: {
        userId: "user-test",
        sessionId: "planner-session",
        role: "map-planner",
        assignment: null,
      },
      acceptedAt: "2026-09-03T11:00:04.000Z",
    });
    await expect(
      service.submitResult(builder, {
        ...resultRequest,
        requestId: "submit-conflicting-descendant",
      }),
    ).rejects.toMatchObject({ code: "binding_stale" });

    const foreign = publicFixture(true);
    const foreignService = foreign.service();
    await foreignService.openOrReuse(foreign.identity, foreign.request);
    const foreignPlanning = markBuilderPlanning(foreign);
    const aggregate = foreign.aggregate();
    aggregate.proposal!.version = 2;
    aggregate.proposal!.history.push({
      id: "operation_00000000-0000-7000-9000-000000000099" as never,
      requestId: "foreign-proposal",
      acceptedVersion: 2,
      operation: {
        kind: "update-node",
        nodeId: AGENT_ID,
        changes: { purpose: "Foreign change" },
      },
      actor: {
        userId: "user-test",
        sessionId: "foreign-session",
        role: "agent-builder",
        assignment: { kind: "planned", agentId: AGENT_ID },
      },
      acceptedAt: "2026-09-03T11:00:02.000Z",
    });
    const foreignMetadata = foreignPlanning.session.builderPlanning!;
    await expect(
      foreignService.submitResult(foreignPlanning.builder, {
        schemaVersion: 1,
        expected: {
          assignmentId: foreignMetadata.assignmentId,
          source: foreignMetadata.source,
          plan: foreignMetadata.plan,
          brief: foreignMetadata.brief,
          bootstrapDigest: foreignMetadata.bootstrapDigest,
        },
        requestId: "submit-foreign-proposal",
        status: "changes-proposed",
        implementationPlan: [
          {
            stepId: "step-one",
            ordinal: 1,
            description: "Do not accept foreign provenance",
            verification: "Reject",
          },
        ],
        risks: [],
        questions: [],
        proposedMapOperationIds: [aggregate.proposal!.history.at(-1)!.id],
      }),
    ).rejects.toMatchObject({ code: "binding_stale" });

    aggregate.workspace.activeProposalId =
      "proposal_00000000-0000-7000-9000-000000000100" as never;
    aggregate.proposal!.id = aggregate.workspace.activeProposalId;
    await expect(
      foreignService.submitResult(foreignPlanning.builder, {
        schemaVersion: 1,
        expected: {
          assignmentId: foreignMetadata.assignmentId,
          source: foreignMetadata.source,
          plan: foreignMetadata.plan,
          brief: foreignMetadata.brief,
          bootstrapDigest: foreignMetadata.bootstrapDigest,
        },
        requestId: "submit-replaced-proposal",
        status: "ready",
        implementationPlan: [
          {
            stepId: "step-one",
            ordinal: 1,
            description: "Do not accept replacement source",
            verification: "Reject",
          },
        ],
        risks: [],
        questions: [],
        proposedMapOperationIds: [],
      }),
    ).rejects.toMatchObject({ code: "binding_stale" });
  });

  it("denies proposal mutation from a stale planned-builder session", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const { binding, builder } = markBuilderPlanning(fixture);
    binding.state = "stale";
    fixture.sessions.find(
      (candidate) => candidate.id === "builder-session",
    )!.builderPlanning!.state = "stale";
    const proposal = new AgentMapProposalService(
      fixture.workspaceStore as never,
      {
        authorizeIdentity: (identity, aggregate) =>
          service.assertProposalIdentityAuthorized(identity, aggregate),
        authorizeMutation: (identity, aggregate) =>
          service.assertProposalMutationAuthorized(identity, aggregate),
      },
    );
    await expect(
      proposal.propose(builder, {
        schemaVersion: 1,
        proposalId:
          fixture.request.source.kind === "proposal"
            ? fixture.request.source.proposalId
            : null,
        expectedVersion: 1,
        requestId: "stale-builder-proposal",
        operations: [
          {
            kind: "update-node",
            nodeId: AGENT_ID,
            changes: { purpose: "Must be denied" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "binding_stale" });
    expect(fixture.aggregate().proposal?.version).toBe(1);
  });

  it("proactively stales only the assignment touched by a proposal change", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const { binding } = markBuilderPlanning(fixture);
    const aggregate = fixture.aggregate();
    const otherAgentId =
      "node_00000000-0000-7000-8000-000000000002" as typeof AGENT_ID;
    const otherAssignmentId =
      "assignment_00000000-0000-7000-8000-000000000002" as typeof ASSIGNMENT_ID;
    const otherBriefId =
      "brief_00000000-0000-7000-8000-000000000002" as typeof BRIEF_ID;
    const sourceBrief =
      aggregate.buildPlanning.briefVersionsById[BRIEF_ID]![0]!;
    const otherBrief = {
      ...structuredClone(sourceBrief),
      briefId: otherBriefId,
      assignmentId: otherAssignmentId,
      plannedAgentId: otherAgentId,
      ownedNodeIds: [otherAgentId],
      relevantNodeIds: [],
      semanticDigest: `sha256:${"8".repeat(64)}` as never,
      recordDigest: `sha256:${"9".repeat(64)}` as never,
    };
    const otherBriefRef = {
      briefId: otherBriefId,
      version: otherBrief.version,
      semanticDigest: otherBrief.semanticDigest,
    };
    const otherBinding: BuilderPlanningSessionBinding = {
      ...structuredClone(binding),
      bindingId:
        "builder-binding_00000000-0000-7000-8000-000000000002" as never,
      assignmentId: otherAssignmentId,
      plannedAgentId: otherAgentId,
      brief: otherBriefRef,
      sessionId: "builder-session-marketing",
    };
    aggregate.buildPlanning = {
      ...aggregate.buildPlanning,
      currentBriefByAgentId: {
        ...aggregate.buildPlanning.currentBriefByAgentId,
        [otherAgentId]: otherBriefRef,
      },
      briefVersionsById: {
        ...aggregate.buildPlanning.briefVersionsById,
        [otherBriefId]: [otherBrief],
      },
      assignmentByAgentId: {
        ...aggregate.buildPlanning.assignmentByAgentId,
        [otherAgentId]: {
          ...aggregate.buildPlanning.assignmentByAgentId[AGENT_ID]!,
          assignmentId: otherAssignmentId,
          briefId: otherBriefId,
          plannedAgentId: otherAgentId,
        },
      },
      builderBindingsByAssignmentId: {
        ...aggregate.buildPlanning.builderBindingsByAssignmentId,
        [otherAssignmentId]: otherBinding,
      },
    };
    fixture.sessions.push({
      ...fixture.sessions.find((session) => session.id === "builder-session")!,
      id: "builder-session-marketing",
      agentMapIdentity: {
        projectId: PROJECT_ID,
        sessionId: "builder-session-marketing",
        userId: "user-test",
        role: "agent-builder",
        assignment: { kind: "planned", agentId: otherAgentId },
      },
      builderPlanning: {
        ...fixture.sessions.find((session) => session.id === "builder-session")!
          .builderPlanning!,
        bindingId: otherBinding.bindingId,
        assignmentId: otherAssignmentId,
        plannedAgentId: otherAgentId,
        brief: otherBriefRef,
      },
    });
    aggregate.proposal!.version = 2;
    aggregate.proposal!.history.push({
      id: "operation_00000000-0000-7000-8000-000000000500" as never,
      requestId: "targeted-planner-edit",
      acceptedVersion: 2,
      operation: {
        kind: "update-node",
        nodeId: AGENT_ID,
        changes: { purpose: "Only research changed" },
      },
      actor: {
        userId: "user-test",
        sessionId: "planner-session",
        role: "map-planner",
        assignment: null,
      },
      acceptedAt: "2026-09-03T11:00:02.000Z",
    });

    await service.reconcileProject(PROJECT_ID);

    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]?.state,
    ).toBe("stale");
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        otherAssignmentId
      ]?.state,
    ).toBe("planning");
    expect(
      fixture.sessions.find((session) => session.id === "builder-session")
        ?.builderPlanning?.state,
    ).toBe("stale");
    expect(
      fixture.sessions.find(
        (session) => session.id === "builder-session-marketing",
      )?.builderPlanning?.state,
    ).toBe("planning");
  });
});

describe("BuilderPlanningSessionService kickoff delivery claim", () => {
  type Delivery = (binding: BuilderPlanningSessionBinding) => Promise<void>;

  it("does not fabricate kickoff state when create/attach has not persisted one", () => {
    const binding = {
      ...publicFixture(true).aggregate().buildPlanning
        .builderBindingsByAssignmentId[ASSIGNMENT_ID],
      kickoff: null,
    } as BuilderPlanningSessionBinding;
    expect(
      reconcileKickoffAttempt(binding, {
        accepted: true,
        ambiguous: false,
        updatedAt: "2026-09-03T11:00:02.000Z",
      }),
    ).toBe(binding);
  });

  it("has one durable sender across concurrent service instances", async () => {
    const fixture = publicFixture(true);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    const binding =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!.ready = true;
    let release!: (accepted: boolean) => void;
    const submitted = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    fixture.manager.submitInput.mockImplementation(async () => submitted);
    const first = fixture.service() as unknown as { deliverKickoff: Delivery };
    const second = fixture.service() as unknown as { deliverKickoff: Delivery };
    const firstDelivery = first.deliverKickoff(binding);
    await vi.waitFor(() =>
      expect(fixture.manager.submitInput).toHaveBeenCalledTimes(1),
    );
    const secondDelivery = second.deliverKickoff(binding);
    await secondDelivery;
    expect(fixture.manager.submitInput).toHaveBeenCalledTimes(1);
    release(false);
    await firstDelivery;
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]?.kickoff,
    ).toMatchObject({ state: "pending", deliveryClaimId: null });
  });

  it("retries definitive pre-write failures but surfaces ambiguous exceptions", async () => {
    const fixture = publicFixture(true);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    const service = fixture.service() as unknown as {
      deliverKickoff: Delivery;
    };
    const current = () =>
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    fixture.manager.submitInput.mockRejectedValueOnce(
      new SessionNotReadyError("builder-session"),
    );
    await service.deliverKickoff(current());
    expect(current().kickoff).toMatchObject({
      state: "pending",
      deliveryClaimId: null,
    });

    fixture.manager.submitInput.mockRejectedValueOnce(
      new Error("adapter failed after an unknown write outcome"),
    );
    await service.deliverKickoff(current());
    expect(current()).toMatchObject({
      state: "delivery-uncertain",
      kickoff: { state: "delivery-uncertain", deliveryClaimId: null },
    });
  });

  it("does not let a delayed acknowledgement revive a replacement context", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const binding =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    binding.state = "kickoff-pending";
    binding.kickoff = {
      ...binding.kickoff!,
      state: "delivering",
      attemptCount: 1,
      deliveryClaimId: "delivery-claim_old",
      deliveryClaimedAt: "2026-09-03T11:00:00.000Z",
    };
    const oldInputId = binding.kickoff.inputId;
    fixture.beforeNextTransaction(() => {
      const replacement =
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ]!;
      replacement.bootstrapDigest = `sha256:${"e".repeat(64)}` as never;
      replacement.sessionId = null;
      replacement.state = "pending";
      replacement.kickoff = null;
    });
    const event: AnalyticsEvent = {
      eventId: "event-old-kickoff",
      seq: 1,
      ts: "2026-09-03T11:00:02.000Z",
      userId: "user-test",
      tenantId: null,
      machineId: "machine-test",
      harnessSessionId: "builder-session",
      agentSessionId: "builder-agent",
      harness: "codex",
      type: "prompt.submitted",
      payload: { builderKickoffInputId: oldInputId },
    };

    await expect(service.onEventPersisted(event)).rejects.toMatchObject({
      code: "binding_stale",
    });
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      bootstrapDigest: `sha256:${"e".repeat(64)}`,
      sessionId: null,
      state: "pending",
      kickoff: null,
    });
  });
});
