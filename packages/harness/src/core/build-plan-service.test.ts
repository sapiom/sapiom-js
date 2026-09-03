import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import type { ArchitectureSourceRef } from "../shared/build-plan.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { BuildPlanContractValidator } from "./build-plan-contract-validator.js";
import {
  type AgentBriefCompiler,
  BuildPlanService,
} from "./build-plan-service.js";
import { BuildPlanStore } from "./build-plan-store.js";
import { computeArchitectureGraphDigest } from "./build-plan-canonicalization.js";
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
    const store = new BuildPlanStore(workspace, {
      allocator: {
        allocateBuildPlanId: () => PLAN_ID,
        allocateBriefId: () => BRIEF_ID,
        allocateAssignmentId: () => ASSIGNMENT_ID,
      },
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });
    const resolver = {
      resolve: async (projectId: string, source: ArchitectureSourceRef) => {
        if (projectId !== PROJECT_ID) throw new Error("cross project");
        return {
          projectId: PROJECT_ID,
          source,
          graph:
            source.graphDigest === computeArchitectureGraphDigest(graph)
              ? graph
              : { nodes: [], relationships: [] },
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
    await workspace.readOrCreate(PROJECT_ID);
    return { service, store, compiler, impact };
  }

  it("validates initial creation without allocating or persisting, then applies atomically", async () => {
    const { service, store, compiler } = await fixture();
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

    const applied = await service.apply(identity, {
      ...request,
      requestId: "request-create",
    });
    expect(applied).toMatchObject({
      plan: { planId: PLAN_ID, version: 1 },
      briefChanges: [{ plannedAgentId: AGENT_ID, change: "created" }],
      replayed: false,
    });
    const persisted = await store.read(PROJECT_ID);
    expect(persisted.planVersions).toHaveLength(1);
    expect(persisted.currentBriefByAgentId[AGENT_ID]).toMatchObject({
      briefId: BRIEF_ID,
      version: 1,
    });
    await expect(
      service.read(identity, {
        schemaVersion: 1,
        plan: { planId: PLAN_ID, version: 1 },
        include: ["assignment-intents", "history-summary"],
      }),
    ).resolves.toMatchObject({
      plan: { planId: PLAN_ID, version: 1 },
      assignmentIntents: [{ plannedAgentId: AGENT_ID }],
      history: { versionCount: 1, currentVersion: 1 },
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
    await service.apply(identity, request);
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
        planId: PLAN_ID,
        expectedPlanVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "plan_version_conflict" });
    await expect(
      service.apply(identity, {
        ...request,
        requestId: "request-source-mismatch",
        planId: PLAN_ID,
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

  it("applies dependent milestone rewrites in one batch and requires explicit rebase resolutions", async () => {
    const { service, impact } = await fixture();
    const source = proposalSource();
    const milestoneId = "milestone_00000000-0000-7000-8000-000000000010";
    const assignment = {
      ...baseOperations[1]!.assignment,
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
        planId: PLAN_ID,
        expectedPlanVersion: created.plan.version,
        expectedSource: source,
        requestId: "request-invalid-removal",
        operations: [{ op: "remove-milestone", milestoneId }],
      }),
    ).rejects.toMatchObject({ code: "invalid_operation" });
    const edited = await service.apply(identity, {
      schemaVersion: 1,
      planId: PLAN_ID,
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
      planId: PLAN_ID,
      expectedPlanVersion: edited.plan.version,
      fromSource: source,
      toSource: revisionSource,
      requestId: "request-rebase",
      resolutions: [],
    });
    expect(rebased.plan.version).toBe(3);
    expect(rebased.plan.semanticDigest).toBe(edited.plan.semanticDigest);
    const emptySource = {
      ...revisionSource,
      revisionNumber: 2,
      graphDigest: computeArchitectureGraphDigest({
        nodes: [],
        relationships: [],
      }),
    };
    await expect(
      service.rebase(identity, {
        schemaVersion: 1,
        planId: PLAN_ID,
        expectedPlanVersion: rebased.plan.version,
        fromSource: revisionSource,
        toSource: emptySource,
        requestId: "request-unresolved-rebase",
        resolutions: [],
      }),
    ).rejects.toMatchObject({ code: "rebase_conflict" });
    await expect(
      service.rebase(identity, {
        schemaVersion: 1,
        planId: PLAN_ID,
        expectedPlanVersion: rebased.plan.version,
        fromSource: revisionSource,
        toSource: emptySource,
        requestId: "request-resolved-rebase",
        resolutions: [{ kind: "remove-assignment", plannedAgentId: AGENT_ID }],
      }),
    ).resolves.toMatchObject({ plan: { version: 4 } });
    expect(impact).toHaveBeenCalledTimes(2);
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

  it("leaves no receipt or version after an aggregate failure and permits retry", async () => {
    let fail = false;
    const { service, store } = await fixture((step) => {
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
    fail = false;
    await expect(service.apply(identity, request)).resolves.toMatchObject({
      plan: { version: 1 },
      replayed: false,
    });
  });
});
