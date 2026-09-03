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
        operations: Array.from(
          { length: BUILD_PLAN_MAX_OPERATIONS + 1 },
          () => ({ op: "set-project-outcome", outcome: { summary: "x" } }),
        ),
      }).success,
    ).toBe(false);
  });
});
