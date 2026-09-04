import { describe, expect, it } from "vitest";

import type {
  AgentMapGraph,
  AgentMapVersion,
  AgentMapVersionId,
  PlanNodeId,
  ProjectMutationOrigin,
} from "../shared/agent-map.js";
import {
  canonicalJson,
  computeAgentMapVersionRecordDigest,
  computeGraphContentDigest,
} from "../shared/agent-map-canonical.js";
import type {
  AgentBriefId,
  AgentBriefSemanticDigest,
  AgentBriefScopeKey,
  AgentBriefVersion,
  AgentBriefVersionId,
  PlanningAssignmentId,
  ProjectBuildPlanContent,
  ProjectBuildPlanId,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionId,
} from "../shared/build-plan.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";

const projectId = "project_018f0000-0000-7000-8000-000000000001";
const nodeId = "node_018f0000-0000-7000-8000-000000000010" as PlanNodeId;
const mapVersionId = "mapv_018f0000-0000-7000-8000-000000000020" as AgentMapVersionId;
const planId = "plan_018f0000-0000-7000-8000-000000000030" as ProjectBuildPlanId;
const planVersionId = "planv_018f0000-0000-7000-8000-000000000031" as ProjectBuildPlanVersionId;
const assignmentId = "work_018f0000-0000-7000-8000-000000000040" as PlanningAssignmentId;
const briefId = "brief_018f0000-0000-7000-8000-000000000050" as AgentBriefId;
const briefVersionId = "briefv_018f0000-0000-7000-8000-000000000051" as AgentBriefVersionId;
const actor = { userId: "user-golden", sessionId: "session-golden" };
const createdAt = "2026-01-02T03:04:05.000Z";
const graph: AgentMapGraph = {
  nodes: [{
    id: nodeId,
    kind: "agent",
    name: "Market Research",
    purpose: "Find the top ten stocks trading today.",
    ownerAgentId: null,
    contractRefs: [],
  }],
  relationships: [],
};
const planContent: ProjectBuildPlanContent = {
  outcome: "Deliver a daily top-ten-stock research report.",
  nonGoals: ["Publish the report to TikTok."],
  milestones: [],
  sequenceGates: [],
  sharedConstraints: ["Use only market data available for the trading day."],
  repositoryIntents: [],
  integrationCriteria: ["ResearchReport is persisted before downstream consumption."],
  acceptanceCriteria: ["Exactly ten ranked stocks are present."],
  decisions: [],
  assignments: [{
    id: assignmentId,
    plannedAgentId: nodeId,
    briefId,
    mission: "Produce ResearchReport.",
    scope: ["Market research"],
    nonGoals: ["Video publishing"],
    dependencies: [],
  }],
  unresolvedDecisions: [],
  risks: [],
};
const requestOrigin = (character: string): ProjectMutationOrigin => ({
  kind: "request",
  requestDigest: `sha256:${character.repeat(64)}`,
  operationIds: [],
  touchKeys: [],
});

describe("neutral map/plan digest protocol", () => {
  it("pins project-neutral semantic golden vectors", () => {
    const mapDigest = computeGraphContentDigest(graph);
    expect(mapDigest).toBe("sha256:1659273be855864c82005f6291ae61bc2256f1d114e7c391aedd4f37d0191000");
    expect(computeBuildPlanSemanticDigest(planContent)).toBe(
      "sha256:0a038f176b4ae7e0a9bd43c50a5e64caf29e0381dee5d9470bf319d7098af7eb",
    );

    const brief = {
      assignmentId,
      plannedAgentId: nodeId,
      map: { projectId, versionId: mapVersionId, contentDigest: mapDigest },
      plan: {
        projectId,
        planId,
        versionId: planVersionId,
        semanticDigest: computeBuildPlanSemanticDigest(planContent),
      },
      content: {
        mission: "Produce ResearchReport.",
        scope: ["Market research"],
        nonGoals: ["Video publishing"],
        ownedNodeIds: [nodeId],
        relevantNodeIds: [],
        inputs: [],
        outputs: ["ResearchReport"],
        dependencies: [],
        sharedResourceNodeIds: [],
        sequenceGateIds: [],
        deliverables: ["ResearchReport"],
        acceptanceCriteria: ["Exactly ten ranked stocks are present."],
        constraints: ["Use only market data available for the trading day."],
        milestoneIds: [],
        unresolvedDecisionIds: [],
      },
    } satisfies Pick<AgentBriefVersion, "assignmentId" | "plannedAgentId" | "map" | "plan" | "content">;
    expect(computeAgentBriefSemanticDigest(brief)).toBe(
      "sha256:e1b304271db17e8b8164e193a6ae41d82c0864ff593c02c3e3169de205c26b0a",
    );
  });

  it("separates semantic content from exact source and provenance", () => {
    const contentDigest = computeGraphContentDigest(graph);
    const map = {
      schemaVersion: 1,
      projectId,
      versionId: mapVersionId,
      version: 1,
      parentVersionId: null,
      changeKind: "created",
      restoredFromVersionId: null,
      graph,
      contentDigest,
      authoredBy: actor,
      createdAt,
      origin: requestOrigin("1"),
    } satisfies Omit<AgentMapVersion, "recordDigest">;
    const plan = {
      schemaVersion: 1,
      projectId,
      planId,
      versionId: planVersionId,
      version: 1,
      parentVersionId: null,
      changeKind: "created",
      restoredFromVersionId: null,
      map: { projectId, versionId: mapVersionId, contentDigest },
      content: planContent,
      semanticDigest: computeBuildPlanSemanticDigest(planContent),
      authoredBy: actor,
      createdAt,
      origin: requestOrigin("2"),
    } satisfies Omit<ProjectBuildPlanVersion, "recordDigest">;
    expect(computeAgentMapVersionRecordDigest(map)).not.toBe(contentDigest);
    expect(computeBuildPlanRecordDigest(plan)).not.toBe(plan.semanticDigest);
    expect(computeAgentMapVersionRecordDigest(map)).toBe(
      "sha256:fe263ae9ba6982d03931743ac2737a60cf28288caba2ce141916cbea18813cdd",
    );
    expect(computeBuildPlanRecordDigest(plan)).toBe(
      "sha256:9046540f87c7d07625fb96f6b77853b2cd0ec907c7296b836590757b8af7ba61",
    );

    const briefBase = {
      schemaVersion: 1,
      projectId,
      briefId,
      scopeKey: "scope_golden" as AgentBriefScopeKey,
      focusScope: { family: "canonical-workstream", plannedAgentId: nodeId },
      versionId: briefVersionId,
      version: 1,
      parentVersionId: null,
      changeKind: "created",
      restoredFromVersionId: null,
      assignmentId,
      plannedAgentId: nodeId,
      map: plan.map,
      plan: { projectId, planId, versionId: planVersionId, semanticDigest: plan.semanticDigest },
      content: {
        mission: "Produce ResearchReport.", scope: ["Market research"], nonGoals: ["Video publishing"],
        ownedNodeIds: [nodeId], relevantNodeIds: [], inputs: [], outputs: ["ResearchReport"],
        dependencies: [], sharedResourceNodeIds: [], sequenceGateIds: [], deliverables: ["ResearchReport"],
        acceptanceCriteria: ["Exactly ten ranked stocks are present."],
        constraints: ["Use only market data available for the trading day."], milestoneIds: [],
        unresolvedDecisionIds: [],
      },
      compilerVersion: "1",
      compilerInputFingerprint: `sha256:${"3".repeat(64)}`,
      semanticDigest: "" as AgentBriefSemanticDigest,
      authoredBy: actor,
      createdAt,
      origin: requestOrigin("2"),
    } satisfies Omit<AgentBriefVersion, "recordDigest">;
    const brief = {
      ...briefBase,
      semanticDigest: computeAgentBriefSemanticDigest(briefBase),
    };
    expect(computeAgentBriefRecordDigest(brief)).toBe(
      "sha256:49f7f41ab2483d9ac7c4ffa1a9929a069afc4b8abe72b404b3f1b4f3a5121f0f",
    );
    expect(computeBuildPlanSemanticDigest({ ...planContent, nonGoals: [...planContent.nonGoals] })).toBe(plan.semanticDigest);
    expect(computeBuildPlanSemanticDigest({ content: plan.content })).toBe(plan.semanticDigest);
    expect(computeBuildPlanRecordDigest({ ...plan, authoredBy: { ...actor, sessionId: "another-session" } })).not.toBe(computeBuildPlanRecordDigest(plan));
  });

  it("normalizes line endings, orders keys bytewise, and rejects undefined", () => {
    expect(canonicalJson({ z: "a\r\nb\rc", A: null })).toBe('{"A":null,"z":"a\\nb\\nc"}');
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/u);
  });

  it("sorts semantic set fields without mutating caller data", () => {
    const input = structuredClone(planContent);
    const shuffled = { ...input, nonGoals: ["z", "a"] };
    const before = JSON.stringify(shuffled);
    const digest = computeBuildPlanSemanticDigest(shuffled);
    expect(digest).toBe(computeBuildPlanSemanticDigest({ ...shuffled, nonGoals: ["a", "z"] }));
    expect(JSON.stringify(shuffled)).toBe(before);
  });
});
