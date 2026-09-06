import { describe, expect, it } from "vitest";

import {
  BUILD_PLAN_SCHEMA_VERSION,
  PROJECT_PLANNING_STORAGE_SCHEMA_VERSION,
  FOCUSED_SESSION_CONTEXT_MAX_BYTES,
  agentMapVersionRefsEqual,
  computeAgentBriefId,
  computeAgentBriefScopeKey,
  emptyProjectBuildPlanContent,
  type AgentBriefFocusScope,
  type AgentBriefHistoryPointer,
  type AgentBriefScopeKey,
  type AgentMapVersionRef,
  type BuildPlanDependencyIntent,
  type BuildPlanReadSelector,
  type GraphContentDigest,
  type PlanNodeId,
  type ProjectAgentActorRef,
  type ProjectBuildPlanVersionRef,
  type StudioProjectId,
} from "./index.js";

describe("@sapiom/harness neutral planning entrypoint", () => {
  it("exports exact map/plan refs and neutral reserved brief scopes", () => {
    const projectId = "project_00000000-0000-4000-8000-000000000001" as StudioProjectId;
    const contentDigest = `sha256:${"a".repeat(64)}` as GraphContentDigest;
    const map: AgentMapVersionRef = {
      projectId,
      versionId: "mapv_00000000-0000-7000-8000-000000000001" as AgentMapVersionRef["versionId"],
      contentDigest,
    };
    const plan: ProjectBuildPlanVersionRef = {
      projectId,
      planId: "plan_00000000-0000-7000-8000-000000000001" as ProjectBuildPlanVersionRef["planId"],
      versionId: "planv_00000000-0000-7000-8000-000000000001" as ProjectBuildPlanVersionRef["versionId"],
      semanticDigest: `sha256:${"b".repeat(64)}` as ProjectBuildPlanVersionRef["semanticDigest"],
    };
    const parentScopeKey = "scope-parent" as AgentBriefScopeKey;
    const focusScope: AgentBriefFocusScope = {
      family: "ad-hoc-delegation",
      delegationKey: "nested-review",
      parentScopeKey,
    };
    const brief: AgentBriefHistoryPointer = {
      scopeKey: "scope-child" as AgentBriefScopeKey,
      focusScope,
      briefId: "brief_00000000-0000-7000-8000-000000000001" as AgentBriefHistoryPointer["briefId"],
      status: "retired",
      version: {
        projectId,
        briefId: "brief_00000000-0000-7000-8000-000000000001" as AgentBriefHistoryPointer["briefId"],
        versionId: "briefv_00000000-0000-7000-8000-000000000001" as AgentBriefHistoryPointer["version"]["versionId"],
        semanticDigest: `sha256:${"c".repeat(64)}` as AgentBriefHistoryPointer["version"]["semanticDigest"],
      },
    };
    const dependency: BuildPlanDependencyIntent = {
      id: "dependency_00000000-0000-7000-8000-000000000001" as BuildPlanDependencyIntent["id"],
      kind: "shared-resource",
      nodeId: "node_00000000-0000-7000-8000-000000000001" as PlanNodeId,
      relationshipIds: [],
      contractRef: null,
    };
    const selector: BuildPlanReadSelector = { kind: "exact", ...plan };
    const actor: ProjectAgentActorRef = { userId: "user", sessionId: "session" };

    expect(BUILD_PLAN_SCHEMA_VERSION).toBe(1);
    expect(PROJECT_PLANNING_STORAGE_SCHEMA_VERSION).toBe(2);
    expect(FOCUSED_SESSION_CONTEXT_MAX_BYTES).toBe(128_000);
    expect(computeAgentBriefId(projectId, focusScope)).toMatch(/^brief_/u);
    expect(computeAgentBriefScopeKey(projectId, focusScope)).toMatch(/^sha256:/u);
    expect(agentMapVersionRefsEqual(map, { ...map })).toBe(true);
    expect(emptyProjectBuildPlanContent().assignments).toEqual([]);
    expect({ brief, dependency, selector, actor }).toMatchObject({
      brief: { status: "retired", focusScope: { parentScopeKey } },
      dependency: { kind: "shared-resource" },
      selector: { kind: "exact", planId: plan.planId },
      actor: { userId: "user", sessionId: "session" },
    });
  });
});
