import { describe, expect, it } from "vitest";

import {
  AGENT_BRIEF_DIGEST_VERSION,
  AGENT_BRIEF_SCHEMA_VERSION,
  BUILD_PLAN_SCHEMA_VERSION,
  AgentBriefCompilationError,
  BuilderBootstrapLimitError,
  architectureSourceRefsEqual,
  compileAgentBriefs,
  type AgentMapGraph,
  type AgentBriefId,
  type AgentBriefRef,
  type AgentBriefSemanticDigest,
  type AgentBriefVersion,
  type AgentMapRevisionId,
  type ArchitectureSourceRef,
  type BuildPlanId,
  type BuildPlanDiagnostic,
  type BuildPlanRef,
  type BuildPlanSemanticDigest,
  type BuildPlanVersion,
  type CompileAgentBriefsRequest,
  type CompileAgentBriefsResult,
  type GraphDigest,
  type MapProposalId,
  type PlanningAssignmentId,
  type PlanningAssignmentRef,
  type PlanNodeId,
  type ProjectBuildPlanVersion,
  type RecordDigest,
  type StudioProjectId,
} from "@sapiom/harness";

describe("@sapiom/harness build-planning entrypoint", () => {
  it("constructs and consumes the complete planning and compiler surface", () => {
    const graphDigest = `sha256:${"a".repeat(64)}` as GraphDigest;
    const source: ArchitectureSourceRef = {
      kind: "proposal",
      proposalId:
        "proposal_00000000-0000-7000-8000-000000000001" as MapProposalId,
      version: 1,
      graphDigest,
    };
    const revisionSource: ArchitectureSourceRef = {
      kind: "revision",
      revisionId:
        "revision_00000000-0000-7000-8000-000000000001" as AgentMapRevisionId,
      revisionNumber: 1,
      graphDigest,
    };
    const plan: BuildPlanRef = {
      planId: "build-plan_00000000-0000-7000-8000-000000000001" as BuildPlanId,
      version: 1 as BuildPlanVersion,
      semanticDigest: `sha256:${"b".repeat(64)}` as BuildPlanSemanticDigest,
    };
    const brief: AgentBriefRef = {
      briefId: "brief_00000000-0000-7000-8000-000000000001" as AgentBriefId,
      version: 1 as AgentBriefVersion,
      semanticDigest: `sha256:${"c".repeat(64)}` as AgentBriefSemanticDigest,
    };
    const assignment: PlanningAssignmentRef = {
      assignmentId:
        "assignment_00000000-0000-7000-8000-000000000001" as PlanningAssignmentId,
      briefId: brief.briefId,
      plannedAgentId: "node_00000000-0000-7000-8000-000000000001" as PlanNodeId,
    };
    const projectId =
      "project_00000000-0000-4000-8000-000000000001" as StudioProjectId;

    expect(
      architectureSourceRefsEqual(source, {
        graphDigest,
        version: 1,
        proposalId: source.proposalId,
        kind: "proposal",
      }),
    ).toBe(true);
    expect(architectureSourceRefsEqual(source, revisionSource)).toBe(false);
    expect(assignment.briefId).toBe(brief.briefId);

    const graph: AgentMapGraph = { nodes: [], relationships: [] };
    const projectPlan: ProjectBuildPlanVersion = {
      schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
      projectId,
      planId: plan.planId,
      version: plan.version,
      parentVersion: null,
      changeKind: "created",
      source,
      outcome: { summary: "Compile through the package root" },
      milestones: [],
      sharedConstraints: [],
      repositoryIntents: [],
      integrationCriteria: [],
      assignments: [],
      unresolvedDecisions: [],
      semanticDigest: plan.semanticDigest,
      recordDigest: `sha256:${"f".repeat(64)}` as RecordDigest,
      authoredBy: {
        userId: "planner-1",
        sessionId: "session-1",
        role: "map-planner",
      },
      createdAt: "2026-09-03T10:00:00.000Z",
    };
    const compileRequest: CompileAgentBriefsRequest = {
      projectId,
      source,
      graph,
      plan: projectPlan,
    };
    const compileFromPackageRoot = (
      request: CompileAgentBriefsRequest,
    ): CompileAgentBriefsResult => compileAgentBriefs(request);
    const compilation = compileFromPackageRoot(compileRequest);
    const diagnostic: BuildPlanDiagnostic | undefined =
      compilation.diagnostics[0];
    expect(AGENT_BRIEF_SCHEMA_VERSION).toBe(2);
    expect(AGENT_BRIEF_DIGEST_VERSION).toBe(2);
    expect(diagnostic?.path).toBeDefined();
    expect(new AgentBriefCompilationError([]).diagnostics).toEqual([]);
    expect(new BuilderBootstrapLimitError("assignment.mission").path).toBe(
      "assignment.mission",
    );
  });
});
