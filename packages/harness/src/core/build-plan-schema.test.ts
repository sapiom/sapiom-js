import { describe, expect, it } from "vitest";

import {
  parseAgentBriefRefreshRequest,
  parseBuildPlanApplyRequest,
  parseBuildPlanReadRequest,
  parseBuildPlanRebaseRequest,
} from "./build-plan-schema.js";

const map = {
  versionId: "mapv_018f0000-0000-7000-8000-000000000001",
  contentDigest: `sha256:${"1".repeat(64)}`,
};
const plan = {
  planId: "plan_018f0000-0000-7000-8000-000000000002",
  versionId: "planv_018f0000-0000-7000-8000-000000000003",
  semanticDigest: `sha256:${"2".repeat(64)}`,
};
const content = {
  outcome: "",
  nonGoals: [],
  milestones: [],
  sequenceGates: [],
  sharedConstraints: [],
  repositoryIntents: [],
  integrationCriteria: [],
  acceptanceCriteria: [],
  decisions: [],
  assignments: [],
  unresolvedDecisions: [],
  risks: [],
};

describe("build plan tool schemas", () => {
  it("accepts only explicit current or exact historical reads", () => {
    expect(parseBuildPlanReadRequest({ kind: "current" })).toEqual({ kind: "current" });
    expect(parseBuildPlanReadRequest({ kind: "exact", ...plan })).toEqual({ kind: "exact", ...plan });
    expect(() => parseBuildPlanReadRequest({})).toThrow();
    expect(() => parseBuildPlanReadRequest({ kind: "exact", planId: plan.planId })).toThrow();
  });

  it("keeps trusted project, user, session, role, and capability selectors out of apply", () => {
    const request = { schemaVersion: 1, requestId: "request", expectedMap: map, expectedPlan: null,
      operations: [{ op: "replace-content", content }] };
    expect(parseBuildPlanApplyRequest(request)).toEqual(request);
    for (const field of ["projectId", "userId", "sessionId", "role", "capability", "assignment"])
      expect(() => parseBuildPlanApplyRequest({ ...request, [field]: "forged" })).toThrow();
  });

  it("requires exact from/to map and plan references for explicit rebase", () => {
    const request = { schemaVersion: 1, requestId: "rebase", expectedPlan: plan,
      fromMap: map, toMap: { ...map, versionId: "mapv_018f0000-0000-7000-8000-000000000004" }, resolutions: [] };
    expect(parseBuildPlanRebaseRequest(request)).toEqual(request);
    expect(() => parseBuildPlanRebaseRequest({ ...request, fromMap: { versionId: map.versionId } })).toThrow();
    expect(() => parseBuildPlanRebaseRequest({ ...request, projectId: "project-forged" })).toThrow();
  });

  it("bounds content arrays and rejects unknown operation fields", () => {
    const request = { schemaVersion: 1, requestId: "request", expectedMap: map, expectedPlan: null,
      operations: [{ op: "replace-content", content: { ...content,
        nonGoals: Array.from({ length: 129 }, (_, index) => `non-goal-${index}`) } }] };
    expect(() => parseBuildPlanApplyRequest(request)).toThrow();
    expect(() => parseBuildPlanApplyRequest({ ...request,
      operations: [{ op: "replace-content", content, privatePath: "/secret" }] })).toThrow();
  });

  it("accepts exact canonical refresh and assignment-only nested focus", () => {
    const canonical = { schemaVersion: 1, requestId: "refresh", expectedMap: map, expectedPlan: plan,
      focus: { mode: "canonical" } };
    expect(parseAgentBriefRefreshRequest(canonical)).toEqual(canonical);
    const focused = { ...canonical, requestId: "focused", focus: { mode: "focused", selections: [{
      focusScope: { family: "ad-hoc-delegation", delegationKey: "review", parentScopeKey: null },
      assignmentId: "work_018f0000-0000-7000-8000-000000000004",
      mission: "Review the contract",
    }] } };
    expect(parseAgentBriefRefreshRequest(focused)).toEqual(focused);
  });
});
