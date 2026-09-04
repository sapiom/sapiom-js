import { describe, expect, it } from "vitest";

import type {
  AgentBriefScopeKey,
  AgentBriefSemanticDigest,
  AgentBriefId,
  AgentBriefVersion,
  AgentBriefVersionId,
  PlanningAssignmentId,
  ProjectBuildPlanContent,
  ProjectBuildPlanId,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionId,
} from "./build-plan.js";
import type {
  AgentMapVersionId,
  PlanNodeId,
} from "./agent-map.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "../core/build-plan-canonicalization.js";
import { computeGraphContentDigest } from "./agent-map-canonical.js";
import {
  parseAgentBriefFocusScope,
  parseAgentBriefVersion,
  parseProjectBuildPlanContent,
  parseProjectBuildPlanVersion,
} from "./build-plan-codec.js";

const projectId = "project_018f0000-0000-7000-8000-000000000001";
const nodeId = "node_018f0000-0000-7000-8000-000000000010" as PlanNodeId;
const mapVersionId = "mapv_018f0000-0000-7000-8000-000000000020" as AgentMapVersionId;
const planId = "plan_018f0000-0000-7000-8000-000000000030" as ProjectBuildPlanId;
const planVersionId = "planv_018f0000-0000-7000-8000-000000000031" as ProjectBuildPlanVersionId;
const assignmentId = "work_018f0000-0000-7000-8000-000000000040" as PlanningAssignmentId;
const actor = { userId: "user-golden", sessionId: "session-golden" };
const createdAt = "2026-01-02T03:04:05.000Z";
const origin = { kind: "request" as const, requestDigest: `sha256:${"1".repeat(64)}`, operationIds: [], touchKeys: [] };
const graphDigest = computeGraphContentDigest({
  nodes: [{ id: nodeId, kind: "agent", name: "Research", purpose: "Research", ownerAgentId: null, contractRefs: [] }],
  relationships: [],
});
const content: ProjectBuildPlanContent = {
  outcome: "Ship research.", nonGoals: [], milestones: [], sequenceGates: [], sharedConstraints: [],
  repositoryIntents: [], integrationCriteria: [], acceptanceCriteria: [], decisions: [],
  assignments: [{ id: assignmentId, plannedAgentId: nodeId, briefId: null, mission: "Research", scope: [], nonGoals: [], dependencies: [] }],
  unresolvedDecisions: [], risks: [],
};

const planRecord = (): ProjectBuildPlanVersion => {
  const base = {
    schemaVersion: 1 as const, projectId, planId, versionId: planVersionId, version: 1,
    parentVersionId: null, changeKind: "created" as const, restoredFromVersionId: null,
    map: { projectId, versionId: mapVersionId, contentDigest: graphDigest }, content,
    semanticDigest: computeBuildPlanSemanticDigest(content), authoredBy: actor, createdAt, origin,
  };
  return { ...base, recordDigest: computeBuildPlanRecordDigest(base) };
};

describe("neutral build plan codecs", () => {
  it("strictly parses an integrity-covered plan and returns a defensive copy", () => {
    const input = planRecord();
    const parsed = parseProjectBuildPlanVersion(input, projectId);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(() => parseProjectBuildPlanVersion({ ...input, role: "map-planner" }, projectId)).toThrow(/invalid/u);
    expect(() => parseProjectBuildPlanVersion(input, "project_foreign")).toThrow(/cross-project/u);
  });

  it("rejects unknown fields, invalid IDs, and semantic tampering", () => {
    expect(() => parseProjectBuildPlanContent({ ...content, graph: {} })).toThrow(/invalid/u);
    expect(() => parseProjectBuildPlanVersion({ ...planRecord(), semanticDigest: `sha256:${"0".repeat(64)}` }, projectId)).toThrow(/digest/u);
    expect(() => parseProjectBuildPlanContent({ ...content, assignments: [{ ...content.assignments[0], id: "work_bad" }] })).toThrow(/assignment/u);
  });

  it("reserves canonical and nested ad-hoc brief focus scopes", () => {
    expect(parseAgentBriefFocusScope({ family: "canonical-workstream", plannedAgentId: nodeId })).toEqual({ family: "canonical-workstream", plannedAgentId: nodeId });
    expect(parseAgentBriefFocusScope({ family: "ad-hoc-delegation", delegationKey: "analysis", parentScopeKey: "scope_parent" })).toEqual({ family: "ad-hoc-delegation", delegationKey: "analysis", parentScopeKey: "scope_parent" });
    expect(() => parseAgentBriefFocusScope({ family: "builder", plannedAgentId: nodeId })).toThrow(/scope/u);
  });

  it("parses exact-source brief versions without role-bearing actors", () => {
    const plan = planRecord();
    const base = {
      schemaVersion: 1 as const, projectId,
      briefId: "brief_018f0000-0000-7000-8000-000000000050" as AgentBriefId,
      scopeKey: "scope_research" as AgentBriefScopeKey,
      focusScope: { family: "canonical-workstream" as const, plannedAgentId: nodeId },
      versionId: "briefv_018f0000-0000-7000-8000-000000000051" as AgentBriefVersionId,
      version: 1, parentVersionId: null, changeKind: "created" as const, restoredFromVersionId: null,
      assignmentId, plannedAgentId: nodeId, map: plan.map,
      plan: { projectId, planId, versionId: planVersionId, semanticDigest: plan.semanticDigest },
      content: { mission: "Research", scope: [], nonGoals: [], ownedNodeIds: [nodeId], relevantNodeIds: [], inputs: [], outputs: [], dependencies: [], sharedResourceNodeIds: [], sequenceGateIds: [], deliverables: [], acceptanceCriteria: [], constraints: [], milestoneIds: [], unresolvedDecisionIds: [] },
      compilerVersion: "1", compilerInputFingerprint: `sha256:${"3".repeat(64)}`,
      semanticDigest: "" as AgentBriefSemanticDigest, authoredBy: actor, createdAt, origin,
    };
    const withSemantic = { ...base, semanticDigest: computeAgentBriefSemanticDigest(base) };
    const brief = { ...withSemantic, recordDigest: computeAgentBriefRecordDigest(withSemantic) } as AgentBriefVersion;
    expect(parseAgentBriefVersion(brief, projectId)).toEqual(brief);
    const roleActor = { ...brief, authoredBy: { ...actor, role: "agent-builder" } };
    expect(() => parseAgentBriefVersion(roleActor, projectId)).toThrow(/actor/u);
  });
});
