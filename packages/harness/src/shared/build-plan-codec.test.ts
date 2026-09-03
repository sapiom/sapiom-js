import { describe, expect, it } from "vitest";

import {
  makeBrief,
  makePlan,
  PROJECT_ID,
} from "../core/build-plan.test-support.js";
import { emptyBuildPlanningAggregate } from "./build-plan.js";
import {
  parseAgentBriefVersionRecord,
  parseArchitectureSourceRef,
  parseBuildPlanningAggregate,
  parseProjectBuildPlanVersion,
} from "./build-plan-codec.js";

describe("build planning strict codecs", () => {
  it("round trips exact plan and brief records", () => {
    const plan = makePlan();
    expect(parseProjectBuildPlanVersion(plan)).toEqual(plan);
    expect(parseAgentBriefVersionRecord(makeBrief(plan))).toEqual(
      makeBrief(plan),
    );
  });

  it("rejects unknown fields, bad discriminants, versions, and duplicates", () => {
    const plan = makePlan();
    expect(() =>
      parseProjectBuildPlanVersion({ ...plan, forgedReady: true }),
    ).toThrow();
    expect(() =>
      parseArchitectureSourceRef({ ...plan.source, kind: "latest" }),
    ).toThrow();
    expect(() =>
      parseArchitectureSourceRef({ ...plan.source, version: 0 }),
    ).toThrow();
    expect(() =>
      parseProjectBuildPlanVersion({
        ...plan,
        assignments: [plan.assignments[0], plan.assignments[0]],
      }),
    ).toThrow();
  });

  it("rejects dangling current pointers instead of repairing them", () => {
    expect(() =>
      parseBuildPlanningAggregate(
        { ...emptyBuildPlanningAggregate(), currentPlanVersion: 1 },
        PROJECT_ID,
      ),
    ).toThrow("invalid build planning aggregate");
  });
});
