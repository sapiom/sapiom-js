import { describe, expect, it } from "vitest";

import {
  AGENT_ID,
  PLAN_ID,
  proposalSource,
} from "./build-plan.test-support.js";
import {
  BUILD_PLAN_MAX_OPERATIONS,
  buildPlanApplyRequestSchema,
  buildPlanReadInputSchema,
  buildPlanRebaseRequestSchema,
  buildPlanValidateRequestSchema,
} from "./build-plan-schema.js";

const assignment = {
  plannedAgentId: AGENT_ID,
  mission: "Build the bounded feature",
  scope: { inScope: ["Authoring"], nonGoals: ["Deployment"] },
  deliverables: [],
  constraints: [],
  acceptanceCriteria: [],
  milestoneIds: [],
  unresolvedDecisions: [],
};

describe("build plan tool schemas", () => {
  it("accepts the strict versioned creation contract", () => {
    expect(
      buildPlanApplyRequestSchema.parse({
        schemaVersion: 1,
        planId: null,
        expectedPlanVersion: null,
        expectedSource: proposalSource(),
        requestId: "request-1",
        operations: [
          { op: "set-project-outcome", outcome: { summary: "Ship it" } },
          { op: "upsert-agent-assignment", assignment },
        ],
      }),
    ).toMatchObject({ schemaVersion: 1, planId: null });
  });

  it.each([
    { schemaVersion: 1, surprise: true },
    { schemaVersion: 1, plan: { planId: PLAN_ID, version: 1, extra: true } },
  ])("rejects unknown read keys", (input) => {
    expect(buildPlanReadInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown operations, duplicate IDs, malformed sources, and oversized batches", () => {
    const base = {
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
    };
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        operations: [{ op: "write-files" }],
      }).success,
    ).toBe(false);
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        projectId: "model-controlled-project",
        role: "map-planner",
        operations: [{ op: "upsert-agent-assignment", assignment }],
      }).success,
    ).toBe(false);
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        operations: [
          {
            op: "set-shared-constraints",
            constraints: [
              { constraintId: "same", description: "One", required: true },
              { constraintId: "same", description: "Two", required: false },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        expectedSource: { ...proposalSource(), graphDigest: "latest" },
        operations: [{ op: "upsert-agent-assignment", assignment }],
      }).success,
    ).toBe(false);
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        operations: null,
      }).success,
    ).toBe(false);
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        operations: { op: "set-project-outcome" },
      }).success,
    ).toBe(false);
    expect(
      buildPlanValidateRequestSchema.safeParse({
        ...base,
        operations: Array.from(
          { length: BUILD_PLAN_MAX_OPERATIONS + 1 },
          () => ({ op: "set-project-outcome", outcome: { summary: "x" } }),
        ),
      }).success,
    ).toBe(false);
    expect(
      buildPlanRebaseRequestSchema.safeParse({
        schemaVersion: 1,
        planId: PLAN_ID,
        expectedPlanVersion: 1,
        fromSource: proposalSource(),
        toSource: proposalSource(),
        requestId: "request-malformed-resolutions",
        resolutions: null,
      }).success,
    ).toBe(false);
  });

  it("accepts strict repository-intent remove and remap rebase resolutions", () => {
    const base = {
      schemaVersion: 1 as const,
      planId: PLAN_ID,
      expectedPlanVersion: 1,
      fromSource: proposalSource(),
      toSource: proposalSource(),
      requestId: "request-rebase",
    };
    expect(
      buildPlanRebaseRequestSchema.parse({
        ...base,
        resolutions: [
          {
            kind: "remap-repository-intent",
            repositoryIntentId: "repository-primary",
            toPlannedAgentId: AGENT_ID,
          },
          {
            kind: "remove-repository-intent",
            repositoryIntentId: "repository-retired",
          },
          {
            kind: "remap-artifact-reference",
            plannedAgentId: AGENT_ID,
            deliverableId: "deliverable_00000000-0000-7000-8000-000000000011",
            fromNodeId: AGENT_ID,
            toNodeId: AGENT_ID,
          },
          {
            kind: "remove-artifact-reference",
            plannedAgentId: AGENT_ID,
            deliverableId: "deliverable_00000000-0000-7000-8000-000000000012",
            nodeId: AGENT_ID,
          },
        ],
      }).resolutions,
    ).toHaveLength(4);
  });

  it("accepts client-correlated creates without canonical authored IDs", () => {
    const parsed = buildPlanValidateRequestSchema.parse({
      schemaVersion: 1,
      planId: null,
      expectedPlanVersion: null,
      expectedSource: proposalSource(),
      operations: [
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
            mission: "Ship the plan",
            scope: { inScope: ["Core"], nonGoals: ["Deploy"] },
            deliverables: [
              {
                clientRef: "deliverable-alpha",
                description: "Complete the artifact",
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
    expect(JSON.stringify(parsed)).not.toContain("milestone_0000");
  });
});
