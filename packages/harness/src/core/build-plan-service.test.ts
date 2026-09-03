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
import type { ArchitectureSourceRef } from "../shared/build-plan.js";
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
      idFactory: store,
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
      briefs: currentBriefs,
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

  it("allocates canonical subrecord IDs from bounded client correlations", async () => {
    const { service, allocator, store } = await fixture();
    const result = await service.apply(identity, {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      requestId: "request-client-correlations",
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
    });
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
    const milestoneId = "milestone_00000000-0000-7000-8000-000000000010";
    const deliverableId = "deliverable_00000000-0000-7000-8000-000000000011";
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
          op: "upsert-milestone",
          milestone: {
            milestoneId,
            ordinal: 1,
            title: "Implementation",
            outcome: "Feature complete",
            dependsOn: [],
          },
        },
        { op: "upsert-agent-assignment", assignment },
      ],
    });
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
      idFactory: store,
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
    });
    const operations = [
      baseOperations[0]!,
      {
        op: "upsert-agent-assignment" as const,
        assignment: {
          ...baseOperations[1]!.assignment,
          deliverables: [
            {
              deliverableId:
                "deliverable_00000000-0000-7000-8000-000000000021",
              description: "A tested implementation plan",
              artifactNodeIds: [],
              acceptanceCriterionIds: [
                "criterion_00000000-0000-7000-8000-000000000022",
              ],
            },
          ],
          acceptanceCriteria: [
            {
              criterionId:
                "criterion_00000000-0000-7000-8000-000000000022",
              ordinal: 1,
              description: "The plan is verifiable",
              verification: "Run the compiler suite",
            },
          ],
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
    expect(Object.values((await store.read(PROJECT_ID)).briefVersionsById)[0]).toHaveLength(1);

    const revisionSource = {
      kind: "revision" as const,
      revisionId:
        "revision_00000000-0000-7000-8000-000000000023" as never,
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

  it("validates effective two-agent briefs while persisting only semantic changes", async () => {
    const { store } = await fixture();
    const graph = stockResearchGraph();
    const source = {
      kind: "revision" as const,
      revisionId:
        "revision_10000000-0000-7000-8000-000000000031" as never,
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
      idFactory: store,
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
          op: "upsert-agent-assignment" as const,
          assignment,
        })),
      ],
    });
    const initial = await store.read(PROJECT_ID);
    const researchBriefId = initial.currentBriefByAgentId[RESEARCH_ID]!.briefId;
    const marketingBriefId = initial.currentBriefByAgentId[MARKETING_ID]!.briefId;
    const marketing = assignments.find(
      (entry) => entry.plannedAgentId === MARKETING_ID,
    )!;
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
      operations: [
        { op: "set-project-outcome", outcome: fixturePlan.outcome },
      ],
    });
    expect(unchanged.completeness.status).toBe("complete");
    const afterUnchanged = await store.read(PROJECT_ID);
    expect(afterUnchanged.briefVersionsById[researchBriefId]).toHaveLength(1);
    expect(afterUnchanged.briefVersionsById[marketingBriefId]).toHaveLength(2);
  });
});
