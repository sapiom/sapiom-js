import { describe, expect, it } from "vitest";

import {
  BUILD_PLAN_SCHEMA_VERSION,
  architectureSourceRefsEqual,
  type AgentBriefId,
  type AgentBriefRef,
  type AgentBriefSemanticDigest,
  type AgentBriefVersion,
  type AgentMapRevisionId,
  type ArchitectureSourceRef,
  type BuilderPlanningContextRef,
  type BuilderPlanningSubmission,
  type BuilderPlanningSubmissionId,
  type BuildPlanId,
  type BuildPlanRef,
  type BuildPlanSemanticDigest,
  type BuildPlanVersion,
  type GraphDigest,
  type ImplementationPlanStep,
  type MapProposalId,
  type PlanningAssignmentId,
  type PlanningAssignmentRef,
  type PlanningQuestion,
  type PlanningRisk,
  type PlanningSubmissionDigest,
  type PlanNodeId,
  type ProposalOperationId,
  type RecordDigest,
  type StudioProjectId,
} from "@sapiom/harness";

describe("@sapiom/harness build-planning entrypoint", () => {
  it("constructs and consumes the complete v1 handoff surface", () => {
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
    const context: BuilderPlanningContextRef = {
      projectId:
        "project_00000000-0000-4000-8000-000000000001" as StudioProjectId,
      source,
      plan,
      brief,
      assignment,
    };
    const implementationPlan: ImplementationPlanStep = {
      stepId: "step-1",
      ordinal: 1,
      description: "Implement the handoff",
      verification: "Run the public contract test",
    };
    const risk: PlanningRisk = {
      riskId: "risk-1",
      description: "A dependency changes",
      mitigation: "Revalidate the exact source",
    };
    const question: PlanningQuestion = {
      questionId: "question-1",
      question: "Is the source still current?",
    };
    const submission: BuilderPlanningSubmission = {
      schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
      submissionId:
        "submission_00000000-0000-7000-8000-000000000001" as BuilderPlanningSubmissionId,
      projectId: context.projectId,
      assignmentId: assignment.assignmentId,
      sessionId: "session-1",
      source,
      plan,
      brief,
      status: "ready",
      implementationPlan: [implementationPlan],
      risks: [risk],
      questions: [question],
      proposedMapOperationIds: [
        "operation_00000000-0000-7000-8000-000000000001" as ProposalOperationId,
      ],
      supersedesSubmissionId: null,
      semanticDigest: `sha256:${"d".repeat(64)}` as PlanningSubmissionDigest,
      recordDigest: `sha256:${"e".repeat(64)}` as RecordDigest,
      submittedAt: "2026-09-03T10:00:00.000Z",
    };

    expect(
      architectureSourceRefsEqual(source, {
        graphDigest,
        version: 1,
        proposalId: source.proposalId,
        kind: "proposal",
      }),
    ).toBe(true);
    expect(architectureSourceRefsEqual(source, revisionSource)).toBe(false);
    expect(submission).toMatchObject({
      projectId: context.projectId,
      assignmentId: assignment.assignmentId,
      plan,
      brief,
    });
  });
});
