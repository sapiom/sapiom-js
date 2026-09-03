import { describe, expect, it } from "vitest";

import type { AgentMapRevisionId } from "../shared/build-plan.js";
import { makeBrief, makePlan } from "./build-plan.test-support.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";

describe("build planning canonical digests", () => {
  it("matches the versioned golden digest vectors", () => {
    const plan = makePlan();
    const brief = makeBrief(plan);

    expect(plan.semanticDigest).toBe(
      "sha256:93e773caa817b2dd7127a347067f679eb67b2ee1930285ae535a4a0df8a84770",
    );
    expect(plan.recordDigest).toBe(
      "sha256:c1cebc5b437ab52c744b2fe058264510a26e11fe02c24d048c9e6ad52844325d",
    );
    expect(brief.semanticDigest).toBe(
      "sha256:b4e925bd84f82307fcaecf17c451f40ee87e85aa98fdfed78a7948fb42c6649b",
    );
    expect(brief.recordDigest).toBe(
      "sha256:850ca89585121d0281d78fc597c4c99c665cfa85b36e1d5cadb94b5d7a3f13d6",
    );
  });

  it("separates semantic identity from record/source metadata", () => {
    const proposal = makePlan();
    const rebound = makePlan({
      changeKind: "source-rebound",
      source: {
        kind: "revision",
        revisionId:
          "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId,
        revisionNumber: 1,
        graphDigest: proposal.source.graphDigest,
      },
      authoredBy: {
        userId: "user-2",
        sessionId: "session-2",
        role: "map-planner",
      },
      createdAt: "2026-09-03T10:00:00.000Z",
    });

    expect(computeBuildPlanSemanticDigest(rebound)).toBe(
      proposal.semanticDigest,
    );
    expect(computeBuildPlanRecordDigest(rebound)).not.toBe(
      proposal.recordDigest,
    );
  });

  it("changes semantic digests for meaning and preserves set ordering", () => {
    const plan = makePlan();
    const reordered = makePlan({
      assignments: [
        {
          ...plan.assignments[0]!,
          scope: { inScope: ["B", "A"], nonGoals: ["Y", "X"] },
        },
      ],
    });
    const sameReordered = makePlan({
      assignments: [
        {
          ...plan.assignments[0]!,
          scope: { inScope: ["A", "B"], nonGoals: ["X", "Y"] },
        },
      ],
    });
    const edited = makePlan({ outcome: { summary: "A different outcome" } });

    expect(reordered.semanticDigest).toBe(sameReordered.semanticDigest);
    expect(edited.semanticDigest).not.toBe(plan.semanticDigest);
  });

  it("keeps brief semantics stable across exact source-only rebinding", () => {
    const plan = makePlan();
    const brief = makeBrief(plan);
    const rebound = {
      ...brief,
      source: {
        kind: "revision" as const,
        revisionId:
          "revision_00000000-0000-7000-8000-000000000006" as AgentMapRevisionId,
        revisionNumber: 1,
        graphDigest: brief.source.graphDigest,
      },
      createdAt: "2026-09-03T10:00:00.000Z",
    };

    expect(computeAgentBriefSemanticDigest(rebound)).toBe(brief.semanticDigest);
    expect(computeAgentBriefRecordDigest(rebound)).not.toBe(brief.recordDigest);
  });
});
