import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentBriefId,
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
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "build-plan-store-"));
    roots.push(root);
    const workspaceStore = new AgentMapWorkspaceStore(root, options);
    const buildPlanStore = new BuildPlanStore(workspaceStore, {
      allocator: {
        allocateBuildPlanId: () => makePlan().planId,
        allocateBriefId: () => BRIEF_ID as AgentBriefId,
        allocateAssignmentId: () => ASSIGNMENT_ID as PlanningAssignmentId,
      },
      now: () => new Date("2026-09-03T09:05:00.000Z"),
    });
    return { root, workspaceStore, buildPlanStore };
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
    await buildPlanStore.commitBriefVersions(PROJECT_ID, [brief]);
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
      submittedAt: "2026-09-03T09:10:00.000Z",
    } as unknown as BuilderPlanningSubmission;
    submission.semanticDigest =
      computePlanningSubmissionSemanticDigest(submission);
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

  it("rejects record corruption after restart", async () => {
    const { root, buildPlanStore } = await fixture();
    await buildPlanStore.commitPlanVersion(makePlan(), graph, request);
    const file = path.join(root, "projects", PROJECT_ID, "workspace.json");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {
      buildPlanning: { planVersions: Array<{ outcome: { summary: string } }> };
    };
    persisted.buildPlanning.planVersions[0]!.outcome.summary = "Tampered";
    await fs.writeFile(file, `${JSON.stringify(persisted)}\n`);

    await expect(
      new AgentMapWorkspaceStore(root).readAggregate(PROJECT_ID),
    ).rejects.toMatchObject({
      code: "malformed_state",
    });
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
