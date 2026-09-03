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
import {
  computeArchitectureGraphDigest,
  computeCanonicalDigest,
} from "./build-plan-canonicalization.js";
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
      lifecycleEpoch: 0,
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
        latestAcceptedPlannerUserInputId: async () => null,
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

  it("normalizes planning text before length and safety validation", () => {
    const parsed = planningResultSubmitRequestSchema.safeParse({
      ...base,
      implementationPlan: [
        {
          ...base.implementationPlan[0],
          description: `  ${"x".repeat(2_000)}  `,
          verification: "  verify  ",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.implementationPlan[0]).toMatchObject({
        description: "x".repeat(2_000),
        verification: "verify",
      });
    expect(
      planningResultSubmitRequestSchema.safeParse({
        ...base,
        implementationPlan: [
          {
            ...base.implementationPlan[0],
            description: ` ${"x".repeat(2_001)} `,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each(["\u0001", "\u007f", "\ud800"])(
    "rejects unsafe planning text %j in every persisted text field",
    (unsafe) => {
      const requests = [
        {
          ...base,
          implementationPlan: [
            { ...base.implementationPlan[0], description: unsafe },
          ],
        },
        {
          ...base,
          implementationPlan: [
            { ...base.implementationPlan[0], verification: unsafe },
          ],
        },
        {
          ...base,
          risks: [{ ...base.risks[0], description: unsafe }],
        },
        {
          ...base,
          risks: [{ ...base.risks[0], mitigation: unsafe }],
        },
        {
          ...base,
          questions: [{ ...base.questions[0], question: unsafe }],
        },
      ];
      expect(
        requests.map(
          (request) =>
            planningResultSubmitRequestSchema.safeParse(request).success,
        ),
      ).toEqual([false, false, false, false, false]);
    },
  );
});

function publicFixture(
  includeConsent: boolean,
  agentCount = 1,
  nestedAgentIndex: number | null = null,
) {
  const basePlan = makePlan();
  const specs = Array.from({ length: agentCount }, (_, index) => ({
    agentId:
      index === 0
        ? AGENT_ID
        : (`node_00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}` as typeof AGENT_ID),
    assignmentId:
      index === 0
        ? ASSIGNMENT_ID
        : (`assignment_00000000-0000-7000-8000-${String(index + 101).padStart(12, "0")}` as typeof ASSIGNMENT_ID),
    briefId:
      index === 0
        ? BRIEF_ID
        : (`brief_00000000-0000-7000-8000-${String(index + 201).padStart(12, "0")}` as typeof BRIEF_ID),
  }));
  const projectGraph = {
    nodes: specs.map((spec, index) => ({
      ...graph.nodes[0]!,
      id: spec.agentId,
      name: index === 0 ? "Builder" : `Builder ${index + 1}`,
      ownerAgentId:
        index === nestedAgentIndex ? (specs[0]?.agentId ?? null) : null,
    })),
    relationships: [],
  };
  const source = {
    ...proposalSource(),
    graphDigest: computeArchitectureGraphDigest(projectGraph),
  };
  const plan = makePlan({
    source,
    assignments: specs.map((spec, index) => ({
      ...basePlan.assignments[0]!,
      plannedAgentId: spec.agentId,
      mission: `Implement assignment ${index + 1}`,
    })),
  });
  const briefs = specs.map((spec, index) =>
    makeBrief(plan, {
      briefId: spec.briefId,
      plannedAgentId: spec.agentId,
      assignmentId: spec.assignmentId,
      mission: `Implement assignment ${index + 1}`,
      ownedNodeIds: [spec.agentId],
      relevantNodeIds: [spec.agentId],
    }),
  );
  const brief = briefs[0]!;
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
  const preparationUserInputId = "planner-input-preparation";
  let acceptedPlannerUserInputId = includeConsent
    ? "planner-input-confirmation-1"
    : preparationUserInputId;
  let confirmationTurn = 1;
  const consentBriefs = [...specs]
    .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId))
    .map((spec) => {
      const candidate = briefs.find(
        (briefVersion) => briefVersion.assignmentId === spec.assignmentId,
      )!;
      return {
        briefId: candidate.briefId,
        version: candidate.version,
        semanticDigest: candidate.semanticDigest,
      };
    });
  const consentCore = {
    consentId: "fanout-consent_00000000-0000-7000-8000-000000000020",
    projectId: PROJECT_ID,
    source: plan.source,
    plan: planRef,
    assignmentIds: specs
      .map((spec) => spec.assignmentId)
      .sort((left, right) => left.localeCompare(right)),
    briefs: consentBriefs,
    plannerSessionId: identity.sessionId,
    userId: identity.userId,
    preparedFromUserInputId: preparationUserInputId,
    status: "pending" as const,
    preparedAt: "2026-09-03T11:00:00.000Z",
    confirmedAt: null,
    confirmedByUserInputId: null,
    confirmationSource: null,
  };
  const consent = {
    ...consentCore,
    consentDigest: computeCanonicalDigest(
      "sapiom.planning-fanout-consent.v1",
      consentCore,
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
      nodes: projectGraph.nodes,
      relationships: projectGraph.relationships,
      history: [
        ...projectGraph.nodes.map((node, index) => ({
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
        ...projectGraph.relationships.map((relationship, index) => ({
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
      currentBriefByAgentId: Object.fromEntries(
        briefs.map((candidate) => [
          candidate.plannedAgentId,
          {
            briefId: candidate.briefId,
            version: candidate.version,
            semanticDigest: candidate.semanticDigest,
          },
        ]),
      ),
      briefVersionsById: Object.fromEntries(
        briefs.map((candidate) => [candidate.briefId, [candidate]]),
      ),
      assignmentByAgentId: Object.fromEntries(
        specs.map((spec) => [
          spec.agentId,
          {
            schemaVersion: 1,
            projectId: PROJECT_ID,
            assignmentId: spec.assignmentId,
            briefId: spec.briefId,
            plannedAgentId: spec.agentId,
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
        ]),
      ),
      fanoutApprovals: [],
      fanoutConsents: includeConsent ? [consent] : [],
    },
  } as unknown as AgentMapProjectAggregate;
  let transaction = Promise.resolve();
  let beforeNextTransaction: (() => void | Promise<void>) | null = null;
  let afterNextTransactionCommit: (() => void | Promise<void>) | null = null;
  let afterNextReadAggregate: (() => void | Promise<void>) | null = null;
  let beforeNextList: (() => void) | null = null;
  const workspaceStore = {
    readAggregate: vi.fn(async () => {
      const snapshot = structuredClone(aggregate);
      const after = afterNextReadAggregate;
      afterNextReadAggregate = null;
      await after?.();
      return snapshot;
    }),
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
      return run.then(async () => {
        const after = afterNextTransactionCommit;
        afterNextTransactionCommit = null;
        await after?.();
        return value;
      });
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
  let createdSessionSequence = 0;
  const create = vi.fn(async (_request, trusted) => {
    const builderNumber = ++createdSessionSequence;
    const id =
      builderNumber === 1
        ? "builder-session"
        : `builder-session-${builderNumber}`;
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
    list: () => {
      const before = beforeNextList;
      beforeNextList = null;
      before?.();
      return sessions;
    },
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
      async (
        id: string,
        expected: NonNullable<HarnessSession["builderPlanning"]>,
        metadata: NonNullable<HarnessSession["builderPlanning"]>,
      ) => {
        const session = sessions.find((candidate) => candidate.id === id);
        if (!session?.builderPlanning) return false;
        const context = (
          value: NonNullable<HarnessSession["builderPlanning"]>,
        ) =>
          JSON.stringify([
            value.bindingId,
            value.purpose,
            value.assignmentId,
            value.plannedAgentId,
            value.source,
            value.plan,
            value.brief,
            value.bootstrapDigest,
            value.primary !== false,
          ]);
        if (
          JSON.stringify(session.builderPlanning) !==
            JSON.stringify(expected) ||
          context(expected) !== context(metadata) ||
          metadata.lifecycleEpoch < expected.lifecycleEpoch ||
          (metadata.lifecycleEpoch === expected.lifecycleEpoch &&
            metadata.state !== expected.state)
        )
          return false;
        session.builderPlanning = structuredClone(metadata);
        return true;
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
      latestAcceptedPlannerUserInputId: async () => acceptedPlannerUserInputId,
      resolveProjectRoot: async () => "/tmp/project",
      defaultHarness: "codex",
      now: () => "2026-09-03T11:00:00.000Z",
    });
  return {
    service,
    identity,
    request: {
      consentId: consent.consentId,
      confirmation: "user-confirmed" as const,
      source: plan.source,
      plan: planRef,
      assignmentIds: consentCore.assignmentIds,
    },
    create,
    resume,
    aggregate: () => aggregate,
    sessions,
    briefRef,
    specs,
    workspaceStore,
    manager,
    acceptPlannerReply: () => {
      confirmationTurn += 1;
      acceptedPlannerUserInputId = `planner-input-confirmation-${confirmationTurn}`;
      return acceptedPlannerUserInputId;
    },
    beforeNextTransaction: (action: () => void | Promise<void>) => {
      beforeNextTransaction = action;
    },
    afterNextTransactionCommit: (action: () => void | Promise<void>) => {
      afterNextTransactionCommit = action;
    },
    afterNextReadAggregate: (action: () => void | Promise<void>) => {
      afterNextReadAggregate = action;
    },
    beforeNextList: (action: () => void) => {
      beforeNextList = action;
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
  binding.lifecycleEpoch += 1;
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
    lifecycleEpoch: binding.lifecycleEpoch,
    state: "planning",
    primary: true,
  };
  return { session, binding, builder: session.agentMapIdentity! };
}

function planningResultRequest(
  session: HarnessSession,
  requestId: string,
  description = "Implement the assignment",
) {
  const metadata = session.builderPlanning!;
  return {
    schemaVersion: 1 as const,
    expected: {
      assignmentId: metadata.assignmentId,
      source: metadata.source,
      plan: metadata.plan,
      brief: metadata.brief,
      bootstrapDigest: metadata.bootstrapDigest,
    },
    requestId,
    status: "ready" as const,
    implementationPlan: [
      {
        stepId: "step-one",
        ordinal: 1,
        description,
        verification: "Run the focused suite",
      },
    ],
    risks: [],
    questions: [],
    proposedMapOperationIds: [],
  };
}

describe("BuilderPlanningSessionService public authorization", () => {
  it("rejects a missing prepared consent before any process side effect", async () => {
    const fixture = publicFixture(false);
    await expect(
      fixture.service().openOrReuse(fixture.identity, fixture.request),
    ).rejects.toMatchObject({ code: "missing_consent" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("prepares one exact, idempotent consent scope for every top-level planned agent", async () => {
    const fixture = publicFixture(false, 3);
    const request = {
      source: fixture.request.source,
      plan: fixture.request.plan,
      assignmentIds: fixture.request.assignmentIds,
    };

    const first = await fixture
      .service()
      .prepareConsent(fixture.identity, request);
    const replay = await fixture
      .service()
      .prepareConsent(fixture.identity, request);

    expect(replay).toEqual(first);
    expect(first.consentId).toMatch(/^fanout-consent_/u);
    expect(first.sessions).toEqual(
      fixture.specs.map((spec, index) =>
        expect.objectContaining({
          assignmentId: spec.assignmentId,
          plannedAgentId: spec.agentId,
          agentName: index === 0 ? "Builder" : `Builder ${index + 1}`,
          mission: `Implement assignment ${index + 1}`,
          brief: expect.objectContaining({ briefId: spec.briefId, version: 1 }),
          executionPolicy: "planning-readonly",
        }),
      ),
    );
    expect(first.expectedSessionCount).toBe(3);
    expect(first.expectedKickoffPromptCount).toBe(3);
    expect(fixture.aggregate().buildPlanning.fanoutConsents).toHaveLength(1);
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("fails closed instead of opening a session for a nested planned agent", async () => {
    const fixture = publicFixture(false, 2, 1);

    await expect(
      fixture.service().prepareConsent(fixture.identity, {
        source: fixture.request.source,
        plan: fixture.request.plan,
        assignmentIds: fixture.request.assignmentIds,
      }),
    ).rejects.toMatchObject({ code: "plan_not_ready" });
    expect(fixture.aggregate().buildPlanning.fanoutConsents).toEqual([]);
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("requires a subsequent server-accepted planner user turn before opening", async () => {
    const fixture = publicFixture(false);
    const preparation = await fixture
      .service()
      .prepareConsent(fixture.identity, {
        source: fixture.request.source,
        plan: fixture.request.plan,
        assignmentIds: fixture.request.assignmentIds,
      });
    const request = {
      ...fixture.request,
      consentId: preparation.consentId,
    };

    await expect(
      fixture.service().openOrReuse(fixture.identity, request),
    ).rejects.toMatchObject({ code: "user_reply_required" });
    expect(fixture.create).not.toHaveBeenCalled();

    fixture.acceptPlannerReply();
    await expect(
      fixture.service().openOrReuse(fixture.identity, request),
    ).resolves.toMatchObject({ consentId: preparation.consentId });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it("rejects consent when an exact brief version changes after preparation", async () => {
    const fixture = publicFixture(false);
    const preparation = await fixture
      .service()
      .prepareConsent(fixture.identity, {
        source: fixture.request.source,
        plan: fixture.request.plan,
        assignmentIds: fixture.request.assignmentIds,
      });
    const current =
      fixture.aggregate().buildPlanning.briefVersionsById[BRIEF_ID]![0]!;
    const changed = {
      ...structuredClone(current),
      version: 2 as typeof current.version,
      semanticDigest:
        `sha256:${"4".repeat(64)}` as typeof current.semanticDigest,
      recordDigest: `sha256:${"5".repeat(64)}` as typeof current.recordDigest,
    };
    (
      fixture.aggregate().buildPlanning.briefVersionsById[
        BRIEF_ID
      ] as (typeof current)[]
    ).push(changed);
    (
      fixture.aggregate().buildPlanning.currentBriefByAgentId as Record<
        string,
        typeof fixture.briefRef
      >
    )[AGENT_ID] = {
      briefId: changed.briefId,
      version: changed.version,
      semanticDigest: changed.semanticDigest,
    };
    fixture.acceptPlannerReply();

    await expect(
      fixture.service().openOrReuse(fixture.identity, {
        ...fixture.request,
        consentId: preparation.consentId,
      }),
    ).rejects.toMatchObject({ code: "stale_consent" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("atomically records planner-attested consent when opening", async () => {
    const fixture = publicFixture(true);
    const outcome = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);

    expect(outcome.consentId).toBe(fixture.request.consentId);
    expect(fixture.aggregate().buildPlanning.fanoutConsents[0]).toMatchObject({
      consentId: fixture.request.consentId,
      status: "confirmed",
      confirmationSource: "planner-attested-conversation",
      preparedFromUserInputId: "planner-input-preparation",
      confirmedByUserInputId: "planner-input-confirmation-1",
      confirmedAt: "2026-09-03T11:00:00.000Z",
    });
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
    ).rejects.toMatchObject({ code: "stale_plan" });
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
    expect(replay.bindings).toHaveLength(1);
    expect(replay.bindings[0]?.sessionId).toBe("builder-session");
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it("leaves an unplanned manual session untouched across fan-out retries", async () => {
    const fixture = publicFixture(true);
    const manualSession: HarnessSession = {
      id: "manual-session",
      agentSessionId: "manual-agent",
      harness: "codex",
      cwd: "/tmp/project",
      title: "Manual work",
      status: "running",
      ready: true,
      createdAt: "2026-09-03T10:30:00.000Z",
      lastActiveAt: "2026-09-03T10:30:00.000Z",
      boundWorkflowPath: null,
      agentMapIdentity: {
        projectId: PROJECT_ID,
        sessionId: "manual-session",
        userId: fixture.identity.userId,
        role: "agent-builder",
        assignment: { kind: "unplanned" },
      },
    };
    fixture.sessions.push(manualSession);
    const before = structuredClone(manualSession);

    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);

    expect(
      fixture.sessions.find((session) => session.id === manualSession.id),
    ).toEqual(before);
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it("lets only the spawn claimant attach a just-created matching process", async () => {
    const fixture = publicFixture(true);
    const create = fixture.create.getMockImplementation()!;
    let announceCreated!: () => void;
    const created = new Promise<void>((resolve) => {
      announceCreated = resolve;
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    fixture.create.mockImplementationOnce(async (...args) => {
      const session = await create(...args);
      announceCreated();
      await createGate;
      return session;
    });

    const winnerOpen = fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    await created;
    const loser = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    expect(loser.bindings[0]).toMatchObject({
      state: "spawning",
      sessionId: null,
    });

    releaseCreate();
    const winner = await winnerOpen;
    expect(winner.bindings[0]?.sessionId).toBe("builder-session");
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.manager.kill).not.toHaveBeenCalled();
    expect(
      fixture.sessions.filter(
        (session) =>
          session.id !== "planner-session" && session.status === "running",
      ),
    ).toHaveLength(1);
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({ sessionId: "builder-session", state: "kickoff-pending" });
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

    const foreignOutcome = await fixture
      .service(undefined, foreignManager as never)
      .openOrReuse(fixture.identity, fixture.request);
    expect(foreignOutcome.unreachableAssignmentIds).toEqual([ASSIGNMENT_ID]);

    expect(foreignCreate).not.toHaveBeenCalled();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      bindingId: first.bindings[0]?.bindingId,
      sessionId: "builder-session",
      state: first.bindings[0]?.state,
    });
  });

  it.each([0, 1])(
    "isolates a locally unreachable assignment at ordered position %i and opens later assignments",
    async (foreignIndex) => {
      const fixture = publicFixture(true, 3);
      const initial = await fixture
        .service()
        .openOrReuse(fixture.identity, fixture.request);
      const foreignSpec = fixture.specs[foreignIndex]!;
      const aggregate = fixture.aggregate();
      const foreignBinding = structuredClone(
        aggregate.buildPlanning.builderBindingsByAssignmentId[
          foreignSpec.assignmentId
        ]!,
      );
      aggregate.buildPlanning.builderBindingsByAssignmentId = {
        [foreignSpec.assignmentId]: foreignBinding,
      };
      const foreignSessionId = foreignBinding.sessionId!;
      fixture.sessions.splice(
        0,
        fixture.sessions.length,
        ...fixture.sessions.filter(
          (session) =>
            session.id === fixture.identity.sessionId ||
            session.id === foreignSessionId,
        ),
      );
      fixture.create.mockClear();
      const localManager = {
        ...fixture.manager,
        get: (id: string) =>
          id === foreignSessionId ? undefined : fixture.manager.get(id),
        list: () =>
          fixture.manager
            .list()
            .filter((session) => session.id !== foreignSessionId),
      };

      const outcome = await fixture
        .service(undefined, localManager)
        .openOrReuse(fixture.identity, fixture.request);

      expect(outcome.bindings.map((binding) => binding.assignmentId)).toEqual(
        fixture.request.assignmentIds,
      );
      expect(outcome.unreachableAssignmentIds).toEqual([
        foreignSpec.assignmentId,
      ]);
      expect(fixture.create).toHaveBeenCalledTimes(2);
      expect(fixture.manager.kill).not.toHaveBeenCalled();
      expect(
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          foreignSpec.assignmentId
        ],
      ).toEqual(foreignBinding);

      const ownerRetry = await fixture
        .service()
        .openOrReuse(fixture.identity, fixture.request);
      expect(ownerRetry.unreachableAssignmentIds).toEqual([]);
      expect(ownerRetry.bindings).toHaveLength(initial.bindings.length);
      expect(fixture.create).toHaveBeenCalledTimes(2);
    },
  );

  it("reports every foreign binding unreachable without mutation or side effects", async () => {
    const fixture = publicFixture(true, 3);
    const initial = await fixture
      .service()
      .openOrReuse(fixture.identity, fixture.request);
    const before = structuredClone(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId,
    );
    fixture.create.mockClear();
    const planner = fixture.sessions.find(
      (session) => session.id === fixture.identity.sessionId,
    )!;
    const foreignManager = {
      ...fixture.manager,
      get: (id: string) => (id === planner.id ? planner : undefined),
      list: () => [planner],
    };

    const outcome = await fixture
      .service(undefined, foreignManager)
      .openOrReuse(fixture.identity, fixture.request);

    expect(outcome.bindings).toHaveLength(3);
    expect(outcome.unreachableAssignmentIds).toEqual(
      initial.bindings.map((binding) => binding.assignmentId),
    );
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.manager.kill).not.toHaveBeenCalled();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId,
    ).toEqual(before);
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
    expect(first.bindings[0]?.bindingId).toBe(second.bindings[0]?.bindingId);
    expect(first.bindings[0]?.sessionId).toBe("builder-session");
    expect(second.bindings[0]?.sessionId).toBe("builder-session");
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

    const {
      bindings: [binding],
    } = await fixture.service().openOrReuse(fixture.identity, fixture.request);

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
          bindingId: resumed.bindings[0]?.bindingId,
        }),
        promptAppendix: expect.stringContaining("builder-assignment-data"),
      }),
    );
    expect(resumed.bindings[0]?.sessionId).toBe("builder-session");
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
    const {
      bindings: [opened],
    } = await service.openOrReuse(fixture.identity, fixture.request);
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
    const {
      bindings: [opened],
    } = await service.openOrReuse(fixture.identity, fixture.request);
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

  it("rejects a first result before acknowledged kickoff without side effects", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const session = fixture.sessions.find(
      (candidate) => candidate.id === "builder-session",
    )!;
    const metadata = session.builderPlanning!;

    await expect(
      service.submitResult(session.agentMapIdentity!, {
        schemaVersion: 1,
        expected: {
          assignmentId: metadata.assignmentId,
          source: metadata.source,
          plan: metadata.plan,
          brief: metadata.brief,
          bootstrapDigest: metadata.bootstrapDigest,
        },
        requestId: "submit-before-kickoff",
        status: "ready",
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
    ).rejects.toMatchObject({ code: "binding_stale" });
    expect(fixture.aggregate().buildPlanning.submissionsByAssignmentId).toEqual(
      {},
    );
    expect(
      fixture.aggregate().buildPlanning.planningSubmissionReceipts,
    ).toEqual([]);
    expect(fixture.manager.submitInput).not.toHaveBeenCalled();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      state: "kickoff-pending",
      kickoff: { state: "pending" },
    });
  });

  it.each(["accepted", "ambiguous"] as const)(
    "uses an exact primary result as terminal proof after %s uncertain delivery",
    async (outcome) => {
      const fixture = publicFixture(true);
      const service = fixture.service();
      await service.openOrReuse(fixture.identity, fixture.request);
      const session = fixture.sessions.find(
        (candidate) => candidate.id === "builder-session",
      )!;
      session.ready = true;
      if (outcome === "accepted")
        fixture.manager.submitInput.mockResolvedValueOnce(true);
      else
        fixture.manager.submitInput.mockRejectedValueOnce(
          new Error("write outcome unknown"),
        );
      await service.onSessionStatus(session);
      await vi.waitFor(() =>
        expect(
          fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
            ASSIGNMENT_ID
          ],
        ).toMatchObject({
          state: "delivery-uncertain",
          kickoff: { state: "delivery-uncertain", attemptCount: 1 },
        }),
      );

      const restarted = fixture.service();
      await restarted.reconcile();
      const request = planningResultRequest(session, `uncertain-${outcome}`);
      const submission = await restarted.submitResult(
        session.agentMapIdentity!,
        request,
      );
      expect(
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ],
      ).toMatchObject({
        state: "submitted",
        kickoff: {
          state: "delivery-uncertain",
          deliveryClaimId: null,
          deliveryClaimedAt: null,
        },
      });
      expect(
        await restarted.submitResult(session.agentMapIdentity!, request),
      ).toEqual(submission);
      await expect(
        restarted.submitResult(session.agentMapIdentity!, {
          ...request,
          requestId: `${request.requestId}-new`,
        }),
      ).rejects.toMatchObject({ code: "binding_stale" });

      const prompt = "lost acknowledgement prompt";
      expect(
        restarted.decorateLocalEvent({
          eventId: "after-uncertain-submit-decorate",
          seq: 1,
          ts: "2026-09-03T11:00:02.000Z",
          userId: "user-test",
          tenantId: null,
          machineId: "machine-test",
          harnessSessionId: session.id,
          agentSessionId: session.agentSessionId,
          harness: "codex",
          type: "prompt.submitted",
          payload: { prompt },
        }).payload,
      ).toEqual({ prompt });
      const kickoff =
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ]!.kickoff!;
      await restarted.onEventPersisted({
        eventId: "after-uncertain-submit",
        seq: 2,
        ts: "2026-09-03T11:00:03.000Z",
        userId: "user-test",
        tenantId: null,
        machineId: "machine-test",
        harnessSessionId: session.id,
        agentSessionId: session.agentSessionId,
        harness: "codex",
        type: "prompt.submitted",
        payload: { builderKickoffInputId: kickoff.inputId },
      });
      expect(
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ],
      ).toMatchObject({
        state: "submitted",
        kickoff: { state: "delivery-uncertain" },
      });
    },
  );

  it("denies an uncertain result from a secondary session", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const primary = fixture.sessions.find(
      (candidate) => candidate.id === "builder-session",
    )!;
    const binding =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    binding.lifecycleEpoch += 1;
    binding.state = "delivery-uncertain";
    binding.kickoff = {
      ...binding.kickoff!,
      state: "delivery-uncertain",
      attemptCount: 1,
    };
    const secondary = await service.openAdditionalSession(
      PROJECT_ID,
      primary.id,
    );

    await expect(
      service.submitResult(
        secondary.agentMapIdentity!,
        planningResultRequest(secondary, "secondary-uncertain"),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fixture.aggregate().buildPlanning.submissionsByAssignmentId).toEqual(
      {},
    );
  });

  it.each(["ack-first", "submit-first"] as const)(
    "keeps uncertain kickoff/result ordering monotonic when %s wins",
    async (winner) => {
      const fixture = publicFixture(true);
      const service = fixture.service();
      await service.openOrReuse(fixture.identity, fixture.request);
      const session = fixture.sessions.find(
        (candidate) => candidate.id === "builder-session",
      )!;
      session.ready = true;
      fixture.manager.submitInput.mockResolvedValueOnce(true);
      await service.onSessionStatus(session);
      await vi.waitFor(() =>
        expect(
          fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
            ASSIGNMENT_ID
          ]?.state,
        ).toBe("delivery-uncertain"),
      );
      const kickoff =
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ]!.kickoff!;
      const event: AnalyticsEvent = {
        eventId: `uncertain-race-${winner}`,
        seq: 1,
        ts: "2026-09-03T11:00:02.000Z",
        userId: "user-test",
        tenantId: null,
        machineId: "machine-test",
        harnessSessionId: session.id,
        agentSessionId: session.agentSessionId,
        harness: "codex",
        type: "prompt.submitted",
        payload: { builderKickoffInputId: kickoff.inputId },
      };
      const request = planningResultRequest(session, `race-${winner}`);

      if (winner === "ack-first") {
        await service.onEventPersisted(event);
        await service.submitResult(session.agentMapIdentity!, request);
        expect(
          fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
            ASSIGNMENT_ID
          ],
        ).toMatchObject({
          state: "submitted",
          kickoff: { state: "delivered" },
        });
        return;
      }

      let observedRead!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        observedRead = resolve;
      });
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      fixture.afterNextReadAggregate(async () => {
        observedRead();
        await readGate;
      });
      const delayedAcknowledgement = service.onEventPersisted(event);
      await readStarted;
      await service.submitResult(session.agentMapIdentity!, request);
      releaseRead();
      await expect(delayedAcknowledgement).resolves.toBeUndefined();

      expect(
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ],
      ).toMatchObject({
        state: "submitted",
        kickoff: { state: "delivery-uncertain" },
      });
      const prompt = (
        fixture.manager.submitInput.mock.calls as unknown as Array<
          [string, string]
        >
      )[0]![1];
      expect(
        service.decorateLocalEvent({
          ...event,
          eventId: "after-submit-attribution",
          payload: { prompt },
        }).payload,
      ).toEqual({ prompt });
    },
  );

  it("preserves delivery uncertainty across refanout, trusted resume, and restart", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const session = fixture.sessions.find(
      (candidate) => candidate.id === "builder-session",
    )!;
    session.ready = true;
    fixture.manager.submitInput.mockResolvedValueOnce(true);
    await service.onSessionStatus(session);
    await vi.waitFor(() =>
      expect(
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ]?.state,
      ).toBe("delivery-uncertain"),
    );

    const refanout = await service.openOrReuse(
      fixture.identity,
      fixture.request,
    );
    expect(refanout.bindings[0]).toMatchObject({
      state: "delivery-uncertain",
      kickoff: { state: "delivery-uncertain" },
    });
    session.status = "exited";
    await service.resume(PROJECT_ID, session.id);
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      state: "delivery-uncertain",
      kickoff: { state: "delivery-uncertain" },
    });

    const restarted = fixture.service();
    await restarted.reconcile();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      state: "delivery-uncertain",
      kickoff: { state: "delivery-uncertain" },
    });
    expect(fixture.manager.submitInput).toHaveBeenCalledTimes(1);
  });

  it.each(["\u0001", "\u007f", "\ud800"])(
    "maps unsafe persisted text %j to bounded invalid_request without mutation",
    async (unsafe) => {
      const fixture = publicFixture(true);
      const service = fixture.service();
      await service.openOrReuse(fixture.identity, fixture.request);
      const { session, builder } = markBuilderPlanning(fixture);
      const metadata = session.builderPlanning!;
      const before = structuredClone(fixture.aggregate().buildPlanning);

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
          requestId: "unsafe-text",
          status: "ready",
          implementationPlan: [
            {
              stepId: "step-one",
              ordinal: 1,
              description: unsafe,
              verification: "Run the focused suite",
            },
          ],
          risks: [],
          questions: [],
          proposedMapOperationIds: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(fixture.aggregate().buildPlanning).toEqual(before);
    },
  );

  it("persists trimmed planning text and replays padding variants with one digest", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const { session, builder } = markBuilderPlanning(fixture);
    const base = planningResultRequest(
      session,
      "trimmed-result",
      "  Implement the assignment  ",
    );
    const padded = {
      ...base,
      implementationPlan: [
        { ...base.implementationPlan[0]!, verification: "  Run tests  " },
      ],
      risks: [
        {
          riskId: "risk-one",
          description: "  A risk  ",
          mitigation: "  Mitigate it  ",
        },
      ],
      questions: [{ questionId: "question-one", question: "  A question?  " }],
    };

    const first = await service.submitResult(builder, padded);
    expect(first).toMatchObject({
      implementationPlan: [
        {
          description: "Implement the assignment",
          verification: "Run tests",
        },
      ],
      risks: [{ description: "A risk", mitigation: "Mitigate it" }],
      questions: [{ question: "A question?" }],
    });
    const replay = await service.submitResult(builder, {
      ...padded,
      implementationPlan: [
        {
          ...padded.implementationPlan[0]!,
          description: "Implement the assignment",
          verification: "Run tests",
        },
      ],
      risks: [
        {
          ...padded.risks[0]!,
          description: "A risk",
          mitigation: "Mitigate it",
        },
      ],
      questions: [{ ...padded.questions[0]!, question: "A question?" }],
    });
    expect(replay).toEqual(first);
    expect(replay.requestDigest).toBe(first.requestDigest);
  });

  it("submits only for the exact effective brief and enforces request replay", async () => {
    const fixture = publicFixture(true);
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    const { session, builder } = markBuilderPlanning(fixture);
    const metadata = session.builderPlanning!;
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
    const first = await service.submitResult(builder, request);
    const replay = await service.submitResult(builder, request);
    expect(replay).toEqual(first);
    expect(
      fixture.aggregate().buildPlanning.planningSubmissionReceipts,
    ).toHaveLength(256);
    session.ready = true;
    await service.onSessionStatus(session);
    const submittedBinding =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    await service.onEventPersisted({
      eventId: "late-kickoff-after-result",
      seq: 1,
      ts: "2026-09-03T11:00:02.000Z",
      userId: "user-test",
      tenantId: null,
      machineId: "machine-test",
      harnessSessionId: session.id,
      agentSessionId: session.agentSessionId,
      harness: "codex",
      type: "prompt.submitted",
      payload: {
        builderKickoffInputId: submittedBinding.kickoff!.inputId,
      },
    });
    expect(fixture.manager.submitInput).not.toHaveBeenCalled();
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      state: "submitted",
      kickoff: { state: "delivered" },
    });
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

  it("cannot project an old stale snapshot onto a replacement context", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    markBuilderPlanning(fixture);
    fixture.aggregate().buildPlanning.currentBriefByAgentId = {};
    const replacementDigest = `sha256:${"e".repeat(64)}` as never;

    fixture.beforeNextList(() => {
      const stale =
        fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
          ASSIGNMENT_ID
        ]!;
      expect(stale.state).toBe("stale");
      const replacement: BuilderPlanningSessionBinding = {
        ...structuredClone(stale),
        bootstrapDigest: replacementDigest,
        lifecycleEpoch: stale.lifecycleEpoch + 1,
        sessionId: "builder-session-2",
        state: "planning",
        staleReasons: [],
      };
      const aggregate = fixture.aggregate();
      aggregate.buildPlanning = {
        ...aggregate.buildPlanning,
        builderBindingsByAssignmentId: {
          ...aggregate.buildPlanning.builderBindingsByAssignmentId,
          [ASSIGNMENT_ID]: replacement,
        },
      };
      const prior = fixture.sessions.find(
        (session) => session.id === "builder-session",
      )!;
      fixture.sessions.push({
        ...structuredClone(prior),
        id: "builder-session-2",
        agentMapIdentity: {
          ...prior.agentMapIdentity!,
          sessionId: "builder-session-2",
        },
        builderPlanning: {
          ...prior.builderPlanning!,
          lifecycleEpoch: replacement.lifecycleEpoch,
          bootstrapDigest: replacementDigest,
          state: "planning",
        },
      });
    });

    await service.reconcileProject(PROJECT_ID);

    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ],
    ).toMatchObject({
      bootstrapDigest: replacementDigest,
      sessionId: "builder-session-2",
      state: "planning",
    });
    expect(
      fixture.sessions.find((session) => session.id === "builder-session")
        ?.builderPlanning,
    ).toMatchObject({
      state: "stale",
    });
    expect(
      fixture.sessions.find((session) => session.id === "builder-session-2")
        ?.builderPlanning,
    ).toMatchObject({
      bootstrapDigest: replacementDigest,
      state: "planning",
    });
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

  it("does not let a delayed delivery completion revive a stale binding", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service() as unknown as {
      deliverKickoff: Delivery;
      reconcileProject: BuilderPlanningSessionService["reconcileProject"];
      onEventPersisted: BuilderPlanningSessionService["onEventPersisted"];
      onSessionStatus: BuilderPlanningSessionService["onSessionStatus"];
    };
    await fixture.service().openOrReuse(fixture.identity, fixture.request);
    const binding =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    const session = fixture.sessions.find(
      (candidate) => candidate.id === "builder-session",
    )!;
    session.ready = true;
    let release!: (accepted: boolean) => void;
    fixture.manager.submitInput.mockImplementationOnce(
      async () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const delivery = service.deliverKickoff(binding);
    await vi.waitFor(() =>
      expect(fixture.manager.submitInput).toHaveBeenCalledTimes(1),
    );

    fixture.aggregate().buildPlanning.currentBriefByAgentId = {};
    await service.reconcileProject(PROJECT_ID);
    release(true);
    await delivery;
    const stale =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    expect(stale.state).toBe("stale");

    await service.onEventPersisted({
      eventId: "late-stale-kickoff",
      seq: 1,
      ts: "2026-09-03T11:00:03.000Z",
      userId: "user-test",
      tenantId: null,
      machineId: "machine-test",
      harnessSessionId: session.id,
      agentSessionId: session.agentSessionId,
      harness: "codex",
      type: "prompt.submitted",
      payload: { builderKickoffInputId: stale.kickoff!.inputId },
    });
    await service.onSessionStatus(session);
    expect(
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]?.state,
    ).toBe("stale");
    expect(fixture.manager.submitInput).toHaveBeenCalledTimes(1);
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

    await expect(service.onEventPersisted(event)).resolves.toBeUndefined();
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

  it("keeps an old tab stale when its durable acknowledgement projection loses to replacement", async () => {
    const fixture = publicFixture(true);
    const service = fixture.service();
    await service.openOrReuse(fixture.identity, fixture.request);
    const initialSession = fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!;
    fixture.sessions.push({
      ...structuredClone(initialSession),
      id: "builder-secondary",
      agentMapIdentity: {
        ...initialSession.agentMapIdentity!,
        sessionId: "builder-secondary",
      },
      builderPlanning: {
        ...initialSession.builderPlanning!,
        primary: false,
      },
    });
    const oldBinding =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!;
    oldBinding.state = "kickoff-pending";
    oldBinding.kickoff = {
      ...oldBinding.kickoff!,
      state: "delivering",
      attemptCount: 1,
      deliveryClaimId: "delivery-claim_old-aba",
      deliveryClaimedAt: "2026-09-03T11:00:00.000Z",
    };
    let announceCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      announceCommit = resolve;
    });
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    fixture.afterNextTransactionCommit(async () => {
      announceCommit();
      await projectionGate;
    });
    const acknowledgement = service.onEventPersisted({
      eventId: "old-ack-before-replacement",
      seq: 1,
      ts: "2026-09-03T11:00:02.000Z",
      userId: "user-test",
      tenantId: null,
      machineId: "machine-test",
      harnessSessionId: "builder-session",
      agentSessionId: "builder-agent",
      harness: "codex",
      type: "prompt.submitted",
      payload: { builderKickoffInputId: oldBinding.kickoff.inputId },
    });
    await committed;
    const acknowledgedEpoch =
      fixture.aggregate().buildPlanning.builderBindingsByAssignmentId[
        ASSIGNMENT_ID
      ]!.lifecycleEpoch;

    const aggregate = fixture.aggregate();
    const priorBrief = aggregate.buildPlanning.briefVersionsById[BRIEF_ID]![0]!;
    const replacementBrief = {
      ...structuredClone(priorBrief),
      version: 2 as never,
      semanticDigest: `sha256:${"d".repeat(64)}` as never,
      recordDigest: `sha256:${"e".repeat(64)}` as never,
    };
    const replacementBriefRef = {
      briefId: replacementBrief.briefId,
      version: replacementBrief.version,
      semanticDigest: replacementBrief.semanticDigest,
    };
    aggregate.buildPlanning = {
      ...aggregate.buildPlanning,
      currentBriefByAgentId: {
        ...aggregate.buildPlanning.currentBriefByAgentId,
        [AGENT_ID]: replacementBriefRef,
      },
      briefVersionsById: {
        ...aggregate.buildPlanning.briefVersionsById,
        [BRIEF_ID]: [priorBrief, replacementBrief],
      },
    };
    const replacementConsent = await service.prepareConsent(fixture.identity, {
      source: fixture.request.source,
      plan: fixture.request.plan,
      assignmentIds: fixture.request.assignmentIds,
    });
    fixture.acceptPlannerReply();
    const replacement = await service.openOrReuse(fixture.identity, {
      ...fixture.request,
      consentId: replacementConsent.consentId,
    });
    const oldSession = fixture.sessions.find(
      (session) => session.id === "builder-session",
    )!;
    expect(oldSession.builderPlanning).toMatchObject({
      state: "stale",
      lifecycleEpoch: acknowledgedEpoch + 1,
    });
    expect(
      fixture.sessions.find((session) => session.id === "builder-secondary")
        ?.builderPlanning,
    ).toMatchObject({
      state: "stale",
      lifecycleEpoch: acknowledgedEpoch + 1,
      primary: false,
    });

    releaseProjection();
    await acknowledgement;

    expect(oldSession.builderPlanning).toMatchObject({
      state: "stale",
      lifecycleEpoch: acknowledgedEpoch + 1,
    });
    expect(replacement.bindings[0]).toMatchObject({
      brief: replacementBriefRef,
      sessionId: "builder-session-2",
    });
    expect(
      fixture.sessions.find((session) => session.id === "builder-session-2")
        ?.builderPlanning,
    ).toMatchObject({
      brief: replacementBriefRef,
      state: "kickoff-pending",
      primary: true,
    });
  });
});
