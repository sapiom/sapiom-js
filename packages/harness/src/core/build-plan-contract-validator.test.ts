import { describe, expect, it } from "vitest";

import type { PlanDecisionId } from "../shared/build-plan.js";
import {
  AGENT_ID,
  graph,
  makeBrief,
  makePlan,
  PROJECT_ID,
} from "./build-plan.test-support.js";
import { BuildPlanContractValidator } from "./build-plan-contract-validator.js";

const validator = new BuildPlanContractValidator({
  resolve: async (_projectId, source) => ({
    projectId: PROJECT_ID,
    source,
    graph,
  }),
});

describe("BuildPlanContractValidator", () => {
  it("computes proposal planning eligibility without forging implementation readiness", async () => {
    const plan = makePlan();
    const result = await validator.validate(plan, [makeBrief(plan)]);

    expect(result).toEqual({
      completeness: { status: "complete", issues: [] },
      eligibility: {
        planningEligible: true,
        implementationEligible: false,
        reasons: ["source-not-confirmed"],
      },
    });
  });

  it("returns deterministic path-addressable missing and unresolved diagnostics", async () => {
    const plan = makePlan({
      assignments: [
        {
          ...makePlan().assignments[0]!,
          unresolvedDecisions: [
            {
              decisionId:
                "decision_00000000-0000-7000-8000-000000000007" as PlanDecisionId,
              question: "Which database?",
              required: true,
              status: "open",
              resolution: null,
            },
          ],
        },
      ],
    });
    const result = await validator.validate(plan, []);

    expect(result.completeness.status).toBe("incomplete");
    expect(
      result.completeness.issues.map(({ code, relatedIds }) => ({
        code,
        relatedIds,
      })),
    ).toEqual([
      {
        code: "unresolved-required-decision",
        relatedIds: ["decision_00000000-0000-7000-8000-000000000007"],
      },
      { code: "missing-brief", relatedIds: [AGENT_ID] },
    ]);
    expect(result.eligibility.planningEligible).toBe(false);
  });
});
