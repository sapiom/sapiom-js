import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentBriefId,
  AgentBriefVersion,
  AgentBriefVersionRecord,
  BuildPlanRef,
  BuilderPlanningSubmission,
  BuilderPlanningSubmissionId,
  PlanningAssignmentId,
} from "../shared/build-plan.js";
import type { BuildPlanVersion } from "../shared/build-plan.js";
import {
  AGENT_ID,
  ASSIGNMENT_ID,
  BRIEF_ID,
  graph,
  makeBrief,
  makePlan,
  PROJECT_ID,
  proposalSource,
} from "./build-plan.test-support.js";
import { AgentMapWorkspaceStore } from "./agent-map-workspace-store.js";
import { BuildPlanStore } from "./build-plan-store.js";
import {
  computeArchitectureGraphDigest,
  computePlanningSubmissionRecordDigest,
  computePlanningSubmissionSemanticDigest,
} from "./build-plan-canonicalization.js";

const request = {
  sessionId: "session-1",
  requestId: "request-1",
  requestDigest: `sha256:${"a".repeat(64)}`,
};

describe("BuildPlanStore", () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
  );
  async function fixture(
    options: ConstructorParameters<typeof AgentMapWorkspaceStore>[1] = {},
    buildPlanOptions: ConstructorParameters<typeof BuildPlanStore>[1] = {},
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-plan-store-"));
    roots.push(root);
    const workspaceStore = new AgentMapWorkspaceStore(root, options);
    const buildPlanStore = new BuildPlanStore(workspaceStore, {
      ...buildPlanOptions,
      allocator: buildPlanOptions.allocator ?? {
        allocateBuildPlanId: () => makePlan().planId,
        allocateBriefId: () => BRIEF_ID as AgentBriefId,
        allocateAssignmentId: () => ASSIGNMENT_ID as PlanningAssignmentId,
      },
      now: buildPlanOptions.now ?? (() => new Date("2026-09-03T09:05:00.000Z")),
    });
    return { root, workspaceStore, buildPlanStore };
  }

  function submissionFor(
    plan: BuildPlanRef,
    brief: AgentBriefVersionRecord,
    overrides: Partial<BuilderPlanningSubmission> = {},
  ): BuilderPlanningSubmission {
    const draft = {
      schemaVersion: 1,
      submissionId:
        "submission_00000000-0000-7000-8000-000000000008" as BuilderPlanningSubmissionId,
      projectId: PROJECT_ID,
      assignmentId: brief.assignmentId,
      sessionId: "builder-session-1",
      source: brief.source,
      plan,
      brief: {
        briefId: brief.briefId,
        version: brief.version,
        semanticDigest: brief.semanticDigest,
      },
      status: "ready",
      implementationPlan: [
        {
          stepId: "step-1",
          ordinal: 1,
          description: "Implement",
          verification: "Run tests",
        },
      ],
      risks: [],
      questions: [],
      proposedMapOperationIds: [],
      supersedesSubmissionId: null,
      semanticDigest: `sha256:${"0".repeat(64)}`,
      recordDigest: `sha256:${"0".repeat(64)}`,
      submittedAt: "2026-09-03T09:10:00.000Z",
      ...overrides,
    } as unknown as BuilderPlanningSubmission;
    draft.semanticDigest = computePlanningSubmissionSemanticDigest(draft);
    draft.recordDigest = computePlanningSubmissionRecordDigest(draft);
    return draft;
  }

  it("persists stable assignments, immutable brief history, replay, and restart", async () => {
    const { root, buildPlanStore } = await fixture();
    const plan = makePlan();
    const first = await buildPlanStore.commitPlanVersion(plan, graph, request);
    const replay = await buildPlanStore.commitPlanVersion(plan, graph, request);
    const brief = makeBrief(plan, {
      briefId: first.assignments[0]!.briefId,
      assignmentId: first.assignments[0]!.assignmentId,
    });
    await buildPlanStore.commitBriefVersions(PROJECT_ID, first.plan, [brief]);
    const submission = {
      schemaVersion: 1,
      submissionId:
        "submission_00000000-0000-7000-8000-000000000008" as BuilderPlanningSubmissionId,
      projectId: PROJECT_ID,
      assignmentId: first.assignments[0]!.assignmentId,
      sessionId: "builder-session-1",
      source: plan.source,
      plan: first.plan,
      brief: {
        briefId: brief.briefId,
        version: brief.version,
        semanticDigest: brief.semanticDigest,
      },
      status: "ready",
      implementationPlan: [
        {
          stepId: "step-1",
          ordinal: 1,
          description: "Implement",
          verification: "Run tests",
        },
      ],
      risks: [],
      questions: [],
      proposedMapOperationIds: [],
      supersedesSubmissionId: null,
      semanticDigest: `sha256:${"0".repeat(64)}`,
      recordDigest: `sha256:${"0".repeat(64)}`,
      submittedAt: "2026-09-03T09:10:00.000Z",
    } as unknown as BuilderPlanningSubmission;
    submission.semanticDigest =
      computePlanningSubmissionSemanticDigest(submission);
    submission.recordDigest = computePlanningSubmissionRecordDigest(submission);
    await buildPlanStore.commitSubmission(submission);

    const restarted = new BuildPlanStore(new AgentMapWorkspaceStore(root));
    const planning = await restarted.read(PROJECT_ID);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(planning.planVersions).toHaveLength(1);
    expect(planning.briefVersionsById[BRIEF_ID]).toEqual([brief]);
    expect(planning.submissionsByAssignmentId[ASSIGNMENT_ID]).toEqual([
      submission,
    ]);
    expect(await restarted.readPlanForProject(PROJECT_ID, first.plan)).toEqual(
      plan,
    );
    expect(
      await restarted.readBriefForProject(
        PROJECT_ID,
        planning.currentBriefByAgentId[AGENT_ID]!,
      ),
    ).toEqual(brief);
  });

  it("revalidates record integrity when the on-disk file changes", async () => {
    const { root, workspaceStore, buildPlanStore } = await fixture();
    await buildPlanStore.commitPlanVersion(makePlan(), graph, request);
    const file = path.join(root, "projects", PROJECT_ID, "workspace.json");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
      buildPlanning: { planVersions: Array<{ outcome: { summary: string } }> };
    };
    persisted.buildPlanning.planVersions[0]!.outcome.summary = "Tampered";
    await fs.writeFile(file, `${JSON.stringify(persisted)}\n`);

    await expect(
      workspaceStore.readAggregate(PROJECT_ID),
    ).rejects.toMatchObject({
      code: "malformed_state",
    });
  });

  it("detects same-size tampering when file identity metadata is restored", async () => {
    const { root, workspaceStore, buildPlanStore } = await fixture();
    await buildPlanStore.commitPlanVersion(makePlan(), graph, request);
    const file = path.join(root, "projects", PROJECT_ID, "workspace.json");
    const fixedTime = new Date("2026-09-03T10:00:00.000Z");
    await fs.utimes(file, fixedTime, fixedTime);
    await workspaceStore.readAggregate(PROJECT_ID);

    const before = await fs.stat(file, { bigint: true });
    const raw = await fs.readFile(file, "utf8");
    const tampered = raw.replace(
      "Ship a durable product",
      "Hack a durable product",
    );
    expect(tampered).not.toBe(raw);
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(raw));
    await fs.writeFile(file, tampered);
    await fs.utimes(file, fixedTime, fixedTime);
    const after = await fs.stat(file, { bigint: true });
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);

    await expect(
      workspaceStore.readAggregate(PROJECT_ID),
    ).rejects.toMatchObject({ code: "malformed_state" });
  });

  it("retires and restores the same assignment identity without erasing history", async () => {
    const { buildPlanStore } = await fixture();
    const first = makePlan();
    await buildPlanStore.commitPlanVersion(first, graph, request);
    const removed = makePlan({
      version: 2 as BuildPlanVersion,
      parentVersion: 1 as BuildPlanVersion,
      changeKind: "edited",
      assignments: [],
      outcome: { summary: "No independent builders" },
      source: {
        ...proposalSource(),
        version: 2,
        graphDigest: computeArchitectureGraphDigest({
          nodes: [],
          relationships: [],
        }),
      },
    });
    await buildPlanStore.commitPlanVersion(
      removed,
      { nodes: [], relationships: [] },
      {
        ...request,
        requestId: "request-2",
        requestDigest: `sha256:${"b".repeat(64)}`,
      },
    );
    const restored = makePlan({
      version: 3 as BuildPlanVersion,
      parentVersion: 2 as BuildPlanVersion,
      changeKind: "restored",
      outcome: { summary: "Restore the builder" },
      source: { ...proposalSource(), version: 3 },
    });
    await buildPlanStore.commitPlanVersion(restored, graph, {
      ...request,
      requestId: "request-3",
      requestDigest: `sha256:${"c".repeat(64)}`,
    });

    expect(
      (await buildPlanStore.read(PROJECT_ID)).assignmentByAgentId[AGENT_ID],
    ).toMatchObject({
      assignmentId: ASSIGNMENT_ID,
      briefId: BRIEF_ID,
      status: "active",
      retiredAt: null,
    });
  });

  it("rejects a delayed brief compiler after the current plan advances", async () => {
    const { buildPlanStore } = await fixture();
    const firstPlan = makePlan();
    const first = await buildPlanStore.commitPlanVersion(
      firstPlan,
      graph,
      request,
    );
    const delayedBrief = makeBrief(firstPlan, {
      briefId: first.assignments[0]!.briefId,
      assignmentId: first.assignments[0]!.assignmentId,
    });
    const secondPlan = makePlan({
      version: 2 as BuildPlanVersion,
      parentVersion: 1 as BuildPlanVersion,
      changeKind: "edited",
      source: { ...proposalSource(), version: 2 },
    });
    await buildPlanStore.commitPlanVersion(secondPlan, graph, {
      ...request,
      requestId: "request-2",
      requestDigest: `sha256:${"b".repeat(64)}`,
    });

    await expect(
      buildPlanStore.commitBriefVersions(PROJECT_ID, first.plan, [
        delayedBrief,
      ]),
    ).rejects.toMatchObject({ code: "version_conflict" });
    expect(
      (await buildPlanStore.read(PROJECT_ID)).currentBriefByAgentId,
    ).toEqual({});
  });

  it("fails closed when an exact idempotency receipt ages into a tombstone", async () => {
    const { buildPlanStore } = await fixture({}, { receiptRetentionLimit: 1 });
    const firstPlan = makePlan();
    await buildPlanStore.commitPlanVersion(firstPlan, graph, request);
    const secondPlan = makePlan({
      version: 2 as BuildPlanVersion,
      parentVersion: 1 as BuildPlanVersion,
      changeKind: "edited",
      source: { ...proposalSource(), version: 2 },
    });
    await buildPlanStore.commitPlanVersion(secondPlan, graph, {
      ...request,
      requestId: "request-2",
      requestDigest: `sha256:${"b".repeat(64)}`,
    });

    await expect(
      buildPlanStore.commitPlanVersion(firstPlan, graph, request),
    ).rejects.toMatchObject({ code: "request_id_expired" });
    await expect(
      buildPlanStore.commitPlanVersion(firstPlan, graph, {
        ...request,
        requestDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "request_id_expired" });
    expect(
      (await buildPlanStore.read(PROJECT_ID)).idempotencyTombstones,
    ).toEqual([{ sessionId: request.sessionId, requestId: request.requestId }]);
  });

  it("reports explicit limits without allocating another durable version", async () => {
    const { buildPlanStore } = await fixture(
      {},
      { historyLimits: { planVersions: 1 } },
    );
    await buildPlanStore.commitPlanVersion(makePlan(), graph, request);
    const secondPlan = makePlan({
      version: 2 as BuildPlanVersion,
      parentVersion: 1 as BuildPlanVersion,
      changeKind: "edited",
      source: { ...proposalSource(), version: 2 },
    });

    await expect(
      buildPlanStore.commitPlanVersion(secondPlan, graph, {
        ...request,
        requestId: "request-2",
      }),
    ).rejects.toMatchObject({
      code: "history_limit_exceeded",
      historyKind: "plan-versions",
      limit: 1,
    });
    expect((await buildPlanStore.read(PROJECT_ID)).planVersions).toHaveLength(
      1,
    );
  });

  it("enforces brief history limits inside an atomic plan commit", async () => {
    const { root, workspaceStore, buildPlanStore } = await fixture(
      {},
      { historyLimits: { briefVersions: 1 } },
    );
    const firstPlan = makePlan();
    const firstBrief = makeBrief(firstPlan);
    await buildPlanStore.commitPlanVersion(firstPlan, graph, request, {
      briefs: [firstBrief],
    });
    const secondPlan = makePlan({
      version: 2 as BuildPlanVersion,
      parentVersion: 1 as BuildPlanVersion,
      changeKind: "edited",
      outcome: { summary: "A second atomic plan version" },
    });
    const secondBrief = makeBrief(secondPlan, {
      version: 2 as AgentBriefVersion,
      parentVersion: 1 as AgentBriefVersion,
    });
    const before = await workspaceStore.readAggregate(PROJECT_ID);
    const file = path.join(root, "projects", PROJECT_ID, "workspace.json");
    const durableBefore = await fs.readFile(file, "utf8");

    await expect(
      buildPlanStore.commitPlanVersion(
        secondPlan,
        graph,
        {
          ...request,
          requestId: "request-atomic-brief-limit",
          requestDigest: `sha256:${"b".repeat(64)}`,
        },
        { briefs: [secondBrief] },
      ),
    ).rejects.toMatchObject({
      code: "history_limit_exceeded",
      historyKind: "brief-versions",
      limit: 1,
    });

    expect(await workspaceStore.readAggregate(PROJECT_ID)).toEqual(before);
    expect(await fs.readFile(file, "utf8")).toBe(durableBefore);
    expect(before.buildPlanning).toMatchObject({
      currentPlanVersion: 1,
      planVersions: [{ version: 1 }],
      currentBriefByAgentId: { [AGENT_ID]: { version: 1 } },
      briefVersionsById: { [BRIEF_ID]: [{ version: 1 }] },
      idempotencyReceipts: [{ requestId: request.requestId }],
    });
  });

  it("reports explicit brief and submission history limits", async () => {
    const briefFixture = await fixture(
      {},
      { historyLimits: { briefVersions: 1 } },
    );
    const briefPlan = makePlan();
    const briefCommit = await briefFixture.buildPlanStore.commitPlanVersion(
      briefPlan,
      graph,
      request,
    );
    const firstBrief = makeBrief(briefPlan, {
      briefId: briefCommit.assignments[0]!.briefId,
      assignmentId: briefCommit.assignments[0]!.assignmentId,
    });
    await briefFixture.buildPlanStore.commitBriefVersions(
      PROJECT_ID,
      briefCommit.plan,
      [firstBrief],
    );
    const secondBrief = makeBrief(briefPlan, {
      ...firstBrief,
      version: 2 as AgentBriefVersion,
      parentVersion: 1 as AgentBriefVersion,
    });
    await expect(
      briefFixture.buildPlanStore.commitBriefVersions(
        PROJECT_ID,
        briefCommit.plan,
        [secondBrief],
      ),
    ).rejects.toMatchObject({
      code: "history_limit_exceeded",
      historyKind: "brief-versions",
      limit: 1,
    });

    const submissionFixture = await fixture(
      {},
      { historyLimits: { planningSubmissions: 1 } },
    );
    const submissionPlan = makePlan();
    const submissionCommit =
      await submissionFixture.buildPlanStore.commitPlanVersion(
        submissionPlan,
        graph,
        request,
      );
    const submissionBrief = makeBrief(submissionPlan, {
      briefId: submissionCommit.assignments[0]!.briefId,
      assignmentId: submissionCommit.assignments[0]!.assignmentId,
    });
    await submissionFixture.buildPlanStore.commitBriefVersions(
      PROJECT_ID,
      submissionCommit.plan,
      [submissionBrief],
    );
    const firstSubmission = submissionFor(
      submissionCommit.plan,
      submissionBrief,
    );
    await submissionFixture.buildPlanStore.commitSubmission(firstSubmission);
    const secondSubmission = submissionFor(
      submissionCommit.plan,
      submissionBrief,
      {
        submissionId:
          "submission_00000000-0000-7000-8000-000000000009" as BuilderPlanningSubmissionId,
        supersedesSubmissionId: firstSubmission.submissionId,
        submittedAt: "2026-09-03T09:11:00.000Z",
      },
    );
    await expect(
      submissionFixture.buildPlanStore.commitSubmission(secondSubmission),
    ).rejects.toMatchObject({
      code: "history_limit_exceeded",
      historyKind: "planning-submissions",
      limit: 1,
    });
  });

  it.each(["assignment transition", "submission provenance"] as const)(
    "detects %s tampering after restart",
    async (target) => {
      const { root, buildPlanStore } = await fixture();
      const plan = makePlan();
      const committed = await buildPlanStore.commitPlanVersion(
        plan,
        graph,
        request,
      );
      const brief = makeBrief(plan, {
        briefId: committed.assignments[0]!.briefId,
        assignmentId: committed.assignments[0]!.assignmentId,
      });
      await buildPlanStore.commitBriefVersions(PROJECT_ID, committed.plan, [
        brief,
      ]);
      await buildPlanStore.commitSubmission(
        submissionFor(committed.plan, brief),
      );
      const file = path.join(root, "projects", PROJECT_ID, "workspace.json");
      const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
        buildPlanning: {
          assignmentByAgentId: Record<
            string,
            { transitions: Array<{ at: string }> }
          >;
          submissionsByAssignmentId: Record<
            string,
            Array<{ sessionId: string }>
          >;
        };
      };
      if (target === "assignment transition")
        persisted.buildPlanning.assignmentByAgentId[
          AGENT_ID
        ]!.transitions[0]!.at = "2026-09-03T09:06:00.000Z";
      else
        persisted.buildPlanning.submissionsByAssignmentId[
          ASSIGNMENT_ID
        ]![0]!.sessionId = "tampered-session";
      await fs.writeFile(file, `${JSON.stringify(persisted)}\n`);

      await expect(
        new AgentMapWorkspaceStore(root).readAggregate(PROJECT_ID),
      ).rejects.toMatchObject({ code: "malformed_state" });
    },
  );

  it("does not publish IDs or versions when the atomic replace fails", async () => {
    let fail = false;
    const { root, workspaceStore, buildPlanStore } = await fixture({
      beforePersistStep: (step) => {
        if (fail && step === "rename") throw new Error("injected");
      },
    });
    await workspaceStore.readOrCreate(PROJECT_ID);
    fail = true;

    await expect(
      buildPlanStore.commitPlanVersion(makePlan(), graph, request),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(
      (await new AgentMapWorkspaceStore(root).readAggregate(PROJECT_ID))
        .buildPlanning.planVersions,
    ).toEqual([]);
  });

  it("selects one plan-version winner across independent store instances", async () => {
    const { root, buildPlanStore } = await fixture();
    const competing = new BuildPlanStore(new AgentMapWorkspaceStore(root));

    const outcomes = await Promise.allSettled([
      buildPlanStore.commitPlanVersion(makePlan(), graph, request),
      competing.commitPlanVersion(makePlan(), graph, {
        ...request,
        requestId: "request-competing",
        requestDigest: `sha256:${"d".repeat(64)}`,
      }),
    ]);

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect((await buildPlanStore.read(PROJECT_ID)).planVersions).toHaveLength(
      1,
    );
  });
});
