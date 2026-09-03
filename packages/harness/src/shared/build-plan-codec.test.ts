import { describe, expect, it } from "vitest";

import {
  makeBrief,
  makeLegacyBrief,
  makePlan,
  PROJECT_ID,
} from "../core/build-plan.test-support.js";
import { emptyBuildPlanningAggregate } from "./build-plan.js";
import {
  parseAgentBriefVersionRecord,
  parseArchitectureSourceRef,
  parseBuildPlanningAggregate,
  parsePersistedAgentBriefVersionRecord,
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

  it("accepts immutable v1 briefs only through the persisted compatibility parser", () => {
    const legacy = makeLegacyBrief(makePlan());
    expect(parsePersistedAgentBriefVersionRecord(legacy)).toEqual(legacy);
    expect([legacy.semanticDigest, legacy.recordDigest]).toEqual([
      "sha256:b017596fdf7600bd1a5d3637399776dca020c0da3bd1d4a59036a09179a38994",
      "sha256:88b84faaaa32d12064e4124dc913fed0fcb83b0fcbb2298a6b8d5c72e2ff4ef3",
    ]);
    expect(() => parseAgentBriefVersionRecord(legacy)).toThrow();
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

  it("rejects multi-milestone dependency cycles with stable paths", () => {
    const first = "milestone_00000000-0000-7000-8000-000000000011" as never;
    const second = "milestone_00000000-0000-7000-8000-000000000012" as never;
    const plan = makePlan({
      milestones: [
        {
          milestoneId: first,
          ordinal: 1,
          title: "First",
          outcome: "First is ready",
          dependsOn: [second],
        },
        {
          milestoneId: second,
          ordinal: 2,
          title: "Second",
          outcome: "Second is ready",
          dependsOn: [first],
        },
      ],
    });

    expect(() => parseProjectBuildPlanVersion(plan)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["milestones", 0, "dependsOn"],
            message: "milestone dependencies must be acyclic",
          }),
          expect.objectContaining({
            path: ["milestones", 1, "dependsOn"],
            message: "milestone dependencies must be acyclic",
          }),
        ]),
      }),
    );
  });

  it("rejects dangling current pointers instead of repairing them", () => {
    expect(() =>
      parseBuildPlanningAggregate(
        { ...emptyBuildPlanningAggregate(), currentPlanVersion: 1 },
        PROJECT_ID,
      ),
    ).toThrow("invalid build planning aggregate");
  });

  it("migrates pre-consent local aggregates with an empty consent history", () => {
    const legacy = {
      ...emptyBuildPlanningAggregate(),
    } as Record<string, unknown>;
    delete legacy.fanoutConsents;

    expect(parseBuildPlanningAggregate(legacy, PROJECT_ID)).toMatchObject({
      fanoutConsents: [],
    });
  });

  it("drops prerelease consents that have no user-turn evidence", () => {
    const legacy = {
      ...emptyBuildPlanningAggregate(),
      fanoutConsents: [
        {
          consentId: "fanout-consent_00000000-0000-7000-8000-000000000001",
          preparedFromUserInputId: "planner-input-before-preparation",
          confirmedByUserInputId: "planner-input-after-preparation",
          status: "confirmed",
        },
      ],
    };

    expect(parseBuildPlanningAggregate(legacy, PROJECT_ID)).toMatchObject({
      fanoutConsents: [],
    });
  });
});
