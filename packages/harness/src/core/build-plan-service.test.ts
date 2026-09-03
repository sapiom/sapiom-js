import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentMapGraph,
  DraftRef,
  PlanNodeId,
  PlanningSessionIdentity,
} from "../shared/agent-map.js";
import type {
  AgentBriefVersionRecord,
  ArchitectureSourceRef,
} from "../shared/build-plan.js";
import { emptyBuildPlanningAggregate } from "../shared/build-plan.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { AgentMapProposalService } from "./agent-map-proposal-service.js";
import { BuildPlanContractValidator } from "./build-plan-contract-validator.js";
import {
  type AgentBriefCompiler,
  BuildPlanService,
} from "./build-plan-service.js";
import { DeterministicAgentBriefCompiler } from "./agent-brief-compiler.js";
import { CanonicalBuildPlanImpactEvaluator } from "./build-plan-impact-evaluator.js";
import {
  MARKETING_ID,
  RESEARCH_ID,
  stockResearchGraph,
  stockResearchPlan,
  stockResearchRelayFixture,
} from "./agent-brief-compiler.test-support.js";
import { BuildPlanStore } from "./build-plan-store.js";
import {
  computeArchitectureGraphDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";
import {
  AGENT_ID,
  ASSIGNMENT_ID,
  BRIEF_ID,
  graph,
  makeBrief,
  makePlan,
  PLAN_ID,
  PROJECT_ID,
  proposalSource,
} from "./build-plan.test-support.js";

const identity: PlanningSessionIdentity = {
  projectId: PROJECT_ID,
  sessionId: "planner-session",
  userId: "planner-user",
  role: "map-planner",
};
const SECOND_AGENT_ID =
  "node_00000000-0000-7000-8000-000000000006" as PlanNodeId;
const MILESTONE_ID = "milestone_00000000-0000-7000-8000-000000000010";
const DELIVERABLE_ID = "deliverable_00000000-0000-7000-8000-000000000011";
const CRITERION_ID = "criterion_00000000-0000-7000-8000-000000000012";
const DECISION_ID = "decision_00000000-0000-7000-8000-000000000013";
const baseOperations = [
  { op: "set-project-outcome" as const, outcome: { summary: "Ship safely" } },
  {
    op: "upsert-agent-assignment" as const,
    assignment: {
      plannedAgentId: AGENT_ID,
      mission: "Implement the feature",
      scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
      deliverables: [],
      constraints: [],
      acceptanceCriteria: [],
      milestoneIds: [],
      unresolvedDecisions: [],
    },
  },
];

describe("BuildPlanService", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(
    beforePersistStep?: (
      step: "write" | "rename" | "file-sync" | "directory-sync",
    ) => void,
  ) {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "build-plan-service-"),
    );
    roots.push(root);
    const workspace = new AgentMapWorkspaceStore(root, {
      ...(beforePersistStep ? { beforePersistStep } : {}),
    });
    const allocator = {
      allocateBuildPlanId: vi.fn(() => PLAN_ID),
      allocateBriefId: vi.fn(() => BRIEF_ID),
      allocateAssignmentId: vi.fn(() => ASSIGNMENT_ID),
    };
    const store = new BuildPlanStore(workspace, {
      allocator,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });
    const graphs = new Map([[computeArchitectureGraphDigest(graph), graph]]);
    let resolveCount = 0;
    let onResolve: ((count: number) => Promise<void> | void) | undefined;
    const resolver = {
      resolve: async (projectId: string, source: ArchitectureSourceRef) => {
        if (projectId !== PROJECT_ID) throw new Error("cross project");
        resolveCount += 1;
        await onResolve?.(resolveCount);
        return {
          projectId: PROJECT_ID,
          source,
          graph: graphs.get(source.graphDigest) ?? {
            nodes: [],
            relationships: [],
          },
        };
      },
    };
    const compiler = vi.fn<AgentBriefCompiler["compile"]>(async () => ({
      briefs: [],
      changes: [],
    }));
    const impact = vi.fn(async () => ({}));
    const service = new BuildPlanService({
      store,
      sourceResolver: resolver,
      contractValidator: new BuildPlanContractValidator(resolver),
      briefCompiler: { compile: compiler },
      impactEvaluator: { evaluate: impact },
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
    });
    let operationNumber = 8;
    const proposalService = new AgentMapProposalService(workspace, {
      allocator: {
        allocateNodeId: () => AGENT_ID,
        allocateRelationshipId: () =>
          "rel_00000000-0000-7000-8000-000000000009" as never,
        allocateProposalId: () => proposalSource().proposalId,
        allocateOperationId: () =>
          `operation_00000000-0000-7000-8000-${String(operationNumber++).padStart(12, "0")}` as never,
      },
      now: () => new Date("2026-09-03T09:00:00.000Z"),
    });
    await proposalService.propose(identity, {
      schemaVersion: 1,
      proposalId: null,
      expectedVersion: 0,
      requestId: "seed-proposal",
      operations: [
        {
          kind: "add-node",
          draftRef: "seed-agent" as DraftRef,
          node: {
            kind: "agent",
            name: graph.nodes[0]!.name,
            purpose: graph.nodes[0]!.purpose,
            ownerAgent: null,
            contractRefs: [],
          },
        },
      ],
    });
    return {
      service,
      store,
      workspace,
      proposalService,
      allocator,
      compiler,
      impact,
      resolver,
      onResolve: (callback: (count: number) => Promise<void> | void) => {
        onResolve = callback;
      },
      registerGraph: (value: typeof graph) =>
        graphs.set(computeArchitectureGraphDigest(value), value),
    };
  }

  it("validates initial creation without allocating or persisting, then applies atomically", async () => {
    const { service, store, compiler, allocator } = await fixture();
    compiler.mockImplementation(async ({ plan, assignments }) => {
      const assignment = assignments[0]!;
      return {
        briefs: [
          makeBrief(plan, {
            briefId: assignment.briefId,
            assignmentId: assignment.assignmentId,
            plan: {
              planId: plan.planId,
              version: plan.version,
              semanticDigest: plan.semanticDigest,
            },
            source: plan.source,
            authoredBy: plan.authoredBy,
            createdAt: plan.createdAt,
          }),
        ],
        changes: [
          { plannedAgentId: assignment.plannedAgentId, change: "created" },
        ],
      };
    });
    const request = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      operations: baseOperations,
    };
    const preview = await service.validate(identity, request);
    expect(preview.wouldApply).toBe(true);
    expect(preview.eligibility).toMatchObject({
      planningEligible: true,
      implementationEligible: false,
      reasons: ["source-not-confirmed"],
    });
    expect((await store.read(PROJECT_ID)).planVersions).toEqual([]);
    const repeatedPreview = await service.validate(identity, request);
    expect(repeatedPreview.plan).toEqual(preview.plan);
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);

    const applied = await service.apply(identity, {
      ...request,
      requestId: "request-create",
    });
    expect(applied).toMatchObject({
      plan: { version: 1 },
      briefChanges: [{ plannedAgentId: AGENT_ID, change: "created" }],
      replayed: false,
    });
    const persisted = await store.read(PROJECT_ID);
    expect(persisted.planVersions).toHaveLength(1);
    expect(persisted.currentBriefByAgentId[AGENT_ID]).toMatchObject({
      version: 1,
    });
    await expect(
      service.read(identity, {
        schemaVersion: 1,
        plan: { planId: applied.plan.planId, version: 1 },
        include: ["assignment-intents", "history-summary"],
      }),
    ).resolves.toMatchObject({
      plan: { planId: applied.plan.planId, version: 1 },
      assignmentIntents: [{ plannedAgentId: AGENT_ID }],
      history: { versionCount: 1, currentVersion: 1 },
    });
    const planOnly = await service.read(identity, {
      schemaVersion: 1,
      plan: { planId: applied.plan.planId, version: 1 },
      include: ["plan"],
    });
    const state = planOnly.state!;
    expect(state.assignments).toEqual([
      expect.objectContaining({ plannedAgentId: AGENT_ID }),
    ]);
    expect(computeBuildPlanSemanticDigest(state)).toBe(state.semanticDigest);
    expect(computeBuildPlanRecordDigest(state)).toBe(state.recordDigest);
  });

  it("does not recommit compiler-preserved current briefs", async () => {
    const { service, store, compiler } = await fixture();
    compiler.mockImplementationOnce(async ({ plan, assignments }) => {
      const assignment = assignments[0]!;
      return {
        briefs: [
          makeBrief(plan, {
            briefId: assignment.briefId,
            assignmentId: assignment.assignmentId,
            plan: {
              planId: plan.planId,
              version: plan.version,
              semanticDigest: plan.semanticDigest,
            },
            source: plan.source,
            authoredBy: plan.authoredBy,
            createdAt: plan.createdAt,
          }),
        ],
        changes: [
          { plannedAgentId: assignment.plannedAgentId, change: "created" },
        ],
      };
    });
    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-create-with-brief",
      operations: baseOperations,
    });
    compiler.mockImplementation(async ({ currentBriefs }) => ({
      briefs: currentBriefs.filter(
        (brief): brief is AgentBriefVersionRecord => brief.schemaVersion === 2,
      ),
      changes: currentBriefs.map((brief) => ({
        plannedAgentId: brief.plannedAgentId,
        change: "preserved",
      })),
    }));

    await expect(
      service.apply(identity, {
        schemaVersion: 1,
        planId: created.plan.planId,
        expectedPlanVersion: created.plan.version,
        expectedSource: proposalSource(),
        requestId: "request-preserved-brief",
        operations: [
          {
            op: "set-project-outcome",
            outcome: { summary: "Update without recompiling the brief" },
          },
        ],
      }),
    ).resolves.toMatchObject({
      plan: { version: 2 },
      briefChanges: [{ plannedAgentId: AGENT_ID, change: "preserved" }],
    });
    expect(
      Object.values((await store.read(PROJECT_ID)).briefVersionsById),
    ).toEqual([
      expect.arrayContaining([expect.objectContaining({ version: 1 })]),
    ]);
    await expect(
      service.read(identity, {
        schemaVersion: 1,
        include: ["brief-summaries"],
      }),
    ).resolves.toMatchObject({
      plan: { version: 2 },
      briefs: [{ version: 1, current: true, freshness: "current" }],
    });
  });

  it("supports request replay, rejects changed payloads, and reports stale versions", async () => {
    const { service } = await fixture();
    const request = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-create",
      operations: baseOperations,
    };
    const created = await service.apply(identity, request);
    await expect(service.apply(identity, request)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      service.apply(identity, {
        ...request,
        operations: [
          { op: "set-project-outcome", outcome: { summary: "Changed" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(
      service.apply(identity, {
        ...request,
        requestId: "request-stale",
        planId: created.plan.planId,
        expectedPlanVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "plan_version_conflict" });
    await expect(
      service.apply(identity, {
        ...request,
        requestId: "request-source-mismatch",
        planId: created.plan.planId,
        expectedPlanVersion: 1,
        expectedSource: {
          kind: "revision",
          revisionId: "revision_00000000-0000-7000-8000-000000000099",
          revisionNumber: 1,
          graphDigest: request.expectedSource.graphDigest,
        },
      }),
    ).rejects.toMatchObject({ code: "source_mismatch" });
  });

  it("replays the exact full apply result above the 128-assignment projection cap", async () => {
    const agentIds = Array.from(
      { length: 129 },
      (_, index) =>
        `node_80000000-0000-7000-8000-${index
          .toString(16)
          .padStart(12, "0")}` as PlanNodeId,
    );
    const manyAgentGraph: AgentMapGraph = {
      nodes: agentIds.map((id, index) => ({
        id,
        kind: "agent",
        name: `Agent ${index}`,
        purpose: `Own assignment ${index}`,
        ownerAgentId: null,
        contractRefs: [],
      })),
      relationships: [],
    };
    const source = {
      kind: "revision" as const,
      revisionId: "revision_80000000-0000-7000-8000-000000000001" as never,
      revisionNumber: 1,
      graphDigest: computeArchitectureGraphDigest(manyAgentGraph),
    };
    const current = makePlan({
      source,
      assignments: agentIds.map((plannedAgentId, index) => ({
        plannedAgentId,
        mission: `Implement assignment ${index}`,
        scope: { inScope: [`Scope ${index}`], nonGoals: ["Deployment"] },
        deliverables: [],
        constraints: [],
        acceptanceCriteria: [],
        milestoneIds: [],
        unresolvedDecisions: [],
      })),
    });
    let planning = {
      ...emptyBuildPlanningAggregate(),
      planId: current.planId,
      currentPlanVersion: current.version,
      planVersions: [current],
    };
    const commitPlanVersion = vi.fn(
      async (...args: Parameters<BuildPlanStore["commitPlanVersion"]>) => {
        const [plan, , commit, compiled] = args;
        planning = {
          ...planning,
          currentPlanVersion: plan.version,
          planVersions: [...planning.planVersions, plan],
          idempotencyReceipts: [
            {
              sessionId: commit.sessionId,
              requestId: commit.requestId,
              requestDigest: commit.requestDigest,
              resultRecordDigest: plan.recordDigest,
              ...(commit.result ? { result: commit.result } : {}),
              createdAt: "2026-09-03T10:00:00.000Z",
            },
          ],
        };
        return {
          plan: {
            planId: plan.planId,
            version: plan.version,
            semanticDigest: plan.semanticDigest,
          },
          assignments: [...(compiled?.assignments ?? [])],
          replayed: false,
          ...(commit.result ? { receiptResult: commit.result } : {}),
        };
      },
    );
    const store = {
      read: vi.fn(async () => structuredClone(planning)),
      isCurrentProposalSource: vi.fn(async () => true),
      commitPlanVersion,
    } as unknown as BuildPlanStore;
    const resolver = {
      resolve: vi.fn(async () => ({
        projectId: PROJECT_ID,
        source,
        graph: manyAgentGraph,
      })),
    };
    const compiler = {
      compile: vi.fn<AgentBriefCompiler["compile"]>(
        async ({ assignments }) => ({
          briefs: [],
          changes: assignments.map(({ plannedAgentId }) => ({
            plannedAgentId,
            change: "preserved" as const,
          })),
        }),
      ),
    };
    const service = new BuildPlanService({
      store,
      sourceResolver: resolver,
      contractValidator: new BuildPlanContractValidator(resolver),
      briefCompiler: compiler,
      impactEvaluator: { evaluate: vi.fn(async () => ({})) },
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
    });
    const request = {
      schemaVersion: 1,
      planId: current.planId,
      expectedPlanVersion: current.version,
      expectedSource: source,
      requestId: "request-many-assignment-replay",
      operations: [
        {
          op: "set-project-outcome" as const,
          outcome: { summary: "Ship the many-agent plan" },
        },
      ],
    };

    const applied = await service.apply(identity, request);
    const replayed = await service.apply(identity, request);

    if (!("impactedAssignments" in applied))
      throw new Error("expected a full apply result");
    expect(applied.impactedAssignments).toHaveLength(128);
    expect(replayed).toEqual({ ...applied, replayed: true });
    expect(commitPlanVersion).toHaveBeenCalledTimes(1);
  });

  it("replays the original full apply and rebase results under concurrent request races", async () => {
    const { service, compiler, impact } = await fixture();
    compiler.mockImplementation(async ({ assignments }) => ({
      briefs: [],
      changes: assignments.map(({ plannedAgentId }) => ({
        plannedAgentId,
        change: "created" as const,
      })),
    }));
    const createRequest = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-concurrent-create",
      operations: baseOperations,
    };
    const applies = await Promise.all([
      service.apply(identity, createRequest),
      service.apply(identity, createRequest),
    ]);
    expect(applies.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(applies[1]).toEqual({
      ...applies[0],
      replayed: !applies[0]!.replayed,
    });

    const current = applies[0]!.plan;
    impact.mockResolvedValue({
      [AGENT_ID]: [
        {
          code: "source-changed",
          affectedNodeIds: [AGENT_ID],
          affectedRelationshipIds: [],
          affectedContractIds: [],
        },
      ],
    });
    const revisionSource = {
      kind: "revision" as const,
      revisionId: "revision_00000000-0000-7000-8000-000000000020",
      revisionNumber: 1,
      graphDigest: proposalSource().graphDigest,
    };
    const rebaseRequest = {
      schemaVersion: 1,
      planId: current.planId,
      expectedPlanVersion: current.version,
      fromSource: proposalSource(),
      toSource: revisionSource,
      requestId: "request-concurrent-rebase",
      resolutions: [],
    };
    const rebases = await Promise.all([
      service.rebase(identity, rebaseRequest),
      service.rebase(identity, rebaseRequest),
    ]);
    expect(rebases.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(rebases[1]).toEqual({
      ...rebases[0],
      replayed: !rebases[0]!.replayed,
    });
  });

  it("replays apply when the same request commits between replay and prepare reads", async () => {
    const { service, store } = await fixture();
    const request = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-apply-preflight-race",
      operations: baseOperations,
    };
    const read = store.read.bind(store);
    let readCount = 0;
    let committed: Awaited<ReturnType<typeof service.apply>> | undefined;
    vi.spyOn(store, "read").mockImplementation(async (projectId) => {
      readCount += 1;
      if (readCount === 2) committed = await service.apply(identity, request);
      return read(projectId);
    });

    const replayed = await service.apply(identity, request);

    expect(committed).toMatchObject({ plan: { version: 1 }, replayed: false });
    expect(replayed).toEqual({ ...committed!, replayed: true });
    expect((await read(PROJECT_ID)).planVersions).toHaveLength(1);
  });

  it("rejects a changed apply payload committed during the preflight race", async () => {
    const { service, store } = await fixture();
    const request = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-apply-preflight-reused",
      operations: baseOperations,
    };
    const competingRequest = {
      ...request,
      operations: [
        {
          op: "set-project-outcome" as const,
          outcome: { summary: "Competing payload" },
        },
      ],
    };
    const read = store.read.bind(store);
    let readCount = 0;
    vi.spyOn(store, "read").mockImplementation(async (projectId) => {
      readCount += 1;
      if (readCount === 2) await service.apply(identity, competingRequest);
      return read(projectId);
    });

    await expect(service.apply(identity, request)).rejects.toMatchObject({
      code: "idempotency_key_reused",
    });
    expect((await read(PROJECT_ID)).planVersions).toHaveLength(1);
  });

  it("replays rebase when the same request commits between replay and preflight reads", async () => {
    const { service, store } = await fixture();
    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-create-before-rebase-preflight-race",
      operations: baseOperations,
    });
    const request = {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: created.plan.version,
      fromSource: proposalSource(),
      toSource: {
        kind: "revision" as const,
        revisionId: "revision_00000000-0000-7000-8000-000000000021",
        revisionNumber: 1,
        graphDigest: proposalSource().graphDigest,
      },
      requestId: "request-rebase-preflight-race",
      resolutions: [],
    };
    const read = store.read.bind(store);
    let readCount = 0;
    let committed: Awaited<ReturnType<typeof service.rebase>> | undefined;
    vi.spyOn(store, "read").mockImplementation(async (projectId) => {
      readCount += 1;
      if (readCount === 2) committed = await service.rebase(identity, request);
      return read(projectId);
    });

    const replayed = await service.rebase(identity, request);

    expect(committed).toMatchObject({ plan: { version: 2 }, replayed: false });
    expect(replayed).toEqual({ ...committed!, replayed: true });
    expect((await read(PROJECT_ID)).planVersions).toHaveLength(2);
  });

  it("allocates canonical subrecord IDs from bounded client correlations", async () => {
    const { service, allocator, store } = await fixture();
    const request = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      operations: [
        baseOperations[0]!,
        {
          op: "create-milestone",
          clientRef: "milestone-alpha",
          milestone: {
            ordinal: 1,
            title: "Alpha",
            outcome: "Ready",
            dependsOn: [],
          },
        },
        {
          op: "create-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "Ship the feature",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                clientRef: "deliverable-alpha",
                description: "Produce the artifact",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionRefs: [{ clientRef: "criterion-alpha" }],
              },
            ],
            constraints: [],
            acceptanceCriteria: [
              {
                clientRef: "criterion-alpha",
                ordinal: 1,
                description: "It works",
                verification: "Run tests",
              },
            ],
            milestoneRefs: [{ clientRef: "milestone-alpha" }],
            unresolvedDecisions: [
              {
                clientRef: "decision-alpha",
                question: "Ready?",
                required: false,
                status: "resolved",
                resolution: "Yes",
              },
            ],
          },
        },
      ],
    };
    const preview = await service.validate(identity, request);
    const result = await service.apply(identity, {
      ...request,
      requestId: "request-client-correlations",
    });
    expect(result.idMappings).toEqual(preview.idMappings);
    expect(result.idMappings.map(({ kind }) => kind).sort()).toEqual([
      "criterion",
      "decision",
      "deliverable",
      "milestone",
    ]);
    const persisted = (await store.read(PROJECT_ID)).planVersions[0]!;
    expect(persisted.assignments[0]!.milestoneIds).toEqual([
      result.idMappings.find(({ kind }) => kind === "milestone")!.id,
    ]);
    expect(persisted.assignments[0]!.deliverables[0]).toMatchObject({
      deliverableId: result.idMappings.find(
        ({ kind }) => kind === "deliverable",
      )!.id,
      acceptanceCriterionIds: [
        result.idMappings.find(({ kind }) => kind === "criterion")!.id,
      ],
    });
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it.each([
    [
      "milestone",
      {
        op: "upsert-milestone",
        milestone: {
          milestoneId: MILESTONE_ID,
          ordinal: 1,
          title: "Fabricated",
          outcome: "Must be rejected",
          dependsOn: [],
        },
      },
    ],
    [
      "integration criterion",
      {
        op: "set-integration-criteria",
        criteria: [
          {
            criterionId: CRITERION_ID,
            ordinal: 1,
            description: "Fabricated",
            verification: "Must be rejected",
          },
        ],
      },
    ],
    [
      "assignment deliverable",
      {
        op: "upsert-agent-assignment",
        assignment: {
          ...baseOperations[1]!.assignment,
          deliverables: [
            {
              deliverableId: DELIVERABLE_ID,
              description: "Fabricated",
              artifactNodeIds: [AGENT_ID],
              acceptanceCriterionIds: [],
            },
          ],
        },
      },
    ],
    [
      "assignment criterion",
      {
        op: "upsert-agent-assignment",
        assignment: {
          ...baseOperations[1]!.assignment,
          acceptanceCriteria: [
            {
              criterionId: CRITERION_ID,
              ordinal: 1,
              description: "Fabricated",
              verification: "Must be rejected",
            },
          ],
        },
      },
    ],
    [
      "assignment decision",
      {
        op: "upsert-agent-assignment",
        assignment: {
          ...baseOperations[1]!.assignment,
          unresolvedDecisions: [
            {
              decisionId: DECISION_ID,
              question: "Fabricated?",
              required: false,
              status: "resolved",
              resolution: "Reject it",
            },
          ],
        },
      },
    ],
    [
      "plan decision",
      {
        op: "upsert-decision",
        decision: {
          decisionId: DECISION_ID,
          question: "Fabricated?",
          required: false,
          status: "resolved",
          resolution: "Reject it",
        },
      },
    ],
  ])(
    "rejects a caller-chosen canonical ID for an absent %s",
    async (_label, operation) => {
      const { service, store, compiler, allocator } = await fixture();
      await expect(
        service.apply(identity, {
          schemaVersion: 1,
          planId: null,
          expectedPlanVersion: null,
          expectedSource: proposalSource(),
          requestId: `request-fabricated-${_label}`,
          operations: [baseOperations[0]!, operation],
        }),
      ).rejects.toMatchObject({ code: "invalid_operation" });
      expect(compiler).not.toHaveBeenCalled();
      expect(
        Object.values(allocator).every(
          (allocate) => allocate.mock.calls.length === 0,
        ),
      ).toBe(true);
      expect(await store.read(PROJECT_ID)).toMatchObject({
        planVersions: [],
        idempotencyReceipts: [],
        currentPlanVersion: null,
      });
    },
  );

  it("updates existing canonical identities without replacing their scope", async () => {
    const { service } = await fixture();
    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-create-update-targets",
      operations: [
        baseOperations[0]!,
        {
          op: "create-milestone",
          clientRef: "milestone-update",
          milestone: {
            ordinal: 1,
            title: "Before",
            outcome: "Before",
            dependsOn: [],
          },
        },
        {
          op: "create-integration-criterion",
          criterion: {
            clientRef: "integration-update",
            ordinal: 1,
            description: "Before",
            verification: "Before",
          },
        },
        {
          op: "create-decision",
          decision: {
            clientRef: "plan-decision-update",
            question: "Before?",
            required: false,
            status: "resolved",
            resolution: "Before",
          },
        },
        {
          op: "create-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "Before",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                clientRef: "deliverable-update",
                description: "Before",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionRefs: [
                  { clientRef: "assignment-criterion-update" },
                ],
              },
            ],
            constraints: [],
            acceptanceCriteria: [
              {
                clientRef: "assignment-criterion-update",
                ordinal: 1,
                description: "Before",
                verification: "Before",
              },
            ],
            milestoneRefs: [{ clientRef: "milestone-update" }],
            unresolvedDecisions: [
              {
                clientRef: "assignment-decision-update",
                question: "Before?",
                required: false,
                status: "resolved",
                resolution: "Before",
              },
            ],
          },
        },
      ],
    });
    const mapped = new Map(
      created.idMappings.map(({ clientRef, id }) => [clientRef, id]),
    );

    const updated = await service.apply(identity, {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: created.plan.version,
      expectedSource: proposalSource(),
      requestId: "request-update-canonical-targets",
      operations: [
        {
          op: "upsert-milestone",
          milestone: {
            milestoneId: mapped.get("milestone-update"),
            ordinal: 1,
            title: "After",
            outcome: "After",
            dependsOn: [],
          },
        },
        {
          op: "set-integration-criteria",
          criteria: [
            {
              criterionId: mapped.get("integration-update"),
              ordinal: 1,
              description: "After",
              verification: "After",
            },
          ],
        },
        {
          op: "upsert-decision",
          decision: {
            decisionId: mapped.get("plan-decision-update"),
            question: "After?",
            required: false,
            status: "resolved",
            resolution: "After",
          },
        },
        {
          op: "upsert-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "After",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                deliverableId: mapped.get("deliverable-update"),
                description: "After",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionIds: [
                  mapped.get("assignment-criterion-update"),
                ],
              },
            ],
            constraints: [],
            acceptanceCriteria: [
              {
                criterionId: mapped.get("assignment-criterion-update"),
                ordinal: 1,
                description: "After",
                verification: "After",
              },
            ],
            milestoneIds: [mapped.get("milestone-update")],
            unresolvedDecisions: [
              {
                decisionId: mapped.get("assignment-decision-update"),
                question: "After?",
                required: false,
                status: "resolved",
                resolution: "After",
              },
            ],
          },
        },
      ],
    });

    const updatedState = await service.read(identity, {
      schemaVersion: 1,
      include: ["plan"],
    });
    expect(updatedState.state).toMatchObject({
      milestones: [{ title: "After" }],
      integrationCriteria: [{ description: "After" }],
      unresolvedDecisions: [{ question: "After?" }],
      assignments: [
        {
          mission: "After",
          deliverables: [{ description: "After" }],
          acceptanceCriteria: [{ description: "After" }],
          unresolvedDecisions: [{ question: "After?" }],
        },
      ],
    });
    expect(updated.idMappings).toEqual([]);
  });

  it("resolves update identities only from creates earlier in the same batch", async () => {
    const { service } = await fixture();
    const result = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-create-then-update",
      operations: [
        baseOperations[0]!,
        {
          op: "create-milestone",
          clientRef: "milestone-in-batch",
          milestone: {
            ordinal: 1,
            title: "Before",
            outcome: "Before",
            dependsOn: [],
          },
        },
        {
          op: "upsert-milestone",
          milestone: {
            milestoneId: { clientRef: "milestone-in-batch" },
            ordinal: 1,
            title: "After",
            outcome: "After",
            dependsOn: [],
          },
        },
        {
          op: "create-integration-criterion",
          criterion: {
            clientRef: "integration-in-batch",
            ordinal: 1,
            description: "Before",
            verification: "Before",
          },
        },
        {
          op: "set-integration-criteria",
          criteria: [
            {
              criterionId: { clientRef: "integration-in-batch" },
              ordinal: 1,
              description: "After",
              verification: "After",
            },
          ],
        },
        {
          op: "create-decision",
          decision: {
            clientRef: "decision-in-batch",
            question: "Before?",
            required: false,
            status: "resolved",
            resolution: "Before",
          },
        },
        {
          op: "upsert-decision",
          decision: {
            decisionId: { clientRef: "decision-in-batch" },
            question: "After?",
            required: false,
            status: "resolved",
            resolution: "After",
          },
        },
        {
          op: "create-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "Before",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                clientRef: "deliverable-in-batch",
                description: "Before",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionRefs: [{ clientRef: "criterion-in-batch" }],
              },
            ],
            constraints: [],
            acceptanceCriteria: [
              {
                clientRef: "criterion-in-batch",
                ordinal: 1,
                description: "Before",
                verification: "Before",
              },
            ],
            milestoneRefs: [{ clientRef: "milestone-in-batch" }],
            unresolvedDecisions: [
              {
                clientRef: "assignment-decision-in-batch",
                question: "Before?",
                required: false,
                status: "resolved",
                resolution: "Before",
              },
            ],
          },
        },
        {
          op: "upsert-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "After",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                deliverableId: { clientRef: "deliverable-in-batch" },
                description: "After",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionIds: [{ clientRef: "criterion-in-batch" }],
              },
            ],
            constraints: [],
            acceptanceCriteria: [
              {
                criterionId: { clientRef: "criterion-in-batch" },
                ordinal: 1,
                description: "After",
                verification: "After",
              },
            ],
            milestoneIds: [{ clientRef: "milestone-in-batch" }],
            unresolvedDecisions: [
              {
                decisionId: { clientRef: "assignment-decision-in-batch" },
                question: "After?",
                required: false,
                status: "resolved",
                resolution: "After",
              },
            ],
          },
        },
      ],
    });

    const state = await service.read(identity, {
      schemaVersion: 1,
      include: ["plan"],
    });
    expect(state.state).toMatchObject({
      milestones: [{ title: "After" }],
      integrationCriteria: [{ description: "After" }],
      unresolvedDecisions: [{ question: "After?" }],
      assignments: [
        { mission: "After", deliverables: [{ description: "After" }] },
      ],
    });
    expect(result.idMappings).toHaveLength(6);
  });

  it.each([
    ["duplicate", "same-client", "same-client"],
    ["cross-kind collision", "shared-client", "shared-client"],
  ])(
    "rejects a %s clientRef declaration without side effects",
    async (label, firstClientRef, secondClientRef) => {
      const { service, store, compiler } = await fixture();
      const secondOperation =
        label === "duplicate"
          ? {
              op: "create-milestone",
              clientRef: secondClientRef,
              milestone: {
                ordinal: 2,
                title: "Second",
                outcome: "Second",
                dependsOn: [],
              },
            }
          : {
              op: "create-decision",
              decision: {
                clientRef: secondClientRef,
                question: "Collide?",
                required: false,
                status: "resolved",
                resolution: "Reject",
              },
            };
      await expect(
        service.apply(identity, {
          schemaVersion: 1,
          planId: null,
          expectedPlanVersion: null,
          expectedSource: proposalSource(),
          requestId: `request-${label}`,
          operations: [
            baseOperations[0]!,
            {
              op: "create-milestone",
              clientRef: firstClientRef,
              milestone: {
                ordinal: 1,
                title: "First",
                outcome: "First",
                dependsOn: [],
              },
            },
            secondOperation,
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_operation" });
      expect(compiler).not.toHaveBeenCalled();
      expect((await store.read(PROJECT_ID)).planVersions).toEqual([]);
    },
  );

  it.each([
    {
      label: "milestone",
      create: {
        op: "create-milestone",
        clientRef: "create-once-milestone",
        milestone: {
          ordinal: 1,
          title: "Create once",
          outcome: "Never overwrite",
          dependsOn: [],
        },
      },
      recreate: {
        op: "create-milestone",
        clientRef: "create-once-milestone",
        milestone: {
          ordinal: 2,
          title: "Create twice",
          outcome: "Preserve the first",
          dependsOn: [],
        },
      },
    },
    {
      label: "integration criterion",
      create: {
        op: "create-integration-criterion",
        criterion: {
          clientRef: "create-once-integration",
          ordinal: 1,
          description: "Create once",
          verification: "Never overwrite",
        },
      },
      recreate: {
        op: "create-integration-criterion",
        criterion: {
          clientRef: "create-once-integration",
          ordinal: 2,
          description: "Create twice",
          verification: "Preserve the first",
        },
      },
    },
    {
      label: "plan decision",
      create: {
        op: "create-decision",
        decision: {
          clientRef: "create-once-decision",
          question: "Create once?",
          required: false,
          status: "resolved",
          resolution: "Never overwrite",
        },
      },
      recreate: {
        op: "create-decision",
        decision: {
          clientRef: "create-once-decision",
          question: "Create twice?",
          required: false,
          status: "resolved",
          resolution: "Preserve the first",
        },
      },
    },
  ])(
    "gives the same clientRef a fresh $label identity in a later request",
    async ({ label, create, recreate }) => {
      const { service, store, compiler, allocator } = await fixture();
      const request = {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId: `request-create-once-${label}`,
        operations: [...baseOperations, create],
      };
      const created = await service.apply(identity, request);
      await expect(service.apply(identity, request)).resolves.toMatchObject({
        replayed: true,
        idMappings: created.idMappings,
      });
      compiler.mockClear();

      const recreated = await service.apply(identity, {
        ...request,
        planId: created.plan.planId,
        expectedPlanVersion: created.plan.version,
        requestId: `request-recreate-${label}`,
        operations: [recreate],
      });
      expect(recreated.idMappings).toHaveLength(1);
      expect(recreated.idMappings[0]?.clientRef).toBe(
        created.idMappings[0]?.clientRef,
      );
      expect(recreated.idMappings[0]?.id).not.toBe(created.idMappings[0]?.id);
      expect(compiler).toHaveBeenCalledOnce();
      expect(
        Object.values(allocator).every(
          (allocate) => allocate.mock.calls.length === 0,
        ),
      ).toBe(true);
      const planning = await store.read(PROJECT_ID);
      expect(JSON.stringify(planning.planVersions[1])).toContain(
        created.idMappings[0]!.id,
      );
      expect(JSON.stringify(planning.planVersions[1])).toContain(
        recreated.idMappings[0]!.id,
      );
      expect(planning).toMatchObject({
        currentPlanVersion: 2,
        planVersions: [{ version: 1 }, { version: 2 }],
        idempotencyReceipts: [
          { requestId: request.requestId },
          { requestId: `request-recreate-${label}` },
        ],
      });
    },
  );

  it("allocates a fresh historical identity when a removed clientRef is recreated", async () => {
    const { service, store } = await fixture();
    const firstRequest = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      operations: [
        ...baseOperations,
        {
          op: "create-milestone",
          clientRef: "reusable-milestone-ref",
          milestone: {
            ordinal: 1,
            title: "Original milestone",
            outcome: "Preserve this history",
            dependsOn: [],
          },
        },
      ],
    };
    const firstPreview = await service.validate(identity, firstRequest);
    const first = await service.apply(identity, {
      ...firstRequest,
      requestId: "request-historical-create-v1",
    });
    expect(first.idMappings).toEqual(firstPreview.idMappings);
    const firstMilestoneId = first.idMappings[0]!.id;
    const firstRecord = structuredClone(
      (await store.read(PROJECT_ID)).planVersions[0]!,
    );

    const removed = await service.apply(identity, {
      schemaVersion: 1,
      planId: first.plan.planId,
      expectedPlanVersion: first.plan.version,
      expectedSource: proposalSource(),
      requestId: "request-historical-remove-v2",
      operations: [{ op: "remove-milestone", milestoneId: firstMilestoneId }],
    });
    const recreateRequest = {
      schemaVersion: 1,
      planId: first.plan.planId,
      expectedPlanVersion: removed.plan.version,
      expectedSource: proposalSource(),
      operations: [
        {
          op: "create-milestone",
          clientRef: "reusable-milestone-ref",
          milestone: {
            ordinal: 1,
            title: "Recreated milestone",
            outcome: "Receive a fresh identity",
            dependsOn: [],
          },
        },
      ],
    };
    const recreatePreview = await service.validate(identity, recreateRequest);
    const recreatedRequest = {
      ...recreateRequest,
      requestId: "request-historical-recreate-v3",
    };
    const recreated = await service.apply(identity, recreatedRequest);
    expect(recreated.idMappings).toEqual(recreatePreview.idMappings);
    expect(recreated.idMappings[0]?.id).not.toBe(firstMilestoneId);
    await expect(
      service.apply(identity, recreatedRequest),
    ).resolves.toMatchObject({
      replayed: true,
      idMappings: recreated.idMappings,
    });

    const planning = await store.read(PROJECT_ID);
    expect(planning.planVersions).toHaveLength(3);
    expect(planning.planVersions[0]).toEqual(firstRecord);
    expect(planning.planVersions[0]?.milestones).toEqual([
      expect.objectContaining({
        milestoneId: firstMilestoneId,
        title: "Original milestone",
      }),
    ]);
    expect(planning.planVersions[1]?.milestones).toEqual([]);
    expect(planning.planVersions[2]?.milestones).toEqual([
      expect.objectContaining({
        milestoneId: recreated.idMappings[0]?.id,
        title: "Recreated milestone",
      }),
    ]);
  });

  it("does not let create-agent-assignment replace an existing assignment", async () => {
    const { service, store, compiler, allocator } = await fixture();
    const createAssignment = {
      op: "create-agent-assignment",
      assignment: {
        plannedAgentId: AGENT_ID,
        mission: "Create once",
        scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
        deliverables: [],
        constraints: [],
        acceptanceCriteria: [],
        milestoneRefs: [],
        unresolvedDecisions: [],
      },
    };
    await expect(
      service.apply(identity, {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId: "request-duplicate-assignment-create",
        operations: [baseOperations[0]!, createAssignment, createAssignment],
      }),
    ).rejects.toMatchObject({ code: "invalid_operation" });
    expect(compiler).not.toHaveBeenCalled();
    expect((await store.read(PROJECT_ID)).planVersions).toEqual([]);

    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-create-assignment-once",
      operations: baseOperations,
    });
    compiler.mockClear();

    await expect(
      service.apply(identity, {
        schemaVersion: 1,
        planId: created.plan.planId,
        expectedPlanVersion: created.plan.version,
        expectedSource: proposalSource(),
        requestId: "request-recreate-assignment",
        operations: [createAssignment],
      }),
    ).rejects.toMatchObject({ code: "invalid_operation" });
    expect(compiler).not.toHaveBeenCalled();
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);
    expect(await store.read(PROJECT_ID)).toMatchObject({
      currentPlanVersion: 1,
      planVersions: [{ version: 1 }],
      idempotencyReceipts: [{ requestId: "request-create-assignment-once" }],
    });
  });

  it("persists the exact boundary of 128 client-correlated ID mappings", async () => {
    const { service, store } = await fixture();
    const acceptanceCriteria = Array.from({ length: 127 }, (_, index) => ({
      clientRef: `criterion-${index + 1}`,
      ordinal: index + 1,
      description: `Criterion ${index + 1}`,
      verification: `Verify criterion ${index + 1}`,
    }));

    const result = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-mapping-boundary",
      operations: [
        baseOperations[0]!,
        {
          op: "create-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "Exercise the mapping boundary",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                clientRef: "deliverable-boundary",
                description: "Boundary deliverable",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionRefs: [],
              },
            ],
            constraints: [],
            acceptanceCriteria,
            milestoneRefs: [],
            unresolvedDecisions: [],
          },
        },
      ],
    });

    expect(result.idMappings).toHaveLength(128);
    const planning = await store.read(PROJECT_ID);
    expect(planning.planVersions).toHaveLength(1);
    expect(planning.idempotencyReceipts[0]?.result?.idMappings).toHaveLength(
      128,
    );
  });

  it("rejects 129 ID mappings before compilation or persistence", async () => {
    const { service, store, compiler, allocator } = await fixture();
    const acceptanceCriteria = Array.from({ length: 128 }, (_, index) => ({
      clientRef: `criterion-${index + 1}`,
      ordinal: index + 1,
      description: `Criterion ${index + 1}`,
      verification: `Verify criterion ${index + 1}`,
    }));

    await expect(
      service.apply(identity, {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId: "request-mapping-overflow",
        operations: [
          baseOperations[0]!,
          {
            op: "create-agent-assignment",
            assignment: {
              plannedAgentId: AGENT_ID,
              mission: "Exercise mapping overflow",
              scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
              deliverables: [
                {
                  clientRef: "deliverable-overflow",
                  description: "Overflow deliverable",
                  artifactNodeIds: [AGENT_ID],
                  acceptanceCriterionRefs: [],
                },
              ],
              constraints: [],
              acceptanceCriteria,
              milestoneRefs: [],
              unresolvedDecisions: [],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "result_too_large",
      issues: [
        expect.objectContaining({
          path: "operations",
          message: expect.stringContaining("split"),
        }),
      ],
    });
    expect(compiler).not.toHaveBeenCalled();
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);
    expect(await store.read(PROJECT_ID)).toMatchObject({
      planVersions: [],
      idempotencyReceipts: [],
      currentPlanVersion: null,
    });
  });

  it("reads briefs for the exact historical plan and marks current status separately", async () => {
    const { service, compiler } = await fixture();
    compiler.mockImplementation(
      async ({ plan, assignments, currentBriefs }) => {
        const assignment = assignments[0]!;
        const prior = currentBriefs[0];
        return {
          briefs: [
            makeBrief(plan, {
              briefId: assignment.briefId,
              assignmentId: assignment.assignmentId,
              version: (prior ? prior.version + 1 : 1) as never,
              parentVersion: prior?.version ?? null,
              plan: {
                planId: plan.planId,
                version: plan.version,
                semanticDigest: plan.semanticDigest,
              },
              source: plan.source,
              authoredBy: plan.authoredBy,
              createdAt: plan.createdAt,
            }),
          ],
          changes: [
            {
              plannedAgentId: assignment.plannedAgentId,
              change: prior ? "changed" : "created",
            },
          ],
        };
      },
    );
    const first = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-history-v1",
      operations: baseOperations,
    });
    const second = await service.apply(identity, {
      schemaVersion: 1,
      planId: first.plan.planId,
      expectedPlanVersion: 1,
      expectedSource: proposalSource(),
      requestId: "request-history-v2",
      operations: [
        {
          op: "set-project-outcome",
          outcome: { summary: "Ship safely, then verify" },
        },
      ],
    });
    const versionOne = await service.read(identity, {
      schemaVersion: 1,
      plan: { planId: first.plan.planId, version: 1 },
      include: ["brief-summaries"],
    });
    const versionTwo = await service.read(identity, {
      schemaVersion: 1,
      plan: { planId: second.plan.planId, version: 2 },
      include: ["brief-summaries"],
    });
    expect(versionOne).toMatchObject({
      current: false,
      briefs: [{ version: 1, current: false }],
    });
    expect(versionTwo).toMatchObject({
      current: true,
      briefs: [{ version: 2, current: true }],
    });
  });

  it("returns a reread conflict when an initial create loses a race", async () => {
    const { service } = await fixture();
    const create = (requestId: string) =>
      service.apply(identity, {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId,
        operations: baseOperations,
      });
    const outcomes = await Promise.allSettled([
      create("request-race-a"),
      create("request-race-b"),
    ]);
    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const created = outcomes.find((outcome) => outcome.status === "fulfilled");
    expect(created?.status).toBe("fulfilled");
    const createdPlanId =
      created?.status === "fulfilled" ? created.value.plan.planId : "";
    expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
      reason: {
        code: "plan_version_conflict",
        currentPlan: { planId: createdPlanId, version: 1 },
      },
    });
    await expect(create("request-stale-create")).rejects.toMatchObject({
      code: "plan_version_conflict",
      currentPlan: { planId: createdPlanId, version: 1 },
    });
  });

  it("rejects a stale active proposal during validation", async () => {
    const { service, proposalService } = await fixture();
    await proposalService.propose(identity, {
      schemaVersion: 1,
      proposalId: proposalSource().proposalId,
      expectedVersion: 1,
      requestId: "advance-source-before-validation",
      operations: [
        {
          kind: "update-node",
          nodeId: AGENT_ID,
          changes: { name: "New active source" },
        },
      ],
    });
    await expect(
      service.validate(identity, {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        operations: baseOperations,
      }),
    ).rejects.toMatchObject({ code: "source_mismatch" });
  });

  it("applies dependent milestone rewrites in one batch and requires explicit rebase resolutions", async () => {
    const { service, impact, registerGraph } = await fixture();
    const source = proposalSource();
    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: source,
      requestId: "request-create",
      operations: [
        baseOperations[0]!,
        {
          op: "set-repository-intents",
          repositories: [
            {
              repositoryIntentId: "repository-primary",
              plannedAgentId: AGENT_ID,
              action: "create",
              repositoryName: "primary",
              notes: "Owned by the planned agent",
            },
          ],
        },
        {
          op: "create-milestone",
          clientRef: "rebase-milestone",
          milestone: {
            ordinal: 1,
            title: "Implementation",
            outcome: "Feature complete",
            dependsOn: [],
          },
        },
        {
          op: "create-agent-assignment",
          assignment: {
            plannedAgentId: AGENT_ID,
            mission: "Implement the feature",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                clientRef: "rebase-deliverable",
                description: "Produce the owned architecture artifact",
                artifactNodeIds: [AGENT_ID],
                acceptanceCriterionRefs: [],
              },
            ],
            constraints: [],
            acceptanceCriteria: [],
            milestoneRefs: [{ clientRef: "rebase-milestone" }],
            unresolvedDecisions: [],
          },
        },
      ],
    });
    const milestoneId = created.idMappings.find(
      ({ clientRef }) => clientRef === "rebase-milestone",
    )!.id;
    const deliverableId = created.idMappings.find(
      ({ clientRef }) => clientRef === "rebase-deliverable",
    )!.id;
    const assignment = {
      ...baseOperations[1]!.assignment,
      deliverables: [
        {
          deliverableId,
          description: "Produce the owned architecture artifact",
          artifactNodeIds: [AGENT_ID],
          acceptanceCriterionIds: [],
        },
      ],
      milestoneIds: [milestoneId],
    };
    await expect(
      service.apply(identity, {
        schemaVersion: 1,
        planId: created.plan.planId,
        expectedPlanVersion: created.plan.version,
        expectedSource: source,
        requestId: "request-invalid-removal",
        operations: [{ op: "remove-milestone", milestoneId }],
      }),
    ).rejects.toMatchObject({ code: "invalid_operation" });
    const edited = await service.apply(identity, {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: created.plan.version,
      expectedSource: source,
      requestId: "request-atomic-removal",
      operations: [
        {
          op: "upsert-agent-assignment",
          assignment: { ...assignment, milestoneIds: [] },
        },
        { op: "remove-milestone", milestoneId },
      ],
    });
    const revisionSource = {
      kind: "revision" as const,
      revisionId: "revision_00000000-0000-7000-8000-000000000020",
      revisionNumber: 1,
      graphDigest: source.graphDigest,
    };
    const rebased = await service.rebase(identity, {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: edited.plan.version,
      fromSource: source,
      toSource: revisionSource,
      requestId: "request-rebase",
      resolutions: [],
    });
    expect(rebased.plan.version).toBe(3);
    expect(rebased.plan.semanticDigest).toBe(edited.plan.semanticDigest);
    const remappedGraph: AgentMapGraph = {
      nodes: [
        {
          ...graph.nodes[0]!,
          id: SECOND_AGENT_ID,
          name: "Replacement builder",
        },
      ],
      relationships: [],
    };
    registerGraph(remappedGraph);
    const remappedSource = {
      ...revisionSource,
      revisionNumber: 2,
      graphDigest: computeArchitectureGraphDigest(remappedGraph),
    };
    await expect(
      service.rebase(identity, {
        schemaVersion: 1,
        planId: created.plan.planId,
        expectedPlanVersion: rebased.plan.version,
        fromSource: revisionSource,
        toSource: remappedSource,
        requestId: "request-unresolved-rebase",
        resolutions: [
          {
            kind: "remap-agent",
            fromPlannedAgentId: AGENT_ID,
            toPlannedAgentId: SECOND_AGENT_ID,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "rebase_conflict" });
    const remapped = await service.rebase(identity, {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: rebased.plan.version,
      fromSource: revisionSource,
      toSource: remappedSource,
      requestId: "request-remapped-rebase",
      resolutions: [
        {
          kind: "remap-agent",
          fromPlannedAgentId: AGENT_ID,
          toPlannedAgentId: SECOND_AGENT_ID,
        },
        {
          kind: "remap-repository-intent",
          repositoryIntentId: "repository-primary",
          toPlannedAgentId: SECOND_AGENT_ID,
        },
        {
          kind: "remap-artifact-reference",
          plannedAgentId: SECOND_AGENT_ID,
          deliverableId,
          fromNodeId: AGENT_ID,
          toNodeId: SECOND_AGENT_ID,
        },
      ],
    });
    const remappedPlan = await service.read(identity, {
      schemaVersion: 1,
      include: ["plan"],
    });
    expect(remappedPlan.state).toMatchObject({
      assignments: [
        {
          plannedAgentId: SECOND_AGENT_ID,
          deliverables: [{ artifactNodeIds: [SECOND_AGENT_ID] }],
        },
      ],
      repositoryIntents: [{ plannedAgentId: SECOND_AGENT_ID }],
    });

    const emptySource = {
      ...revisionSource,
      revisionNumber: 3,
      graphDigest: computeArchitectureGraphDigest({
        nodes: [],
        relationships: [],
      }),
    };
    await expect(
      service.rebase(identity, {
        schemaVersion: 1,
        planId: created.plan.planId,
        expectedPlanVersion: remapped.plan.version,
        fromSource: remappedSource,
        toSource: emptySource,
        requestId: "request-resolved-rebase",
        resolutions: [
          {
            kind: "remove-assignment",
            plannedAgentId: SECOND_AGENT_ID,
          },
          {
            kind: "remove-repository-intent",
            repositoryIntentId: "repository-primary",
          },
        ],
      }),
    ).resolves.toMatchObject({ plan: { version: 5 } });
    expect(impact).toHaveBeenCalledTimes(3);
  });

  it("denies builder identities even when model input contains no scope fields", async () => {
    const { service } = await fixture();
    await expect(
      service.validate(
        {
          ...identity,
          role: "agent-builder",
          assignment: { kind: "unplanned" },
        },
        {
          schemaVersion: 1,
          planId: null,
          expectedPlanVersion: null,
          expectedSource: proposalSource(),
          operations: baseOperations,
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden_role" });
  });

  it("fails closed when the active proposal changes after source validation", async () => {
    const { service, proposalService, onResolve, allocator, store } =
      await fixture();
    let raceError: unknown;
    onResolve(async (count) => {
      if (count !== 2) return;
      try {
        await proposalService.propose(identity, {
          schemaVersion: 1,
          proposalId: proposalSource().proposalId,
          expectedVersion: 1,
          requestId: "race-source-update",
          operations: [
            {
              kind: "update-node",
              nodeId: AGENT_ID,
              changes: { name: "Changed during compilation" },
            },
          ],
        });
      } catch (error) {
        raceError = error;
      }
    });
    const failure = await service
      .apply(identity, {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId: "request-source-race",
        operations: baseOperations,
      })
      .catch((error: unknown) => error);
    expect(raceError).toBeUndefined();
    expect((await proposalService.read(PROJECT_ID)).proposal?.version).toBe(2);
    expect((await store.read(PROJECT_ID)).planVersions).toEqual([]);
    expect(failure).toMatchObject({
      code: "plan_version_conflict",
      issues: [],
    });
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it("does not consume durable allocators when compilation fails", async () => {
    const { service, compiler, allocator, store } = await fixture();
    compiler.mockRejectedValueOnce(new Error("compiler failed"));
    await expect(
      service.apply(identity, {
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId: "request-compiler-failure",
        operations: baseOperations,
      }),
    ).rejects.toThrow("compiler failed");
    expect((await store.read(PROJECT_ID)).planVersions).toEqual([]);
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it("leaves no receipt or version after an aggregate failure and permits retry", async () => {
    let fail = false;
    const { service, store, allocator } = await fixture((step) => {
      if (fail && step === "rename") throw new Error("injected write failure");
    });
    fail = true;
    const request = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-retry",
      operations: baseOperations,
    };
    await expect(service.apply(identity, request)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(await store.read(PROJECT_ID)).toMatchObject({
      planVersions: [],
      idempotencyReceipts: [],
    });
    expect(
      Object.values(allocator).every(
        (allocate) => allocate.mock.calls.length === 0,
      ),
    ).toBe(true);
    fail = false;
    await expect(service.apply(identity, request)).resolves.toMatchObject({
      plan: { version: 1 },
      replayed: false,
    });
  });

  it("persists real compiler output and returns the canonical rebound impact", async () => {
    const { store, resolver } = await fixture();
    const service = new BuildPlanService({
      store,
      sourceResolver: resolver,
      contractValidator: new BuildPlanContractValidator(resolver),
      briefCompiler: new DeterministicAgentBriefCompiler(),
      impactEvaluator: new CanonicalBuildPlanImpactEvaluator(),
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
    });
    const operations = [
      baseOperations[0]!,
      {
        op: "create-agent-assignment" as const,
        assignment: {
          plannedAgentId: AGENT_ID,
          mission: "Implement the feature",
          scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
          deliverables: [
            {
              clientRef: "production-deliverable",
              description: "A tested implementation plan",
              artifactNodeIds: [],
              acceptanceCriterionRefs: [{ clientRef: "production-criterion" }],
            },
          ],
          constraints: [],
          acceptanceCriteria: [
            {
              clientRef: "production-criterion",
              ordinal: 1,
              description: "The plan is verifiable",
              verification: "Run the compiler suite",
            },
          ],
          milestoneRefs: [],
          unresolvedDecisions: [],
        },
      },
    ];
    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "production-create",
      operations,
    });
    expect(created.impact).toMatchObject({ semanticChange: true });
    expect(
      Object.values((await store.read(PROJECT_ID)).briefVersionsById)[0],
    ).toHaveLength(1);

    const revisionSource = {
      kind: "revision" as const,
      revisionId: "revision_00000000-0000-7000-8000-000000000023" as never,
      revisionNumber: 1,
      graphDigest: proposalSource().graphDigest,
    };
    const rebased = await service.rebase(identity, {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: created.plan.version,
      fromSource: proposalSource(),
      toSource: revisionSource,
      requestId: "production-rebase",
      resolutions: [],
    });
    expect(rebased.impact).toMatchObject({
      semanticChange: false,
      staleBriefIds: [],
      preservedBriefIds: [
        (await store.read(PROJECT_ID)).currentBriefByAgentId[AGENT_ID]!.briefId,
      ],
    });
    const persisted = await store.read(PROJECT_ID);
    expect(Object.values(persisted.briefVersionsById)[0]).toHaveLength(2);
    expect(Object.values(persisted.briefVersionsById)[0]![1]).toMatchObject({
      source: revisionSource,
      version: 2,
    });
    await expect(
      service.rebase(identity, {
        schemaVersion: 1,
        planId: created.plan.planId,
        expectedPlanVersion: created.plan.version,
        fromSource: proposalSource(),
        toSource: revisionSource,
        requestId: "production-rebase",
        resolutions: [],
      }),
    ).resolves.toEqual({ ...rebased, replayed: true });
  });

  it("persists real compiler briefs across a third-agent-owned relay", async () => {
    const { store } = await fixture();
    const relay = stockResearchRelayFixture();
    const source = {
      kind: "revision" as const,
      revisionId: "revision_10000000-0000-7000-8000-000000000041" as never,
      revisionNumber: 1,
      graphDigest: computeArchitectureGraphDigest(relay.graph),
    };
    const resolver = {
      resolve: async () => ({
        projectId: PROJECT_ID,
        source,
        graph: relay.graph,
      }),
    };
    const service = new BuildPlanService({
      store,
      sourceResolver: resolver,
      contractValidator: new BuildPlanContractValidator(resolver),
      briefCompiler: new DeterministicAgentBriefCompiler(),
      impactEvaluator: new CanonicalBuildPlanImpactEvaluator(),
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
    });

    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: source,
      requestId: "relay-create",
      operations: [
        { op: "set-project-outcome", outcome: relay.plan.outcome },
        ...relay.plan.assignments.map((assignment) => ({
          op: "create-agent-assignment" as const,
          assignment: {
            plannedAgentId: assignment.plannedAgentId,
            mission: assignment.mission,
            scope: assignment.scope,
            deliverables: assignment.deliverables.map((deliverable) => ({
              clientRef: `deliverable-${assignment.plannedAgentId}`,
              description: deliverable.description,
              artifactNodeIds: deliverable.artifactNodeIds,
              acceptanceCriterionRefs: [
                { clientRef: `criterion-${assignment.plannedAgentId}` },
              ],
            })),
            constraints: assignment.constraints,
            acceptanceCriteria: assignment.acceptanceCriteria.map(
              (criterion) => ({
                clientRef: `criterion-${assignment.plannedAgentId}`,
                ordinal: criterion.ordinal,
                description: criterion.description,
                verification: criterion.verification,
              }),
            ),
            milestoneRefs: [],
            unresolvedDecisions: [],
          },
        })),
      ],
    });

    expect(created).toMatchObject({
      completeness: { status: "complete", issues: [] },
      eligibility: {
        planningEligible: true,
        implementationEligible: true,
      },
    });
    expect(created.briefChanges).toHaveLength(3);
    expect(
      Object.keys((await store.read(PROJECT_ID)).currentBriefByAgentId).sort(),
    ).toEqual(relay.plan.assignments.map((item) => item.plannedAgentId).sort());
  });

  it("validates effective two-agent briefs while persisting only semantic changes", async () => {
    const { store } = await fixture();
    const graph = stockResearchGraph();
    const source = {
      kind: "revision" as const,
      revisionId: "revision_10000000-0000-7000-8000-000000000031" as never,
      revisionNumber: 1,
      graphDigest: computeArchitectureGraphDigest(graph),
    };
    const resolver = {
      resolve: async () => ({ projectId: PROJECT_ID, source, graph }),
    };
    const service = new BuildPlanService({
      store,
      sourceResolver: resolver,
      contractValidator: new BuildPlanContractValidator(resolver),
      briefCompiler: new DeterministicAgentBriefCompiler(),
      impactEvaluator: new CanonicalBuildPlanImpactEvaluator(),
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
    });
    const fixturePlan = stockResearchPlan(graph);
    const assignments = fixturePlan.assignments.map((entry) => ({
      ...entry,
      milestoneIds: [],
    }));
    const created = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: source,
      requestId: "two-agent-create",
      operations: [
        { op: "set-project-outcome", outcome: fixturePlan.outcome },
        ...assignments.map((assignment) => ({
          op: "create-agent-assignment" as const,
          assignment: {
            plannedAgentId: assignment.plannedAgentId,
            mission: assignment.mission,
            scope: assignment.scope,
            deliverables: assignment.deliverables.map((deliverable) => ({
              clientRef: `deliverable-${assignment.plannedAgentId}`,
              description: deliverable.description,
              artifactNodeIds: deliverable.artifactNodeIds,
              acceptanceCriterionRefs: [
                { clientRef: `criterion-${assignment.plannedAgentId}` },
              ],
            })),
            constraints: assignment.constraints,
            acceptanceCriteria: assignment.acceptanceCriteria.map(
              (criterion) => ({
                clientRef: `criterion-${assignment.plannedAgentId}`,
                ordinal: criterion.ordinal,
                description: criterion.description,
                verification: criterion.verification,
              }),
            ),
            milestoneRefs: [],
            unresolvedDecisions: [],
          },
        })),
      ],
    });
    const initial = await store.read(PROJECT_ID);
    const researchBriefId = initial.currentBriefByAgentId[RESEARCH_ID]!.briefId;
    const marketingBriefId =
      initial.currentBriefByAgentId[MARKETING_ID]!.briefId;
    const marketing = initial.planVersions
      .at(-1)!
      .assignments.find((entry) => entry.plannedAgentId === MARKETING_ID)!;
    const changed = await service.apply(identity, {
      schemaVersion: 1,
      planId: created.plan.planId,
      expectedPlanVersion: created.plan.version,
      expectedSource: source,
      requestId: "two-agent-marketing-change",
      operations: [
        {
          op: "upsert-agent-assignment",
          assignment: { ...marketing, mission: "Publish a revised campaign" },
        },
      ],
    });
    expect(changed).toMatchObject({
      plan: { version: 2 },
      completeness: { status: "complete" },
      eligibility: {
        planningEligible: true,
        implementationEligible: true,
      },
      briefChanges: expect.arrayContaining([
        { plannedAgentId: RESEARCH_ID, change: "preserved" },
        { plannedAgentId: MARKETING_ID, change: "changed" },
      ]),
    });
    const afterChange = await store.read(PROJECT_ID);
    expect(afterChange.currentBriefByAgentId).toMatchObject({
      [RESEARCH_ID]: { briefId: researchBriefId, version: 1 },
      [MARKETING_ID]: { briefId: marketingBriefId, version: 2 },
    });
    expect(afterChange.briefVersionsById[researchBriefId]).toHaveLength(1);
    expect(afterChange.briefVersionsById[marketingBriefId]).toHaveLength(2);
    expect(afterChange.idempotencyReceipts.at(-1)?.result?.impact).toEqual(
      changed.impact,
    );

    const unchanged = await service.apply(identity, {
      schemaVersion: 1,
      planId: changed.plan.planId,
      expectedPlanVersion: changed.plan.version,
      expectedSource: source,
      requestId: "two-agent-unchanged",
      operations: [{ op: "set-project-outcome", outcome: fixturePlan.outcome }],
    });
    expect(unchanged.completeness.status).toBe("complete");
    const afterUnchanged = await store.read(PROJECT_ID);
    expect(afterUnchanged.briefVersionsById[researchBriefId]).toHaveLength(1);
    expect(afterUnchanged.briefVersionsById[marketingBriefId]).toHaveLength(2);
  });
});
